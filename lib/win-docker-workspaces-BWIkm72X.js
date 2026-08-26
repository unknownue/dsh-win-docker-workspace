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
function isWithin(childKey, parentKey) {
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
		if (isWithin(nk, pathKey(dst)) && dst.length > bestLen) {
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
		if (isWithin(nk, pathKey(src)) && src.length > bestLen) {
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
* container name (and optional shell) of each Docker workspace under the
* harness home; the shell executor, the filesystem provider, and the per-session
* env contributor read it back to resolve which container a container path
* belongs to. Keys are canonical container paths (workspace roots). This module
* touches node builtins, so the browser half never imports it.
* @module dsh-win-docker-workspace/shared/win-docker-workspaces
*/
/** The store file lives under the harness home so both host halves share it. */
function storePath() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(dshHome, "win-docker-workspaces.json");
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
/**
* Read the stored workspace facts for a container path (longest-key prefix
* match, so a deep path resolves to its workspace root).
* @param containerPath - the container path (any accepted spelling).
* @returns the workspace entry, or undefined when none covers the path.
*/
function getWorkspace(containerPath) {
	const key = normalizeWindowsPath(containerPath).toLowerCase();
	const store = readStore();
	let bestKey;
	let bestLen = -1;
	for (const storedKey of Object.keys(store)) {
		const storedNormalized = normalizeWindowsPath(storedKey);
		const storedLower = storedNormalized.toLowerCase();
		if ((key === storedLower || key.startsWith(`${storedLower}\\`)) && storedNormalized.length > bestLen) {
			bestLen = storedNormalized.length;
			bestKey = storedKey;
		}
	}
	return bestKey === void 0 ? void 0 : store[bestKey];
}
/**
* Store (or clear) the container/shell facts of a Docker workspace.
* @param containerPath - the workspace root container path.
* @param container - the container name.
* @param shell - optional in-container shell; empty clears the stored value.
*/
function setWorkspace(containerPath, container, shell) {
	const key = canonicalContainerPath(containerPath);
	if (key === null) throw new Error("docker-workspace: workspace path is not a Windows container path");
	const containerName = container.trim();
	if (!isValidContainerName(containerName)) throw new Error("docker-workspace: container must match the name pattern [A-Za-z0-9][A-Za-z0-9_.-]*");
	const store = readStore();
	if (shell === void 0 || shell.trim() === "") store[key] = { container: containerName };
	else {
		const shellName = shell.trim();
		if (!isValidShellName(shellName)) throw new Error("docker-workspace: shell must be a plain executable name (e.g. powershell.exe)");
		store[key] = {
			container: containerName,
			shell: shellName
		};
	}
	writeStore(store);
}
/**
* List the stored workspace roots (canonical container paths), for the dialog
* and the client's mode-variant predicate.
* @returns the canonical container paths.
*/
function listWorkspaces() {
	return Object.keys(readStore()).map(normalizeWindowsPath);
}
//#endregion
export { containsMount as a, isWindowsDrivePath as c, normalizeWindowsPath as d, containerChildPath as i, mapContainerToHost as l, listWorkspaces as n, isValidContainerName as o, setWorkspace as r, isValidShellName as s, getWorkspace as t, mapHostToContainer as u };

//# sourceMappingURL=win-docker-workspaces-BWIkm72X.js.map