/**
 * Thin fetch client for the Host plugin route. The browser calls
 * POST /win-docker-workspace/api with a `{ method, params }` envelope and the
 * Host answers `{ ok: true, value }` or `{ ok: false, error }`.
 */

/** Relative route the Host half registers (same-origin with the web server). */
const ENDPOINT = '/win-docker-workspace/api'

/** One bind mount as the Host lists it. */
export interface DockerMount {
  source: string
  destination: string
}

/** One directory entry as the Host lists it. */
export interface DockerDirEntry {
  name: string
  kind: 'directory' | 'file' | 'other'
}

/** One directory level plus its breadcrumb ancestry. */
export interface DockerDirListing {
  /** The listed absolute container path. */
  path: string
  /** Parent container path, or null when the parent is outside the bind mounts. */
  parent: string | null
  /** The level's children (in name order; the client filters to directories). */
  entries: DockerDirEntry[]
}

/** Existence/directory/bind-mount check result for one container path. */
export interface DockerPathCheck {
  exists: boolean
  isDirectory: boolean
  /** Whether the path is inside a bind mount, so the file tools can read/write it. */
  inBindMount: boolean
  /** Whether the path is an ancestor of a bind mount (a valid workspace root). */
  containsMounts: boolean
}

/** Wire envelope the Host route answers with. */
type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

/** Human text for an unknown rejection. */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Perform one POST call and unwrap the envelope.
 * @param method - the Host method name.
 * @param params - the method payload.
 * @returns the unwrapped value, or throws an Error on network or `ok:false`.
 */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
  } catch (error) {
    throw new Error(`win-docker-workspace request failed: ${errorMessage(error)}`)
  }
  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    throw new Error(`win-docker-workspace answered non-JSON (${response.status})`)
  }
  if (!envelope.ok) throw new Error(envelope.error)
  return envelope.value
}

/**
 * List the running containers on the host.
 * @returns container names in `docker ps` order.
 */
export async function listContainers(): Promise<string[]> {
  return call<string[]>('listContainers', {})
}

/**
 * List one container's bind mounts.
 * @param container - container name.
 * @returns the bind mounts.
 */
export async function listMounts(container: string): Promise<DockerMount[]> {
  return call<DockerMount[]>('listMounts', { container })
}

/**
 * List one directory level inside a container (through its bind mounts).
 * @param container - container name.
 * @param path - absolute container directory to list.
 * @returns the level's listing with ancestry.
 */
export async function listDir(container: string, path: string): Promise<DockerDirListing> {
  return call<DockerDirListing>('listDir', { container, path })
}

/**
 * Check whether a container path exists and is a directory.
 * @param container - container name.
 * @param path - absolute container path.
 * @returns existence and directory facts.
 */
export async function check(container: string, path: string): Promise<DockerPathCheck> {
  return call<DockerPathCheck>('check', { container, path })
}

/**
 * Store the container/shell facts of one Docker workspace.
 * @param path - the workspace root container path.
 * @param container - the container name.
 * @param shell - optional shell; empty string clears the stored value.
 */
export async function setWorkspace(path: string, container: string, shell: string): Promise<void> {
  return call<void>('setWorkspace', { path, container, shell })
}

/**
 * Ensure the container path exists as a host directory (a realpath anchor so
 * the DSH workspace service accepts it); the filesystem provider then lists it
 * through the container instead of the host placeholder.
 * @param path - the container workspace root path.
 */
export async function ensurePath(path: string): Promise<void> {
  return call<void>('ensurePath', { path })
}

/**
 * List the stored Docker workspace roots.
 * @returns the canonical container paths.
 */
export async function listWorkspaces(): Promise<string[]> {
  return call<string[]>('listWorkspaces', {})
}
