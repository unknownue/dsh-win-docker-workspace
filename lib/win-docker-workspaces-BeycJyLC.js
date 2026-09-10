import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
//#region src/shared/paths.ts
/**
* Whether a path is a Windows drive path (`C:\...` or `C:/...`). Container
* workspaces are always absolute drive paths, so this is the shape gate every
* Docker-world path must pass.
* @param path - candidate path.
* @returns whether it starts with a single drive letter.
*/
function isWindowsDrivePath(path) {
	return /^[A-Za-z]:[\\/]/.test(path);
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
function normalizeWindowsPath(path) {
	const driveUpper = path.replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/^([A-Za-z]):/, (_, d) => `${d.toUpperCase()}:`);
	if (/^[A-Za-z]:$/.test(driveUpper)) return `${driveUpper}\\`;
	return driveUpper.replace(/\\$/, "");
}
/** Lowercased comparison key for a normalized Windows path. */
function pathKey(path) {
	return path.toLowerCase();
}
/** True when `child` equals `parent` or is a strict descendant of it. */
function isWithin$1(childKey, parentKey) {
	return childKey === parentKey || childKey.startsWith(`${parentKey}\\`);
}
/**
* Map a container path to its host path through the longest matching bind
* mount destination. Returns `null` when no mount covers the path (the path
* is container-private and has no host spelling).
* @param containerPath - absolute container path.
* @param mounts - the container's bind mounts.
* @returns the host path, or null when outside every mount.
*/
function mapContainerToHost(containerPath, mounts) {
	const normalized = normalizeWindowsPath(containerPath);
	const nk = pathKey(normalized);
	let best = null;
	let bestLen = -1;
	for (const mount of mounts) {
		const dst = normalizeWindowsPath(mount.destination);
		if (isWithin$1(nk, pathKey(dst)) && dst.length > bestLen) {
			bestLen = dst.length;
			best = mount;
		}
	}
	if (best === null) return null;
	const src = normalizeWindowsPath(best.source);
	const dst = normalizeWindowsPath(best.destination);
	const rest = normalized.slice(dst.length).replace(/^\\/, "");
	return rest === "" ? src : `${src}\\${rest}`;
}
/**
* Map a host path back to a container path through the longest matching bind
* mount source. Returns `null` when no mount's source covers the path.
* @param hostPath - absolute host path.
* @param mounts - the container's bind mounts.
* @returns the container path, or null when outside every mount.
*/
function mapHostToContainer(hostPath, mounts) {
	const normalized = normalizeWindowsPath(hostPath);
	const nk = pathKey(normalized);
	let best = null;
	let bestLen = -1;
	for (const mount of mounts) {
		const src = normalizeWindowsPath(mount.source);
		if (isWithin$1(nk, pathKey(src)) && src.length > bestLen) {
			bestLen = src.length;
			best = mount;
		}
	}
	if (best === null) return null;
	const src = normalizeWindowsPath(best.source);
	const dst = normalizeWindowsPath(best.destination);
	const rest = normalized.slice(src.length).replace(/^\\/, "");
	return rest === "" ? dst : `${dst}\\${rest}`;
}
/**
* Join a container root and a relative remainder into a full container path.
* @param root - normalized container root (e.g. `C:\workspace\pyscript`).
* @param name - a single path segment (no separators).
* @returns the child container path.
*/
function containerChildPath(root, name) {
	const base = normalizeWindowsPath(root);
	return base === `${base[0]}:\\` ? `${base}${name}` : `${base}\\${name}`;
}
/**
* Whether a container path is a strict ancestor of at least one bind-mount
* destination (e.g. `C:\workspace` contains `C:\workspace\pyscript`). Such a
* path is a valid workspace root even though it is not itself a mount.
* @param containerPath - absolute container path.
* @param mounts - the container's bind mounts.
* @returns whether some mount destination is a strict descendant of the path.
*/
function containsMount(containerPath, mounts) {
	const key = normalizeWindowsPath(containerPath).toLowerCase();
	for (const mount of mounts) if (normalizeWindowsPath(mount.destination).toLowerCase().startsWith(`${key}\\`)) return true;
	return false;
}
/** Container name shape for `docker exec`/`docker inspect` (one safe token). */
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/**
* Whether a value is a safe container name. Strict on purpose: the value is
* passed as a `docker exec`/`docker inspect` argv element, so separators,
* leading dashes, and whitespace are rejected.
* @param value - candidate container name.
* @returns whether it matches the container-name shape.
*/
function isValidContainerName(value) {
	return CONTAINER_PATTERN.test(value);
}
/** Executable name shape for the container shell (`powershell.exe`, `pwsh`, `cmd`). */
const SHELL_PATTERN = /^[A-Za-z0-9_.-]+(?:\.exe)?$/i;
/**
* Whether a value is a safe in-container shell executable. The value becomes a
* `docker exec` argv element, so no separators, spaces, or option-looking
* tokens are allowed.
* @param value - candidate shell name.
* @returns whether it matches the shell-executable shape.
*/
function isValidShellName(value) {
	return SHELL_PATTERN.test(value);
}
//#endregion
//#region src/shared/win-docker-workspaces.ts
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
/** The store file lives under the harness home so both host halves share it. */
function storePath() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(dshHome, "win-docker-workspaces.json");
}
/** The anchors directory (`<dshHome>/win-docker-workspaces/<container>/...`). */
function anchorsRoot() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(dshHome, "win-docker-workspaces");
}
/** Read the store; a missing or corrupt file reads as empty (never throws). */
function readStore() {
	try {
		const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/** Write the store atomically enough for a single-writer host process. */
function writeStore(store) {
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}
/** Canonicalize any accepted container-path spelling into the store's key form. */
function canonicalContainerPath(path) {
	if (!/^[A-Za-z]:[\\/]/.test(path)) return null;
	return normalizeWindowsPath(path);
}
/** The container-path segment list of a normalized Windows path (`C:\a\b` → `['C','a','b']`). */
function pathSegments(normalized) {
	return [normalized.slice(0, 1), ...normalized.slice(2).split("\\").filter((segment) => segment !== "")];
}
/** The workspace root container path a row covers (legacy rows: the key). */
function containerPathOf(entry, key) {
	return entry.containerPath !== void 0 ? normalizeWindowsPath(entry.containerPath) : normalizeWindowsPath(key);
}
/** The host anchor directory of one (container, containerPath) workspace. */
function anchorPathFor(container, containerPath) {
	return join(anchorsRoot(), container, ...pathSegments(normalizeWindowsPath(containerPath)));
}
/** True when a row is anchor-typed (its key is a host anchor, not a container path). */
function isAnchorRow(entry) {
	return entry.containerPath !== void 0;
}
/** Case-insensitive longest-prefix match of `path` over `roots`. */
function longestPrefixMatch(path, roots) {
	const normalized = normalizeWindowsPath(path);
	const key = normalized.toLowerCase();
	let best = null;
	let bestLen = -1;
	for (const root of roots) {
		const rootNormalized = normalizeWindowsPath(root);
		const rootLower = rootNormalized.toLowerCase();
		if ((key === rootLower || key.startsWith(`${rootLower}\\`)) && rootNormalized.length > bestLen) {
			bestLen = rootNormalized.length;
			best = rootNormalized;
		}
	}
	if (best === null) return null;
	const remainder = normalized.slice(best.length).replace(/^\\/, "");
	return {
		root: best,
		remainder
	};
}
/** The stored row for a key, tolerating rows whose entry is malformed. */
function rowFor(store, key) {
	const entry = store[key];
	if (entry === null || typeof entry !== "object") return void 0;
	const record = entry;
	if (typeof record.container !== "string") return void 0;
	return {
		key,
		entry: record
	};
}
/** All valid stored rows (anchor and legacy). */
function listRecords() {
	const store = readStore();
	const records = [];
	for (const key of Object.keys(store)) {
		const row = rowFor(store, key);
		if (row !== void 0) records.push(row);
	}
	return records;
}
/**
* Resolve a host path that falls under a stored workspace anchor (the DSH
* workspace path / session cwd, or any path below it).
* @param path - the candidate host path.
* @returns the covering anchor row and the relative remainder, or undefined.
*/
function resolveAnchorPath(path) {
	const match = longestPrefixMatch(normalizeWindowsPath(path), listRecords().filter((record) => isAnchorRow(record.entry)).map((record) => record.key));
	if (match === null) return void 0;
	const row = rowFor(readStore(), match.root);
	if (row === void 0) return void 0;
	return {
		entry: row.entry,
		anchor: match.root,
		remainder: match.remainder
	};
}
/** True when `child` equals or descends from `parent` (case-insensitive). */
function isWithin(child, parent) {
	const childKey = child.toLowerCase();
	const parentKey = parent.toLowerCase();
	return childKey === parentKey || childKey.startsWith(`${parentKey}\\`);
}
/**
* Every stored row whose workspace root covers a container path.
* @param containerPath - the container path to look up.
* @returns the covering rows (anchor rows by `containerPath`, legacy rows by key).
*/
function containerOwners(containerPath) {
	const normalized = normalizeWindowsPath(containerPath);
	return listRecords().filter((record) => isWithin(normalized, containerPathOf(record.entry, record.key)));
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
function getWorkspace(path) {
	const anchor = resolveAnchorPath(path);
	if (anchor !== void 0) return anchor.entry;
	const owners = containerOwners(path);
	return owners.length === 1 ? owners[0].entry : void 0;
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
function setWorkspace(containerPath, container, shell) {
	const normalized = canonicalContainerPath(containerPath);
	if (normalized === null) throw new Error("docker-workspace: workspace path is not a Windows container path");
	const containerName = container.trim();
	if (!isValidContainerName(containerName)) throw new Error("docker-workspace: container must match the name pattern [A-Za-z0-9][A-Za-z0-9_.-]*");
	const anchor = anchorPathFor(containerName, normalized);
	const store = readStore();
	const entry = {
		container: containerName,
		containerPath: normalized
	};
	if (shell !== void 0 && shell.trim() !== "") {
		const shellName = shell.trim();
		if (!isValidShellName(shellName)) throw new Error("docker-workspace: shell must be a plain executable name (e.g. powershell.exe)");
		entry.shell = shellName;
	}
	for (const key of Object.keys(store)) {
		const row = rowFor(store, key);
		if (row === void 0 || isAnchorRow(row.entry)) continue;
		if (normalizeWindowsPath(key) === normalized && row.entry.container === containerName) delete store[key];
	}
	store[anchor] = entry;
	mkdirSync(anchor, { recursive: true });
	writeStore(store);
	return anchor;
}
/**
* List the stored workspace roots: anchor host paths for anchor rows and the
* container path itself for legacy rows. The client's mode-variant predicate
* matches session cwds against this set, and a session cwd is always one of
* these two spellings.
* @returns the canonical workspace roots.
*/
function listWorkspaces() {
	return listRecords().map((record) => normalizeWindowsPath(record.key));
}
//#endregion
export { listWorkspaces as a, containerChildPath as c, isValidShellName as d, isWindowsDrivePath as f, normalizeWindowsPath as h, listRecords as i, containsMount as l, mapHostToContainer as m, containerPathOf as n, resolveAnchorPath as o, mapContainerToHost as p, getWorkspace as r, setWorkspace as s, containerOwners as t, isValidContainerName as u };

//# sourceMappingURL=win-docker-workspaces-BeycJyLC.js.map