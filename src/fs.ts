/**
 * Windows Docker Service Provider for the `ctx.fs` capability seam. Backed by
 * the host filesystem through the container's bind mounts: a mounted container
 * path is mapped to its host spelling (same bytes), so `read`/`write`/`edit`
 * operate on the real source files with zero install inside the container,
 * while every model/UI-facing path is the container path (`C:\workspace\...`).
 *
 * Container-only directories (not themselves a bind mount, e.g. the workspace
 * root `C:\workspace`) resolve to a synthetic target so they can be LISTED via
 * `docker exec`; they are not readable/writable (only mounted paths are).
 *
 * Reuses `LocalFileSystem`'s mechanics unchanged — realpath identity, atomic
 * writes, per-target locks, version guards — for mounted paths, because those
 * operate on the host path Node can open directly. Unlike the WSL backend there
 * is no need to replace the atomic-publication internals: the bind-mounted
 * sources live on NTFS, which has hard links and Win32 security semantics.
 * @module dsh-win-docker-workspace/fs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { checkContainerPathSync, inspectMountsSync, listContainerDirSync } from './shared/docker.ts'
import { getWorkspace, listWorkspaces } from './shared/win-docker-workspaces.ts'
import {
  containerChildPath,
  isWindowsDrivePath,
  mapContainerToHost,
  mapHostToContainer,
  normalizeWindowsPath,
} from './shared/paths.ts'

/** Prefix of a synthetic target key that names a container-only directory. */
const SYNTHETIC_PREFIX = 'docker-container://'

/** Encode a container-only directory into a synthetic target key. */
function syntheticKey(container: string, path: string): string {
  return `${SYNTHETIC_PREFIX}${container}/${path}`
}

