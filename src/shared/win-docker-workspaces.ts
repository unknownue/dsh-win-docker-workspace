/**
 * Per-workspace Docker container store (host side only). The dialog records the
 * container name (and optional shell) of each Docker workspace; the shell
 * executor, the filesystem provider, and the per-session env contributor read
 * it back to resolve which container a path belongs to.
 *
 * Keys are per-(container, container-path) HOST anchor directories under
 * `<dshHome>/win-docker-workspaces/<container>/<drive>/<path>`: the DeepSeek
 * Harness workspace registry identifies a workspace by the canonical HOST path
 * of one existing directory (one workspace per path, enforced at startup), so
 * two containers that present the SAME in-container path (e.g. both bind-mount
 * `C:\workspace`) must be registered under DIFFERENT host anchors to stay fully
 * independent. The anchor doubles as the DSH workspace path (and thus the
 * session cwd); the execution world translates it back to the container path,
 * so the model keeps seeing container paths only.
 *
 * Legacy rows (written before this change) are keyed by the container path
 * itself and carry no `containerPath`; they read as `containerPath = key` and
 * are migrated to anchors when the same workspace is added again.
 *
 * This module touches node builtins, so the browser half never imports it.
 * @module dsh-win-docker-workspace/shared/win-docker-workspaces
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isValidContainerName, isValidShellName, normalizeWindowsPath } from './paths.ts'

/** One workspace's stored execution-world facts. */
export interface WorkspaceEntry {
  /** The Docker container the workspace's commands run in. */
  container: string
  /**
   * The in-container workspace root (e.g. `C:\workspace`). Absent on legacy
   * rows, where the store KEY is the container path.
   */
  containerPath?: string
  /** The in-container shell executable (absent = the configured default). */
  shell?: string
}

/** The stored form: canonical workspace key → workspace facts. */
type WorkspaceStore = Record<string, WorkspaceEntry>

/** One stored row plus its key (the key disambiguates anchors from legacy rows). */
export interface WorkspaceRecord {
  /** The store key (an anchor path, or a container path on legacy rows). */
  key: string
  /** The stored facts. */
  entry: WorkspaceEntry
}

/** An anchor-path match: the workspace root anchor plus the relative remainder. */
export interface AnchorMatch {
  /** The covering entry. */
  entry: WorkspaceEntry
  /** The anchor (workspace root) host path that covers the queried path. */
  anchor: string
  /** The queried path's remainder below the anchor ('' for the anchor itself). */
  remainder: string
}

/** The store file lives under the harness home so both host halves share it. */
function storePath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'win-docker-workspaces.json')
}

/** The anchors directory (`<dshHome>/win-docker-workspaces/<container>/...`). */
function anchorsRoot(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'win-docker-workspaces')
}

/** Read the store; a missing or corrupt file reads as empty (never throws). */
function readStore(): WorkspaceStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as WorkspaceStore
  } catch {
    return {}
  }
}

/** Write the store atomically enough for a single-writer host process. */
function writeStore(store: WorkspaceStore): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/** Canonicalize any accepted container-path spelling into the store's key form. */
export function canonicalContainerPath(path: string): string | null {
  if (!/^[A-Za-z]:[\\/]/.test(path)) return null
  return normalizeWindowsPath(path)
}

/** The container-path segment list of a normalized Windows path (`C:\a\b` → `['C','a','b']`). */
function pathSegments(normalized: string): string[] {
  const drive = normalized.slice(0, 1)
  const rest = normalized.slice(2).split('\\').filter(segment => segment !== '')
  return [drive, ...rest]
}

/** The workspace root container path a row covers (legacy rows: the key). */
export function containerPathOf(entry: WorkspaceEntry, key: string): string {
  return entry.containerPath !== undefined
    ? normalizeWindowsPath(entry.containerPath)
    : normalizeWindowsPath(key)
}

/** The host anchor directory of one (container, containerPath) workspace. */
export function anchorPathFor(container: string, containerPath: string): string {
  return join(anchorsRoot(), container, ...pathSegments(normalizeWindowsPath(containerPath)))
}

/** True when a row is anchor-typed (its key is a host anchor, not a container path). */
function isAnchorRow(entry: WorkspaceEntry): boolean {
  return entry.containerPath !== undefined
}

/** Case-insensitive longest-prefix match of `path` over `roots`. */
function longestPrefixMatch(path: string, roots: readonly string[]): { root: string; remainder: string } | null {
  const normalized = normalizeWindowsPath(path)
  const key = normalized.toLowerCase()
  let best: string | null = null
  let bestLen = -1
  for (const root of roots) {
    const rootNormalized = normalizeWindowsPath(root)
    const rootLower = rootNormalized.toLowerCase()
    if ((key === rootLower || key.startsWith(`${rootLower}\\`)) && rootNormalized.length > bestLen) {
      bestLen = rootNormalized.length
      best = rootNormalized
    }
  }
  if (best === null) return null
  const remainder = normalized.slice(best.length).replace(/^\\/, '')
  return { root: best, remainder }
}

