import { n as inspectMountsSync, r as listContainerDirSync, t as checkContainerPathSync } from "./docker-BTUBNd08.js";
import { c as isWindowsDrivePath, d as normalizeWindowsPath, i as containerChildPath, l as mapContainerToHost, n as listWorkspaces, t as getWorkspace, u as mapHostToContainer } from "./win-docker-workspaces-BWIkm72X.js";
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
var DockerFileSystem = class extends LocalFileSystem {
	static Config = z.object({
		cwd: z.string(),
		container: z.string(),
		diffBasisMaxBytes: z.number().default(10485760)
	});
	container;
	constructor(ctx, config) {
		super(ctx, config);
		this.container = config.container;
	}
	/** Every container name this backend knows: the store's workspaces plus config. */
	containerNames() {
		const names = /* @__PURE__ */ new Set();
		for (const key of listWorkspaces()) {
			const entry = getWorkspace(key);
			if (entry !== void 0) names.add(entry.container);
		}
		if (this.container !== void 0 && this.container !== "") names.add(this.container);
		return [...names];
	}
	/** The container a container path belongs to: store first, then config. */
	containerFor(path) {
		const entry = getWorkspace(path);
		if (entry !== void 0) return entry.container;
		if (this.container !== void 0 && this.container !== "") return this.container;
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
	/** Resolve a model/plugin path into an absolute container path plus its container. */
	resolveContainerPath(path, cwd) {
		if (isWindowsDrivePath(path)) return {
			container: this.containerFor(path),
			containerPath: normalizeWindowsPath(path)
		};
		const base = cwd ?? this.config.cwd;
		if (base === void 0 || base === "" || !isWindowsDrivePath(base)) throw new FsError("docker-fs: relative path needs a container-path cwd or configured base", "FS_IO_ERROR");
		const combined = normalizeWindowsPath(`${normalizeWindowsPath(base)}\\${path}`);
		return {
			container: this.containerFor(base),
			containerPath: combined
		};
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
		if (parsed === null) return super.listDir(target, signal);
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
};
//#endregion
export { DockerFileSystem, DockerFileSystem as default };

//# sourceMappingURL=fs.js.map