/** Decode a synthetic target key, or null for ordinary (host-path) keys. */
function parseSyntheticKey(key: string): { container: string; path: string } | null {
  if (!key.startsWith(SYNTHETIC_PREFIX)) return null
  const rest = key.slice(SYNTHETIC_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  return { container: rest.slice(0, slash), path: rest.slice(slash + 1) }
}

/** Plugin config. `cwd`/`container` are optional because store lookups carry both. */
export interface Config {
  /** Base directory for relative paths without a per-call cwd (a container path). */
  cwd?: string
  /** Default container for container paths without a store entry. */
  container?: string
  /** Exclusive UTF-8 byte limit on each overwrite-diff side (see fs-local). */
  diffBasisMaxBytes?: number
}

/**
 * The Docker filesystem backend. Identity keys for mounted paths are host paths
 * (the local backend's realpath/atomic-write mechanics stay correct); the
 * container form is derived on demand. Container-only directories use a
 * synthetic key and are list-only.
 */
export class DockerFileSystem extends LocalFileSystem {
  static override Config: z<Config> = z.object({
    cwd: z.string(),
    container: z.string(),
    diffBasisMaxBytes: z.number().default(10 * 1024 * 1024),
  })

  private readonly container: string | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.container = config.container
  }

  /** Every container name this backend knows: the store's workspaces plus config. */
  private containerNames(): string[] {
    const names = new Set<string>()
    for (const key of listWorkspaces()) {
      const entry = getWorkspace(key)
      if (entry !== undefined) names.add(entry.container)
    }
    if (this.container !== undefined && this.container !== '') names.add(this.container)
    return [...names]
  }

  /** The container a container path belongs to: store first, then config. */
  private containerFor(path: string): string {
    const entry = getWorkspace(path)
    if (entry !== undefined) return entry.container
    if (this.container !== undefined && this.container !== '') return this.container
    throw new FsError('docker-fs: container path carries no container and none is configured', 'FS_IO_ERROR')
  }

  /** Map a host path back to a container path through any known container. */
  private hostToContainer(hostPath: string): string | null {
    for (const name of this.containerNames()) {
      const mapped = mapHostToContainer(hostPath, inspectMountsSync(name))
      if (mapped !== null) return mapped
    }
    return null
  }

  /** The container path of a resolved target (synthetic or host-backed), or null. */
  private targetContainerPath(target: FsTarget): string | null {
    const key = String(target.targetKey)
    const parsed = parseSyntheticKey(key)
    if (parsed !== null) return parsed.path
    return this.hostToContainer(key)
  }

  /** Resolve a model/plugin path into an absolute container path plus its container. */
  private resolveContainerPath(path: string, cwd?: string): { container: string; containerPath: string } {
    if (isWindowsDrivePath(path)) {
      return { container: this.containerFor(path), containerPath: normalizeWindowsPath(path) }
    }
    // Relative: resolve against the caller cwd (or the configured base), a container path.
    const base = cwd ?? this.config.cwd
    if (base === undefined || base === '' || !isWindowsDrivePath(base)) {
      throw new FsError('docker-fs: relative path needs a container-path cwd or configured base', 'FS_IO_ERROR')
    }
    const combined = normalizeWindowsPath(`${normalizeWindowsPath(base)}\\${path}`)
    return { container: this.containerFor(base), containerPath: combined }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const { container, containerPath } = this.resolveContainerPath(path, opts?.cwd)
    const host = mapContainerToHost(containerPath, inspectMountsSync(container))
    if (host !== null) {
      const local = await super.resolve(host, {
        cwd: process.cwd(),
        ...opts?.signal !== undefined ? { signal: opts.signal } : {},
      })
      const display = this.hostToContainer(String(local.displayPath)) ?? containerPath
      return { targetKey: local.targetKey, displayPath: display }
    }
    // Container-only path: synthesize a list-only target when it is a directory.
    const check = checkContainerPathSync(container, containerPath)
    if (!check.exists || !check.isDirectory) {
      throw new FsError(`docker-fs: path "${path}" does not exist or is not a directory`, 'FS_NOT_FOUND')
    }
    return { targetKey: FsTargetKey(syntheticKey(container, containerPath)), displayPath: containerPath }
  }

  override processPath(target: FsTarget): string {
    const container = this.targetContainerPath(target)
    if (container === null) {
      throw new FsError(`docker-fs: target "${target.displayPath}" is outside the container's bind mounts`, 'FS_IO_ERROR')
    }
    return container
  }

  override fileUrl(target: FsTarget): string {
    const container = this.processPath(target)
    const forward = container.replace(/\\/g, '/')
    return `file:///${forward.split('/').map(encodeURIComponent).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentContainer = this.targetContainerPath(parent)
    const childContainer = this.targetContainerPath(child)
    if (parentContainer === null || childContainer === null) return false
    const parentKey = normalizeWindowsPath(parentContainer).toLowerCase()
    const childKey = normalizeWindowsPath(childContainer).toLowerCase()
    if (childKey === parentKey) return true
    return childKey.startsWith(`${parentKey}\\`)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const parsed = parseSyntheticKey(String(target.targetKey))
    if (parsed === null) return super.stat(target, signal)
    const check = checkContainerPathSync(parsed.container, parsed.path)
    if (!check.exists) return undefined
    return { version: FsVersion(syntheticKey(parsed.container, parsed.path)), type: check.isDirectory ? 'directory' : 'other' }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const { container, containerPath } = this.resolveContainerPath(path, opts?.cwd)
    const host = mapContainerToHost(containerPath, inspectMountsSync(container))
    if (host === null) {
      const check = checkContainerPathSync(container, containerPath)
      if (!check.exists) return undefined
      return { version: FsVersion(syntheticKey(container, containerPath)), type: check.isDirectory ? 'directory' : 'other' }
    }
    return super.lstat(host, { cwd: process.cwd() }, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const parsed = parseSyntheticKey(String(target.targetKey))
    if (parsed === null) return super.listDir(target, signal)
    const entries = listContainerDirSync(parsed.container, parsed.path)
    const result: FsDirEntry[] = []
    for (const entry of entries) {
      const childPath = containerChildPath(parsed.path, entry.name)
      const childTarget = await this.resolve(childPath, signal !== undefined ? { signal } : {})
      result.push({
        name: entry.name,
        type: entry.kind === 'directory' ? 'directory' : entry.kind === 'file' ? 'file' : 'other',
        target: childTarget,
      })
    }
    return result
  }
}

export default DockerFileSystem
