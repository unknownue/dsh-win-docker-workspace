/**
 * Docker discovery helpers (host side): enumerate running containers through
 * `docker ps` and read one container's bind mounts through `docker inspect`.
 * Both are short local daemon calls; the mounts result is cached per container
 * with a short TTL so the filesystem provider can map container↔host paths
 * synchronously without re-inspecting on every resolve.
 * @module dsh-win-docker-workspace/shared/docker
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { BindMount } from './paths.ts'

const execFileAsync = promisify(execFile)

/** Executable timeout for the short discovery calls. */
const DISCOVERY_TIMEOUT_MS = 10_000

/** Mount-table cache TTL; container recreation beyond this window requires a re-inspect. */
const MOUNTS_TTL_MS = 30_000

/** Human text for an unknown rejection. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** One cached mount table plus the read time. */
interface CachedMounts {
  readonly at: number
  readonly mounts: readonly BindMount[]
}

/** Module-level mount cache (one read per container per TTL window). */
const mountsCache = new Map<string, CachedMounts>()

/** Clear the mount cache (test hook; container recreation also needs a re-inspect). */
export function clearMountsCache(): void {
  mountsCache.clear()
}

/**
 * Parse the raw `docker inspect --format "{{json .Mounts}}"` output into bind
 * mounts. Accepts `null`/`[]` (no mounts) and tolerates an empty body.
 * @param raw - the trimmed stdout text.
 * @returns the bind mounts, in inspection order.
 */
export function parseMountsJson(raw: string): BindMount[] {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'null') return []
  const parsed = JSON.parse(trimmed) as unknown
  if (!Array.isArray(parsed)) return []
  const mounts: BindMount[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (record.Type !== 'bind') continue
    if (typeof record.Source !== 'string' || typeof record.Destination !== 'string') continue
    mounts.push({ source: record.Source, destination: record.Destination })
  }
  return mounts
}

/**
 * Read one container's bind mounts synchronously (cached per container with a
 * short TTL). Fails loud with an actionable message when the container is not
 * running or the daemon is unreachable.
 * @param container - container name.
 * @param dockerPath - the `docker` executable (absolute or PATH name).
 * @returns the bind mounts.
 */
export function inspectMountsSync(container: string, dockerPath = 'docker.exe'): readonly BindMount[] {
  const cached = mountsCache.get(container)
  if (cached !== undefined && Date.now() - cached.at < MOUNTS_TTL_MS) return cached.mounts
  let raw: string
  try {
    raw = execFileSync(dockerPath, ['inspect', container, '--format', '{{json .Mounts}}'], {
      encoding: 'utf8',
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(
      `docker-workspace: cannot inspect container "${container}" (${messageOf(error)}); is the container running?`,
    )
  }
  const mounts = parseMountsJson(raw)
  mountsCache.set(container, { at: Date.now(), mounts })
  return mounts
}

/** One directory entry listed from inside a container. */
export interface ContainerDirEntry {
  name: string
  kind: 'directory' | 'file' | 'other'
}

/** One existence/directory fact resolved from inside a container. */
export interface ContainerPathCheck {
  exists: boolean
  isDirectory: boolean
}

/**
 * List one directory inside a container through `docker exec powershell
 * Get-ChildItem`. This covers the WHOLE container filesystem — including
 * directories that are not bind-mounted (e.g. the `C:\workspace` parent) — so
 * the dialog can browse upward from a mount root. Fails loud when the path
 * does not exist (PowerShell exits 3) or the container is not running.
 * @param container - container name.
 * @param path - absolute container directory.
 * @param dockerPath - the `docker` executable.
 * @returns the directory entries.
 */
export function listContainerDirSync(container: string, path: string, dockerPath = 'docker.exe'): ContainerDirEntry[] {
  const escaped = path.replace(/'/g, "''")
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { Get-ChildItem -LiteralPath '${escaped}' -Force | ForEach-Object { $kind = if ($_.PSIsContainer) { 'D' } else { 'F' }; Write-Output ($kind + $_.Name) } } catch { exit 3 }`
  let stdout: string
  try {
    stdout = execFileSync(dockerPath, ['exec', container, 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 3) throw new Error(`path does not exist or is not a directory: ${path}`)
    throw new Error(`docker-workspace: cannot list container directory (${messageOf(error)}); is the container running?`)
  }
  const entries: ContainerDirEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length < 2) continue
    const kind: ContainerDirEntry['kind'] = trimmed[0] === 'D' ? 'directory' : trimmed[0] === 'F' ? 'file' : 'other'
    entries.push({ name: trimmed.slice(1), kind })
  }
  return entries
}

/**
 * Check a path's existence/directory facts inside a container through
 * `docker exec powershell Test-Path` + `Get-Item`. Covers the whole container
 * filesystem, so the dialog can validate any browsed directory.
 * @param container - container name.
 * @param path - absolute container path.
 * @param dockerPath - the `docker` executable.
 * @returns existence and directory facts.
 */
export function checkContainerPathSync(container: string, path: string, dockerPath = 'docker.exe'): ContainerPathCheck {
  const escaped = path.replace(/'/g, "''")
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p = '${escaped}'; if (Test-Path -LiteralPath $p) { $i = Get-Item -LiteralPath $p; if ($i.PSIsContainer) { Write-Output 'D' } else { Write-Output 'F' } } else { Write-Output 'N' }`
  let stdout: string
  try {
    stdout = execFileSync(dockerPath, ['exec', container, 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`docker-workspace: cannot check container path (${messageOf(error)}); is the container running?`)
  }
  const result = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).pop() ?? 'N'
  if (result === 'D') return { exists: true, isDirectory: true }
  if (result === 'F') return { exists: true, isDirectory: false }
  return { exists: false, isDirectory: false }
}

/**
 * List running containers in `docker ps` order.
 * @param dockerPath - the `docker` executable (absolute or PATH name).
 * @returns container names, blank lines dropped.
 */
export async function listContainers(dockerPath = 'docker.exe'): Promise<string[]> {
  let stdout: string
  try {
    const result = await execFileAsync(dockerPath, ['ps', '--format', '{{.Names}}'], {
      encoding: 'utf8',
      timeout: DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    })
    stdout = result.stdout
  } catch (error) {
    throw new Error(
      `docker-workspace: cannot list running containers (${messageOf(error)}); is Docker running in Windows container mode?`,
    )
  }
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
}