/** The stored row for a key, tolerating rows whose entry is malformed. */
function rowFor(store: WorkspaceStore, key: string): WorkspaceRecord | undefined {
  const entry = store[key]
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as WorkspaceEntry
  if (typeof record.container !== 'string') return undefined
  return { key, entry: record }
}

/** All valid stored rows (anchor and legacy). */
export function listRecords(): WorkspaceRecord[] {
  const store = readStore()
  const records: WorkspaceRecord[] = []
  for (const key of Object.keys(store)) {
    const row = rowFor(store, key)
    if (row !== undefined) records.push(row)
  }
  return records
}

/**
 * Resolve a host path that falls under a stored workspace anchor (the DSH
 * workspace path / session cwd, or any path below it).
 * @param path - the candidate host path.
 * @returns the covering anchor row and the relative remainder, or undefined.
 */
export function resolveAnchorPath(path: string): AnchorMatch | undefined {
  const normalized = normalizeWindowsPath(path)
  const anchors = listRecords().filter(record => isAnchorRow(record.entry)).map(record => record.key)
  const match = longestPrefixMatch(normalized, anchors)
  if (match === null) return undefined
  const store = readStore()
  const row = rowFor(store, match.root)
  if (row === undefined) return undefined
  return { entry: row.entry, anchor: match.root, remainder: match.remainder }
}

/** True when `child` equals or descends from `parent` (case-insensitive). */
function isWithin(child: string, parent: string): boolean {
  const childKey = child.toLowerCase()
  const parentKey = parent.toLowerCase()
  return childKey === parentKey || childKey.startsWith(`${parentKey}\\`)
}

/**
 * Every stored row whose workspace root covers a container path.
 * @param containerPath - the container path to look up.
 * @returns the covering rows (anchor rows by `containerPath`, legacy rows by key).
 */
export function containerOwners(containerPath: string): WorkspaceRecord[] {
  const normalized = normalizeWindowsPath(containerPath)
  return listRecords().filter(record => isWithin(normalized, containerPathOf(record.entry, record.key)))
}

/**
 * Read the stored workspace facts for a path:
 * 1. a host path under a workspace anchor resolves to that workspace's entry;
 * 2. otherwise the path is treated as a container path and resolves only when
 *    EXACTLY ONE stored workspace covers it — a path shared by several
 *    containers (e.g. `C:\workspace` mounted by both `gm-qa` and `gm-trunk`)
 *    resolves to undefined instead of silently picking a container.
 * @param path - a host anchor path or a container path (any accepted spelling).
 * @returns the workspace entry, or undefined when no unique entry covers it.
 */
export function getWorkspace(path: string): WorkspaceEntry | undefined {
  const anchor = resolveAnchorPath(path)
  if (anchor !== undefined) return anchor.entry
  const owners = containerOwners(path)
  return owners.length === 1 ? owners[0]!.entry : undefined
}

/**
 * Store (or clear) the container/shell facts of a Docker workspace, keyed by
 * its own host anchor directory so distinct containers never share a key.
 * A legacy row for the same (container, containerPath) is migrated to the
 * anchor. The anchor directory is created because the harness workspace
 * registry requires its path to be an existing host directory.
 * @param containerPath - the workspace root container path.
 * @param container - the container name.
 * @param shell - optional in-container shell; empty clears the stored value.
 * @returns the anchor host path (the DSH workspace path to register).
 */
export function setWorkspace(containerPath: string, container: string, shell: string | undefined): string {
  const normalized = canonicalContainerPath(containerPath)
  if (normalized === null) throw new Error('docker-workspace: workspace path is not a Windows container path')
  const containerName = container.trim()
  if (!isValidContainerName(containerName)) {
    throw new Error('docker-workspace: container must match the name pattern [A-Za-z0-9][A-Za-z0-9_.-]*')
  }
  const anchor = anchorPathFor(containerName, normalized)
  const store = readStore()
  const entry: WorkspaceEntry = { container: containerName, containerPath: normalized }
  if (shell !== undefined && shell.trim() !== '') {
    const shellName = shell.trim()
    if (!isValidShellName(shellName)) {
      throw new Error('docker-workspace: shell must be a plain executable name (e.g. powershell.exe)')
    }
    entry.shell = shellName
  }
  // Migrate a legacy row keyed at the same container path for the same
  // container (its facts are superseded by the anchor row); legacy rows of
  // OTHER containers stay so their sessions keep resolving uniquely.
  for (const key of Object.keys(store)) {
    const row = rowFor(store, key)
    if (row === undefined || isAnchorRow(row.entry)) continue
    if (normalizeWindowsPath(key) === normalized && row.entry.container === containerName) delete store[key]
  }
  store[anchor] = entry
  mkdirSync(anchor, { recursive: true })
  writeStore(store)
  return anchor
}

/**
 * List the stored workspace roots: anchor host paths for anchor rows and the
 * container path itself for legacy rows. The client's mode-variant predicate
 * matches session cwds against this set, and a session cwd is always one of
 * these two spellings.
 * @returns the canonical workspace roots.
 */
export function listWorkspaces(): string[] {
  return listRecords().map(record => normalizeWindowsPath(record.key))
}
