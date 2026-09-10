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
import { containerOwners, containerPathOf, getWorkspace, listRecords, resolveAnchorPath } from './shared/win-docker-workspaces.ts'
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

  /**
   * Host targetKey → container, recorded at `resolve` time. The container is
   * per-session (each session runs its own `fs-docker` instance) and the host
   * key is unique within a session, so `listDir` can look the owning container
   * back up to union the bind mounts the container overlays on a mount source
   * (e.g. `code`/`assets` nested under the `C:\workspace` root mount) that the
   * host source alone does not contain.
   */
  private readonly containerByKey = new Map<string, string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.container = config.container
  }

  /** Every container name this backend knows: the store's workspaces plus config. */
  private containerNames(): string[] {
    const names = new Set<string>()
    for (const record of listRecords()) names.add(record.entry.container)
    if (this.container !== undefined && this.container !== '') names.add(this.container)
    return [...names]
  }

  /** Join a normalized container root with a relative remainder ('' keeps the root). */
  private static joinContainer(root: string, remainder: string): string {
    return remainder === '' ? normalizeWindowsPath(root) : normalizeWindowsPath(`${normalizeWindowsPath(root)}\\${remainder}`)
  }

  /**
   * Resolve a model/plugin path into an absolute container path plus its
   * container. Workspace identity is the host anchor the session cwd carries:
   * a relative path resolves against the anchor's container root, and an
   * absolute path resolves in the SAME container as the session — so two
   * containers that present the same container path (`C:\workspace`) each
   * serve their own sessions. Anchor spellings passed verbatim are translated
   * back to container paths. Without a session cwd, an absolute container path
   * resolves only when a unique stored workspace covers it; a shared path
   * fails loud instead of guessing a container.
   */
  private resolveContainerPath(path: string, cwd?: string): { container: string; containerPath: string } {
    const anchorOfCwd = cwd !== undefined ? resolveAnchorPath(cwd) : undefined
    if (anchorOfCwd !== undefined) {
      const root = containerPathOf(anchorOfCwd.entry, anchorOfCwd.anchor)
      if (!isWindowsDrivePath(path)) {
        return { container: anchorOfCwd.entry.container, containerPath: DockerFileSystem.joinContainer(root, path) }
      }
      // Absolute: an anchor spelling translates to the container path; any
      // other Windows drive path keeps its spelling in the session's container.
      const anchorOfPath = resolveAnchorPath(path)
      if (anchorOfPath !== undefined) {
        const pathRoot = containerPathOf(anchorOfPath.entry, anchorOfPath.anchor)
        return {
          container: anchorOfPath.entry.container,
          containerPath: DockerFileSystem.joinContainer(pathRoot, anchorOfPath.remainder),
        }
      }
      return { container: anchorOfCwd.entry.container, containerPath: normalizeWindowsPath(path) }
    }
    if (isWindowsDrivePath(path)) {
      const anchorOfPath = resolveAnchorPath(path)
      if (anchorOfPath !== undefined) {
        const pathRoot = containerPathOf(anchorOfPath.entry, anchorOfPath.anchor)
        return {
          container: anchorOfPath.entry.container,
          containerPath: DockerFileSystem.joinContainer(pathRoot, anchorOfPath.remainder),
        }
      }
      const entry = getWorkspace(path)
      if (entry !== undefined) return { container: entry.container, containerPath: normalizeWindowsPath(path) }
      if (this.container !== undefined && this.container !== '') {
        return { container: this.container, containerPath: normalizeWindowsPath(path) }
      }
      const owners = containerOwners(path)
      const detail = owners.length > 1
        ? `; it is shared by containers ${owners.map(owner => owner.entry.container).join(', ')} — add each workspace again through the Docker workspace dialog so every container gets its own workspace`
        : ''
      throw new FsError(`docker-fs: container path "${path}" carries no container${detail} and none is configured`, 'FS_IO_ERROR')
    }
    // Relative without a session anchor: resolve against the configured base.
    const base = this.config.cwd
    if (base === undefined || base === '' || !isWindowsDrivePath(base)) {
      throw new FsError('docker-fs: relative path needs a container-path cwd or configured base', 'FS_IO_ERROR')
    }
    const anchorOfBase = resolveAnchorPath(base)
    if (anchorOfBase !== undefined) {
      const root = containerPathOf(anchorOfBase.entry, anchorOfBase.anchor)
      return { container: anchorOfBase.entry.container, containerPath: DockerFileSystem.joinContainer(root, path) }
    }
    const combined = normalizeWindowsPath(`${normalizeWindowsPath(base)}\\${path}`)
    const entry = getWorkspace(base)
    if (entry !== undefined) return { container: entry.container, containerPath: combined }
    if (this.container !== undefined && this.container !== '') return { container: this.container, containerPath: combined }
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

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const { container, containerPath } = this.resolveContainerPath(path, opts?.cwd)
    const host = mapContainerToHost(containerPath, inspectMountsSync(container))
    if (host !== null) {
      const local = await super.resolve(host, {
        cwd: process.cwd(),
        ...opts?.signal !== undefined ? { signal: opts.signal } : {},
      })
      this.containerByKey.set(String(local.targetKey), container)
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
    if (parsed === null) {
      const entries = await super.listDir(target, signal)
      const container = this.containerByKey.get(String(target.targetKey))
      return container === undefined ? entries : this.unionMountOverlay(container, target, entries, signal)
    }
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

  /**
   * Union a container's bind mounts into a host-backed directory listing. The
   * container overlays every nested mount on top of its parent mount's content
   * (e.g. `C:\workspace\code` and `C:\workspace\assets\art_res_*` on top of the
   * `C:\workspace` → docker-shared root mount), but the host source contains
   * none of them — so without this, listing `C:\workspace` shows only the root
   * mount's files and the model/UI never see the source code. Each nested
   * mount appears as a directory entry (its deepest host source resolves
   * directly, bypassing the shared-path container ambiguity); descending into
   * it then repeats this union at the next level.
   * @param container - the owning container (from `containerByKey`).
   * @param target - the host-backed target being listed.
   * @param entries - the mount source's own listing.
   * @param signal - optional cancellation.
   * @returns the union listing, sorted directories-first by name.
   */
  private async unionMountOverlay(container: string, target: FsTarget, entries: FsDirEntry[], signal?: AbortSignal): Promise<FsDirEntry[]> {
    const mounts = inspectMountsSync(container)
    const containerPath = mapHostToContainer(String(target.targetKey), mounts)
    if (containerPath === null) return entries
    const containerKey = normalizeWindowsPath(containerPath).toLowerCase()
    for (const mount of mounts) {
      const dest = normalizeWindowsPath(mount.destination)
      const destKey = dest.toLowerCase()
      if (destKey === containerKey || !destKey.startsWith(`${containerKey}\\`)) continue
      const top = dest.slice(containerPath.length).replace(/^\\/, '').split('\\')[0]!
      if (top === '' || entries.some(entry => entry.name.toLowerCase() === top.toLowerCase())) continue
      const hostChild = mapContainerToHost(dest, mounts)
      if (hostChild === null) continue
      const local = await super.resolve(hostChild, {
        cwd: process.cwd(),
        ...signal !== undefined ? { signal } : {},
      })
      this.containerByKey.set(String(local.targetKey), container)
      entries.push({ name: top, type: 'directory', target: { targetKey: local.targetKey, displayPath: dest } })
    }
    return entries.sort((a, b) => {
      const aDir = a.type === 'directory' ? 0 : 1
      const bDir = b.type === 'directory' ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      const an = a.name.toLowerCase()
      const bn = b.name.toLowerCase()
      return an < bn ? -1 : an > bn ? 1 : 0
    })
  }
}

export default DockerFileSystem
