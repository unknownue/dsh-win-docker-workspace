/**
 * Windows container path helpers shared by the client and host halves. Pure
 * and dependency-free so both planes can import them without a runtime edge.
 */

/** One bind mount as `docker inspect` reports it (host source → container destination). */
export interface BindMount {
  /** Host filesystem path (e.g. `E:\Work\GM10\trunk_branch\code\client\script`). */
  readonly source: string
  /** Container filesystem path (e.g. `C:\workspace\pyscript`). */
  readonly destination: string
}

/**
 * Whether a path is a Windows drive path (`C:\...` or `C:/...`). Container
 * workspaces are always absolute drive paths, so this is the shape gate every
 * Docker-world path must pass.
 * @param path - candidate path.
 * @returns whether it starts with a single drive letter.
 */
export function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Normalize a Windows path to the canonical form used for identity keys and
 * prefix matching: forward slashes folded to backslashes, repeated separators
 * collapsed, the drive letter uppercased, and a trailing separator stripped
 * (a bare `C:` is kept as `C:\`). Comparison remains case-insensitive at the
 * call sites because Windows paths are.
 * @param path - the candidate path.
 * @returns the normalized path.
 */
export function normalizeWindowsPath(path: string): string {
  const backslashed = path.replace(/\//g, '\\')
  const collapsed = backslashed.replace(/\\+/g, '\\')
  const driveUpper = collapsed.replace(/^([A-Za-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
  if (/^[A-Za-z]:$/.test(driveUpper)) return `${driveUpper}\\`
  return driveUpper.replace(/\\$/, '')
}

/** Lowercased comparison key for a normalized Windows path. */
function pathKey(path: string): string {
  return path.toLowerCase()
}

/** True when `child` equals `parent` or is a strict descendant of it. */
function isWithin(childKey: string, parentKey: string): boolean {
  return childKey === parentKey || childKey.startsWith(`${parentKey}\\`)
}

/**
 * Map a container path to its host path through the longest matching bind
 * mount destination. Returns `null` when no mount covers the path (the path
 * is container-private and has no host spelling).
 * @param containerPath - absolute container path.
 * @param mounts - the container's bind mounts.
 * @returns the host path, or null when outside every mount.
 */
export function mapContainerToHost(containerPath: string, mounts: readonly BindMount[]): string | null {
  const normalized = normalizeWindowsPath(containerPath)
  const nk = pathKey(normalized)
  let best: BindMount | null = null
  let bestLen = -1
  for (const mount of mounts) {
    const dst = normalizeWindowsPath(mount.destination)
    if (isWithin(nk, pathKey(dst)) && dst.length > bestLen) {
      bestLen = dst.length
      best = mount
    }
  }
  if (best === null) return null
  const src = normalizeWindowsPath(best.source)
  const dst = normalizeWindowsPath(best.destination)
  const rest = normalized.slice(dst.length).replace(/^\\/, '')
  return rest === '' ? src : `${src}\\${rest}`
}

/**
 * Map a host path back to a container path through the longest matching bind
 * mount source. Returns `null` when no mount's source covers the path.
 * @param hostPath - absolute host path.
 * @param mounts - the container's bind mounts.
 * @returns the container path, or null when outside every mount.
 */
export function mapHostToContainer(hostPath: string, mounts: readonly BindMount[]): string | null {
  const normalized = normalizeWindowsPath(hostPath)
  const nk = pathKey(normalized)
  let best: BindMount | null = null
  let bestLen = -1
  for (const mount of mounts) {
    const src = normalizeWindowsPath(mount.source)
    if (isWithin(nk, pathKey(src)) && src.length > bestLen) {
      bestLen = src.length
      best = mount
    }
  }
  if (best === null) return null
  const src = normalizeWindowsPath(best.source)
  const dst = normalizeWindowsPath(best.destination)
  const rest = normalized.slice(src.length).replace(/^\\/, '')
  return rest === '' ? dst : `${dst}\\${rest}`
}

/**
 * Join a container root and a relative remainder into a full container path.
 * @param root - normalized container root (e.g. `C:\workspace\pyscript`).
 * @param name - a single path segment (no separators).
 * @returns the child container path.
 */
export function containerChildPath(root: string, name: string): string {
  const base = normalizeWindowsPath(root)
  return base === `${base[0]}:\\` ? `${base}${name}` : `${base}\\${name}`
}

/**
 * Whether a session cwd falls inside any stored Docker workspace root. Used by
 * the browser half's mode-variant binding (container paths cannot be told
 * apart from ordinary Windows paths by shape alone, so the host-provided
 * workspace set is the predicate).
 * @param cwd - the session working directory (a container path).
 * @param roots - the stored workspace roots (canonical container paths).
 * @returns whether the cwd equals or descends from a workspace root.
 */
export function isWithinWorkspace(cwd: string, roots: readonly string[]): boolean {
  const cwdKey = normalizeWindowsPath(cwd).toLowerCase()
  for (const root of roots) {
    const rootKey = normalizeWindowsPath(root).toLowerCase()
    if (cwdKey === rootKey || cwdKey.startsWith(`${rootKey}\\`)) return true
  }
  return false
}

/**
 * The deepest common ancestor directory of a set of absolute Windows paths,
 * used as the default browse root for a container's bind-mount destinations
 * (e.g. `C:\workspace` for `C:\workspace\pyscript`, `C:\workspace\csscript`).
 * @param paths - absolute Windows paths.
 * @returns the common ancestor (a normalized path), or null for no shared root.
 */
export function commonAncestor(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const split = paths.map(path => normalizeWindowsPath(path).split('\\'))
  const first = split[0]!
  const common: string[] = []
  for (let index = 0; index < first.length; index++) {
    const segment = first[index]!
    if (split.every(segments => segments[index] !== undefined && segments[index]!.toLowerCase() === segment.toLowerCase())) {
      common.push(segment)
    } else {
      break
    }
  }
  return common.length === 0 ? null : normalizeWindowsPath(common.join('\\'))
}

/**
 * Whether a container path is a strict ancestor of at least one bind-mount
 * destination (e.g. `C:\workspace` contains `C:\workspace\pyscript`). Such a
 * path is a valid workspace root even though it is not itself a mount.
 * @param containerPath - absolute container path.
 * @param mounts - the container's bind mounts.
 * @returns whether some mount destination is a strict descendant of the path.
 */
export function containsMount(containerPath: string, mounts: readonly BindMount[]): boolean {
  const normalized = normalizeWindowsPath(containerPath)
  const key = normalized.toLowerCase()
  for (const mount of mounts) {
    const dst = normalizeWindowsPath(mount.destination).toLowerCase()
    if (dst.startsWith(`${key}\\`)) return true
  }
  return false
}

/** Container name shape for `docker exec`/`docker inspect` (one safe token). */
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * Whether a value is a safe container name. Strict on purpose: the value is
 * passed as a `docker exec`/`docker inspect` argv element, so separators,
 * leading dashes, and whitespace are rejected.
 * @param value - candidate container name.
 * @returns whether it matches the container-name shape.
 */
export function isValidContainerName(value: string): boolean {
  return CONTAINER_PATTERN.test(value)
}

/** Executable name shape for the container shell (`powershell.exe`, `pwsh`, `cmd`). */
const SHELL_PATTERN = /^[A-Za-z0-9_.-]+(?:\.exe)?$/i

/**
 * Whether a value is a safe in-container shell executable. The value becomes a
 * `docker exec` argv element, so no separators, spaces, or option-looking
 * tokens are allowed.
 * @param value - candidate shell name.
 * @returns whether it matches the shell-executable shape.
 */
export function isValidShellName(value: string): boolean {
  return SHELL_PATTERN.test(value)
}
