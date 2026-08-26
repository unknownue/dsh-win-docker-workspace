/**
 * Per-workspace Docker container store (host side only). The dialog records the
 * container name (and optional shell) of each Docker workspace under the
 * harness home; the shell executor, the filesystem provider, and the per-session
 * env contributor read it back to resolve which container a container path
 * belongs to. Keys are canonical container paths (workspace roots). This module
 * touches node builtins, so the browser half never imports it.
 * @module dsh-win-docker-workspace/shared/win-docker-workspaces
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isValidContainerName, isValidShellName, normalizeWindowsPath } from './paths.ts'

/** One workspace's stored execution-world facts. */
interface WorkspaceEntry {
  /** The Docker container the workspace's commands run in. */
  container: string
  /** The in-container shell executable (absent = the configured default). */
  shell?: string
}

/** The stored form: canonical container path → workspace facts. */
type WorkspaceStore = Record<string, WorkspaceEntry>

/** The store file lives under the harness home so both host halves share it. */
function storePath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'win-docker-workspaces.json')
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

/**
 * Read the stored workspace facts for a container path (longest-key prefix
 * match, so a deep path resolves to its workspace root).
 * @param containerPath - the container path (any accepted spelling).
 * @returns the workspace entry, or undefined when none covers the path.
 */
export function getWorkspace(containerPath: string): WorkspaceEntry | undefined {
  const normalized = normalizeWindowsPath(containerPath)
  const key = normalized.toLowerCase()
  const store = readStore()
  let bestKey: string | undefined
  let bestLen = -1
  for (const storedKey of Object.keys(store)) {
    const storedNormalized = normalizeWindowsPath(storedKey)
    const storedLower = storedNormalized.toLowerCase()
    if ((key === storedLower || key.startsWith(`${storedLower}\\`)) && storedNormalized.length > bestLen) {
      bestLen = storedNormalized.length
      bestKey = storedKey
    }
  }
  return bestKey === undefined ? undefined : store[bestKey]
}

/**
 * Store (or clear) the container/shell facts of a Docker workspace.
 * @param containerPath - the workspace root container path.
 * @param container - the container name.
 * @param shell - optional in-container shell; empty clears the stored value.
 */
export function setWorkspace(containerPath: string, container: string, shell: string | undefined): void {
  const key = canonicalContainerPath(containerPath)
  if (key === null) throw new Error('docker-workspace: workspace path is not a Windows container path')
  const containerName = container.trim()
  if (!isValidContainerName(containerName)) {
    throw new Error('docker-workspace: container must match the name pattern [A-Za-z0-9][A-Za-z0-9_.-]*')
  }
  const store = readStore()
  if (shell === undefined || shell.trim() === '') {
    store[key] = { container: containerName }
  } else {
    const shellName = shell.trim()
    if (!isValidShellName(shellName)) {
      throw new Error('docker-workspace: shell must be a plain executable name (e.g. powershell.exe)')
    }
    store[key] = { container: containerName, shell: shellName }
  }
  writeStore(store)
}

/**
 * List the stored workspace roots (canonical container paths), for the dialog
 * and the client's mode-variant predicate.
 * @returns the canonical container paths.
 */
export function listWorkspaces(): string[] {
  return Object.keys(readStore()).map(normalizeWindowsPath)
}
