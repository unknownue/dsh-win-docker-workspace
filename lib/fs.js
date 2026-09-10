import { n as inspectMountsSync, r as listContainerDirSync, t as checkContainerPathSync } from "./docker-BTUBNd08.js";
import { c as containerChildPath, f as isWindowsDrivePath, h as normalizeWindowsPath, i as listRecords, m as mapHostToContainer, n as containerPathOf, o as resolveAnchorPath, p as mapContainerToHost, r as getWorkspace, t as containerOwners } from "./win-docker-workspaces-BeycJyLC.js";
import z from "@deepseek-ai/schemastery";
import { FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
//#region src/fs.ts
/** Prefix of a synthetic target key that names a container-only directory. */
const SYNTHETIC_PREFIX = "docker-container://";
/** Encode a container-only directory into a synthetic target key. */
function syntheticKey(container, path) {
	return `${SYNTHETIC_PREFIX}${container}/${path}`;
}
/** Decode a synthetic target key, or null for ordinary (host-path) keys. */
function parseSyntheticKey(key) {
	if (!key.startsWith(SYNTHETIC_PREFIX)) return null;
	const rest = key.slice(19);
	const slash = rest.indexOf("/");
	if (slash < 0) return null;
	return {
		container: rest.slice(0, slash),
		path: rest.slice(slash + 1)
	};
}
/**
* The Docker filesystem backend. Identity keys for mounted paths are host paths
* (the local backend's realpath/atomic-write mechanics stay correct); the
* container form is derived on demand. Container-only directories use a
* synthetic key and are list-only.
*/
var DockerFileSystem = class DockerFileSystem extends LocalFileSystem {
	static Config = z.object({
		cwd: z.string(),
		container: z.string(),
		diffBasisMaxBytes: z.number().default(10485760)
	});
	container;
	/**
	* Host targetKey → container, recorded at `resolve` time. The container is
	* per-session (each session runs its own `fs-docker` instance) and the host
	* key is unique within a session, so `listDir` can look the owning container
	* back up to union the bind mounts the container overlays on a mount source
	* (e.g. `code`/`assets` nested under the `C:\workspace` root mount) that the
	* host source alone does not contain.
	*/
	containerByKey = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, config);
		this.container = config.container;
	}
	/** Every container name this backend knows: the store's workspaces plus config. */
	containerNames() {
		const names = /* @__PURE__ */ new Set();
		for (const record of listRecords()) names.add(record.entry.container);
		if (this.container !== void 0 && this.container !== "") names.add(this.container);
		return [...names];
	}
	/** Join a normalized container root with a relative remainder ('' keeps the root). */
	static joinContainer(root, remainder) {
		return remainder === "" ? normalizeWindowsPath(root) : normalizeWindowsPath(`${normalizeWindowsPath(root)}\\${remainder}`);
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
	resolveContainerPath(path, cwd) {
		const anchorOfCwd = cwd !== void 0 ? resolveAnchorPath(cwd) : void 0;
		if (anchorOfCwd !== void 0) {
			const root = containerPathOf(anchorOfCwd.entry, anchorOfCwd.anchor);
			if (!isWindowsDrivePath(path)) return {
				container: anchorOfCwd.entry.container,
				containerPath: DockerFileSystem.joinContainer(root, path)
			};
			const anchorOfPath = resolveAnchorPath(path);
			if (anchorOfPath !== void 0) {
				const pathRoot = containerPathOf(anchorOfPath.entry, anchorOfPath.anchor);
				return {
					container: anchorOfPath.entry.container,
					containerPath: DockerFileSystem.joinContainer(pathRoot, anchorOfPath.remainder)
				};
			}
			return {
				container: anchorOfCwd.entry.container,
				containerPath: normalizeWindowsPath(path)
			};
		}
		if (isWindowsDrivePath(path)) {
			const anchorOfPath = resolveAnchorPath(path);
			if (anchorOfPath !== void 0) {
				const pathRoot = containerPathOf(anchorOfPath.entry, anchorOfPath.anchor);
				return {
					container: anchorOfPath.entry.container,
					containerPath: DockerFileSystem.joinContainer(pathRoot, anchorOfPath.remainder)
				};
			}
			const entry = getWorkspace(path);
			if (entry !== void 0) return {
				container: entry.container,
				containerPath: normalizeWindowsPath(path)
			};
			if (this.container !== void 0 && this.container !== "") return {
				container: this.container,
				containerPath: normalizeWindowsPath(path)
			};
			const owners = containerOwners(path);
			const detail = owners.length > 1 ? `; it is shared by containers ${owners.map((owner) => owner.entry.container).join(", ")} — add each workspace again through the Docker workspace dialog so every container gets its own workspace` : "";
			throw new FsError(`docker-fs: container path "${path}" carries no container${detail} and none is configured`, "FS_IO_ERROR");
		}
		const base = this.config.cwd;
		if (base === void 0 || base === "" || !isWindowsDrivePath(base)) throw new FsError("docker-fs: relative path needs a container-path cwd or configured base", "FS_IO_ERROR");
		const anchorOfBase = resolveAnchorPath(base);
		if (anchorOfBase !== void 0) {
			const root = containerPathOf(anchorOfBase.entry, anchorOfBase.anchor);
			return {
				container: anchorOfBase.entry.container,
				containerPath: DockerFileSystem.joinContainer(root, path)
			};
		}
		const combined = normalizeWindowsPath(`${normalizeWindowsPath(base)}\\${path}`);
		const entry = getWorkspace(base);
		if (entry !== void 0) return {
			container: entry.container,
			containerPath: combined
		};
		if (this.container !== void 0 && this.container !== "") return {
			container: this.container,
			containerPath: combined
		};
		throw new FsError("docker-fs: container path carries no container and none is configured", "FS_IO_ERROR");
	}
	/** Map a host path back to a container path through any known container. */
	hostToContainer(hostPath) {
		for (const name of this.containerNames()) {
			const mapped = mapHostToContainer(hostPath, inspectMountsSync(name));
			if (mapped !== null) return mapped;
		}
		return null;
	}
	/** The container path of a resolved target (synthetic or host-backed), or null. */
	targetContainerPath(target) {
		const key = String(target.targetKey);
		const parsed = parseSyntheticKey(key);
		if (parsed !== null) return parsed.path;
		return this.hostToContainer(key);
	}
	async resolve(path, opts) {
		if (opts?.signal?.aborted) throw new FsError("resolve aborted", "FS_ABORTED");
		const { container, containerPath } = this.resolveContainerPath(path, opts?.cwd);
		const host = mapContainerToHost(containerPath, inspectMountsSync(container));
		if (host !== null) {
			const local = await super.resolve(host, {
				cwd: process.cwd(),
				...opts?.signal !== void 0 ? { signal: opts.signal } : {}
			});
			this.containerByKey.set(String(local.targetKey), container);
			const display = this.hostToContainer(String(local.displayPath)) ?? containerPath;
			return {
				targetKey: local.targetKey,
				displayPath: display
			};
		}
		const check = checkContainerPathSync(container, containerPath);
		if (!check.exists || !check.isDirectory) throw new FsError(`docker-fs: path "${path}" does not exist or is not a directory`, "FS_NOT_FOUND");
		return {
			targetKey: FsTargetKey(syntheticKey(container, containerPath)),
			displayPath: containerPath
		};
	}
	processPath(target) {
		const container = this.targetContainerPath(target);
		if (container === null) throw new FsError(`docker-fs: target "${target.displayPath}" is outside the container's bind mounts`, "FS_IO_ERROR");
		return container;
	}
	fileUrl(target) {
		return `file:///${this.processPath(target).replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
	}
	contains(parent, child) {
		const parentContainer = this.targetContainerPath(parent);
		const childContainer = this.targetContainerPath(child);
		if (parentContainer === null || childContainer === null) return false;
		const parentKey = normalizeWindowsPath(parentContainer).toLowerCase();
		const childKey = normalizeWindowsPath(childContainer).toLowerCase();
		if (childKey === parentKey) return true;
		return childKey.startsWith(`${parentKey}\\`);
	}
	async stat(target, signal) {
		const parsed = parseSyntheticKey(String(target.targetKey));
		if (parsed === null) return super.stat(target, signal);
		const check = checkContainerPathSync(parsed.container, parsed.path);
		if (!check.exists) return void 0;
		return {
			version: FsVersion(syntheticKey(parsed.container, parsed.path)),
			type: check.isDirectory ? "directory" : "other"
		};
	}
	async lstat(path, opts, signal) {
		if (signal?.aborted) throw new FsError("lstat aborted", "FS_ABORTED");
		if (path.trim().length === 0) throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
		const { container, containerPath } = this.resolveContainerPath(path, opts?.cwd);
		const host = mapContainerToHost(containerPath, inspectMountsSync(container));
		if (host === null) {
			const check = checkContainerPathSync(container, containerPath);
			if (!check.exists) return void 0;
			return {
				version: FsVersion(syntheticKey(container, containerPath)),
				type: check.isDirectory ? "directory" : "other"
			};
		}
		return super.lstat(host, { cwd: process.cwd() }, signal);
	}
	async listDir(target, signal) {
		const parsed = parseSyntheticKey(String(target.targetKey));
		if (parsed === null) {
			const entries = await super.listDir(target, signal);
			const container = this.containerByKey.get(String(target.targetKey));
			return container === void 0 ? entries : this.unionMountOverlay(container, target, entries, signal);
		}
		const entries = listContainerDirSync(parsed.container, parsed.path);
		const result = [];
		for (const entry of entries) {
			const childPath = containerChildPath(parsed.path, entry.name);
			const childTarget = await this.resolve(childPath, signal !== void 0 ? { signal } : {});
			result.push({
				name: entry.name,
				type: entry.kind === "directory" ? "directory" : entry.kind === "file" ? "file" : "other",
				target: childTarget
			});
		}
		return result;
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
	async unionMountOverlay(container, target, entries, signal) {
		const mounts = inspectMountsSync(container);
		const containerPath = mapHostToContainer(String(target.targetKey), mounts);
		if (containerPath === null) return entries;
		const containerKey = normalizeWindowsPath(containerPath).toLowerCase();
		for (const mount of mounts) {
			const dest = normalizeWindowsPath(mount.destination);
			const destKey = dest.toLowerCase();
			if (destKey === containerKey || !destKey.startsWith(`${containerKey}\\`)) continue;
			const top = dest.slice(containerPath.length).replace(/^\\/, "").split("\\")[0];
			if (top === "" || entries.some((entry) => entry.name.toLowerCase() === top.toLowerCase())) continue;
			const hostChild = mapContainerToHost(dest, mounts);
			if (hostChild === null) continue;
			const local = await super.resolve(hostChild, {
				cwd: process.cwd(),
				...signal !== void 0 ? { signal } : {}
			});
			this.containerByKey.set(String(local.targetKey), container);
			entries.push({
				name: top,
				type: "directory",
				target: {
					targetKey: local.targetKey,
					displayPath: dest
				}
			});
		}
		return entries.sort((a, b) => {
			const aDir = a.type === "directory" ? 0 : 1;
			const bDir = b.type === "directory" ? 0 : 1;
			if (aDir !== bDir) return aDir - bDir;
			const an = a.name.toLowerCase();
			const bn = b.name.toLowerCase();
			return an < bn ? -1 : an > bn ? 1 : 0;
		});
	}
};
//#endregion
export { DockerFileSystem, DockerFileSystem as default };

//# sourceMappingURL=fs.js.map