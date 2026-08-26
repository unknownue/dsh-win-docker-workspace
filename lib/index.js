import { i as listContainers, n as inspectMountsSync, r as listContainerDirSync, t as checkContainerPathSync } from "./docker-BTUBNd08.js";
import { a as containsMount, c as isWindowsDrivePath, d as normalizeWindowsPath, l as mapContainerToHost, n as listWorkspaces, o as isValidContainerName, r as setWorkspace, s as isValidShellName, t as getWorkspace } from "./win-docker-workspaces-BWIkm72X.js";
import z from "@deepseek-ai/schemastery";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
//#region src/host/variants.ts
/**
* Docker preset-variant generator. For every healthy source preset the roster
* supplies, a `win-docker-<id>` variant is materialized under the roster's user
* root: the source composition with its shell/filesystem world replaced by the
* Docker providers, so any mode (standard, minimal, code, cordis, user
* presets) can run on top of a Docker execution world. The execution world is
* therefore orthogonal to the mode instead of a mode itself.
*
* The transformation is text-level on the top-level rows of the composition
* (the shape all shipped presets share), with surgical edits for the known
* special groups; unknown shapes are kept verbatim where possible.
* @module dsh-win-docker-workspace/host/variants
*/
/** Top-level rows that name the execution world and are replaced by the variant's own. */
const WORLD_ROWS = /* @__PURE__ */ new Set([
	"tool-bash",
	"tool-pwsh",
	"tool-fs",
	"tool-fs-search",
	"filesystem",
	"persistent-shell"
]);
/** The injected Docker world group: providers + the pwsh/fs consumers, entry-local. */
function dockerWorldGroup(shellPath, fsPath, includeEditor) {
	return [
		"# ── Docker execution world (dsh-win-docker-workspace variant) ───────────",
		"# The shell and fs services are provided entry-locally (the isolate",
		"# realm); host services (tools registry, shell-env, jobs) fall through.",
		"# tool-fs-search is intentionally absent: the packaged ripgrep runs on",
		"# the Windows host and cannot open container paths; Docker sessions",
		"# search with shell tools instead.",
		"- id: docker-world",
		"  name: cordis:group",
		"  group: true",
		"  isolate:",
		"    shell: true",
		"    fs: true",
		"  config:",
		"    - id: shell-docker",
		`      name: '${shellPath.replace(/'/g, "''")}'`,
		"    - id: fs-docker",
		`      name: '${fsPath.replace(/'/g, "''")}'`,
		"    - id: tool-pwsh",
		"      name: '@deepseek-ai/dsh-tool-pwsh'",
		"    - id: tool-fs",
		"      name: '@deepseek-ai/dsh-tool-fs'",
		...includeEditor ? [
			"    - id: str-replace-editor",
			"      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
			"      config:",
			"        maxOutputChars: 16000"
		] : [],
		""
	].join("\n");
}
/** The sentence appended to a standard-like persona when the variant runs in Docker. */
const PERSONA_APPEND = " Your working directory {{cwd}} is inside a Windows Docker container: the pwsh tool and the file read/write/edit tools use container paths (like C:\\workspace\\...), and the files are bind-mounted source directories on the host.";
/** The top-level rows of one composition, as (startLine, endLineExclusive) spans. */
function topLevelSpans(lines) {
	const spans = [];
	let start = -1;
	for (let index = 0; index < lines.length; index++) if (lines[index]?.startsWith("- id: ") === true) {
		if (start >= 0) spans.push({
			start,
			end: index
		});
		start = index;
	}
	if (start >= 0) spans.push({
		start,
		end: lines.length
	});
	return spans;
}
/** The row id of a top-level span, or undefined when the first line is malformed. */
function spanId(lines, span) {
	return /^- id: ([A-Za-z0-9_.-]+)/.exec(lines[span.start] ?? "")?.[1];
}
/** Whether a top-level span is a `persona` row with an appendable folded text. */
function appendablePersona(lines, span) {
	const block = lines.slice(span.start, span.end).join("\n");
	if (!block.includes("complete: true") && /text: [>|-]/.test(block)) {
		const textLine = block.split("\n").find((line) => /^(\s*)text: [>|-]/.test(line));
		if (textLine !== void 0) {
			const indent = /^(\s*)/.exec(textLine)?.[1]?.length ?? 0;
			return block.split("\n").some((line) => line.length > indent && /^\s+/.test(line) && !line.includes(":"));
		}
	}
	return false;
}
/** Append the Docker sentence to a persona row's folded text (in place of its last text line). */
function appendPersona(lines, span) {
	const block = lines.slice(span.start, span.end);
	const textIndex = block.findIndex((line) => /^(\s*)text: [>|-]/.test(line));
	if (textIndex < 0) return [...block];
	const indent = /^(\s*)/.exec(block[textIndex] ?? "")?.[1]?.length ?? 0;
	let lastText = -1;
	for (let index = textIndex + 1; index < block.length; index++) {
		const line = block[index] ?? "";
		if (line.trim() === "") continue;
		if (line.length > indent && /^\s+/.test(line)) lastText = index;
	}
	if (lastText < 0) return [...block];
	const updated = [...block];
	const textIndent = /^(\s*)/.exec(block[lastText] ?? "")?.[1] ?? "  ";
	updated.splice(lastText + 1, 0, `${textIndent}${PERSONA_APPEND}`);
	return updated;
}
/**
* Transform one source preset composition into its Docker variant: drop the
* execution-world rows, keep everything else verbatim, and append the Docker
* world group. The persistent-shell group is dropped without replacement
* (deferred: `docker exec -it` PTY terminal support).
* @param source - the source composition text.
* @param shellPath - absolute path of the plugin's built Docker shell provider.
* @param fsPath - absolute path of the plugin's built Docker fs provider.
* @returns the variant composition text.
*/
function transformPresetForDocker(source, shellPath, fsPath) {
	const lines = source.split("\n");
	const spans = topLevelSpans(lines);
	const kept = [];
	let sawEditor = false;
	let personaAppended = false;
	for (const span of spans) {
		const id = spanId(lines, span);
		if (id === void 0) {
			kept.push(...lines.slice(span.start, span.end));
			continue;
		}
		if (WORLD_ROWS.has(id)) continue;
		if (id === "persona" && !personaAppended && appendablePersona(lines, span)) {
			kept.push(...appendPersona(lines, span));
			personaAppended = true;
			continue;
		}
		kept.push(...lines.slice(span.start, span.end));
		if (id === "str-replace-editor") sawEditor = true;
	}
	if (source.includes("str-replace-editor")) sawEditor = true;
	const result = [...kept];
	if (result.length > 0 && result[result.length - 1] !== "") result.push("");
	result.push(dockerWorldGroup(shellPath, fsPath, sawEditor));
	return result.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}
/** Whether an id is one of this plugin's own preset directories. */
function isDockerVariantId(id) {
	return /^win-docker-[a-z0-9-]+$/.test(id);
}
/** Whether an id is another execution world's variant (the WSL plugin's `wsl-*`). */
function isForeignVariantId(id) {
	return id === "wsl" || /^wsl-[a-z0-9-]+$/.test(id);
}
/** The variant id for one source preset id. */
function variantIdFor(sourceId) {
	return `win-docker-${sourceId.toLowerCase()}`;
}
//#endregion
//#region src/index.ts
/** The HTTP route this plugin serves (a relative, same-origin path). */
const DEFAULT_ROUTE = "/win-docker-workspace/api";
/**
* Bilingual display labels for the shipped source modes, matching the app's
* own built-in copy in each language. The DSH picker localizes only the four
* built-in ids itself; `win-docker-*` variant ids render the preset.yml text
* verbatim, so the plugin writes one bilingual string so both locales can
* identify each variant. Custom presets keep their own name.
*/
const MODE_DISPLAY_LABELS = {
	standard: {
		en: "Standard mode",
		zh: "标准模式"
	},
	code: {
		en: "Code mode",
		zh: "PTC 模式"
	},
	minimal: {
		en: "Minimal mode",
		zh: "极简模式"
	},
	cordis: {
		en: "Creator mode",
		zh: "创造模式"
	}
};
/**
* Quote a value as a single-line YAML single-quoted scalar. Plain scalars
* cannot contain `: ` (colon + space), which plain English sentences do —
* written unquoted they make the whole preset.yml unparsable, dropping the
* name, description and order together.
*/
function yamlScalar(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
/** The variant name for one shipped mode (bilingual) or a custom preset. */
function variantName(presetId, sourceName) {
	const labels = MODE_DISPLAY_LABELS[presetId];
	return labels === void 0 ? `Docker · ${sourceName}` : `Docker · ${labels.en}（${labels.zh}）`;
}
/** The variant description for one shipped mode (bilingual) or a custom preset. */
function variantDescription(presetId) {
	const labels = MODE_DISPLAY_LABELS[presetId];
	return `Docker execution world for ${labels === void 0 ? presetId : `${labels.en}（${labels.zh}）`}: pwsh and file tools run inside the Windows container.`;
}
const MAX_BODY_BYTES = 1048576;
/** The loopback hostnames the data route answers to (DNS-rebinding fence). */
const LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/** True when a socket address is loopback (any IPv4/IPv6 spelling). */
function isLoopback(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** The hostname part of a `Host` header value (port and IPv6 brackets stripped). */
function hostNameOf(host) {
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end >= 0 ? host.slice(1, end) : host;
	}
	return host.split(":")[0] ?? "";
}
/** True when the request's `Host` header names a loopback host. */
function isLoopbackHost(host) {
	return host !== void 0 && LOOPBACK_HOSTNAMES.has(hostNameOf(host).toLowerCase());
}
/** Human text for an unknown rejection. */
function messageOf(value) {
	return value instanceof Error ? value.message : String(value);
}
/** Write one JSON envelope. */
function json(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(body));
}
/** Collect and parse the request body, bounded. */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
		chunks.push(buffer);
	}
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}
/**
* Validate a wire-supplied container name before it becomes a `docker exec`/
* `docker inspect` argv element.
* @param value - the raw wire value.
* @returns the validated container name.
*/
function requireContainer(value) {
	if (typeof value !== "string" || !isValidContainerName(value)) throw new Error("container must match the name pattern [A-Za-z0-9][A-Za-z0-9_.-]*");
	return value;
}
/** Validate a wire-supplied workspace path and return its canonical container form. */
function requireContainerPath(value) {
	if (typeof value !== "string" || !isWindowsDrivePath(value)) throw new Error("path must be an absolute Windows container path (C:\\...)");
	return normalizeWindowsPath(value);
}
/** Validate a wire-supplied shell executable name. */
function requireShell(value) {
	if (typeof value !== "string" || !isValidShellName(value)) throw new Error("shell must be a plain executable name (e.g. powershell.exe)");
	return value;
}
/** Resolve one directory listing inside the container (full filesystem via docker exec). */
function listDockerDir(container, path) {
	const normalized = normalizeWindowsPath(path);
	const entries = listContainerDirSync(container, normalized).slice(0, 1e3).map((entry) => ({
		name: entry.name,
		kind: entry.kind
	})).sort((a, b) => {
		if (a.kind === "directory" && b.kind !== "directory") return -1;
		if (a.kind !== "directory" && b.kind === "directory") return 1;
		return a.name.localeCompare(b.name);
	});
	const parentPath = dirname(normalized);
	return {
		path: normalized,
		parent: parentPath === normalized ? null : parentPath,
		entries
	};
}
/** Resolve one existence/directory check inside the container, plus the bind-mount facts. */
function checkDockerPath(container, path) {
	const normalized = normalizeWindowsPath(path);
	const check = checkContainerPathSync(container, normalized);
	const mounts = inspectMountsSync(container);
	const inBindMount = mapContainerToHost(normalized, mounts) !== null;
	const containsMounts = containsMount(normalized, mounts);
	return {
		...check,
		inBindMount,
		containsMounts
	};
}
/** Route one method dispatch. */
async function dispatch(method, params) {
	switch (method) {
		case "listContainers": return listContainers();
		case "listMounts": {
			const container = requireContainer(params.container);
			return inspectMountsSync(container).map((mount) => ({
				source: mount.source,
				destination: mount.destination
			}));
		}
		case "listDir": return listDockerDir(requireContainer(params.container), requireContainerPath(params.path));
		case "check": return checkDockerPath(requireContainer(params.container), requireContainerPath(params.path));
		case "setWorkspace": {
			const path = requireContainerPath(params.path);
			const container = requireContainer(params.container);
			const shell = params.shell === void 0 || params.shell === "" ? void 0 : requireShell(params.shell);
			setWorkspace(path, container, shell);
			return null;
		}
		case "ensurePath": {
			const path = requireContainerPath(params.path);
			mkdirSync(path, { recursive: true });
			return null;
		}
		case "listWorkspaces": return listWorkspaces();
		default: throw new Error(`unknown method "${method}"`);
	}
}
/**
* Materialize a `win-docker-<mode>` variant for every healthy source preset,
* and remove this plugin's managed residue: stale variants whose source
* disappeared. Managed files: rewritten on every boot.
* @param agentPresets - the roster service.
* @param dshHome - the harness home (user preset root parent).
* @param shellPath - absolute path of the plugin's built Docker shell provider.
* @param fsPath - absolute path of the plugin's built Docker fs provider.
*/
async function materializeVariants(agentPresets, dshHome, shellPath, fsPath) {
	const presets = await agentPresets.list();
	const userRoot = join(dshHome, ".agent-presets");
	const generated = /* @__PURE__ */ new Set();
	for (const preset of presets) {
		if (preset.broken !== void 0) continue;
		if (isDockerVariantId(preset.id)) continue;
		if (isForeignVariantId(preset.id)) continue;
		const variantId = variantIdFor(preset.id);
		const transformed = transformPresetForDocker(await agentPresets.read(preset.id), shellPath, fsPath);
		const dir = join(userRoot, variantId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "agent.cordis.yml"), transformed, "utf8");
		const labels = MODE_DISPLAY_LABELS[preset.id];
		let name = variantName(preset.id, preset.id);
		let orderLine = "";
		try {
			const meta = readFileSync(join(dirname(preset.path), "preset.yml"), "utf8");
			if (labels === void 0) {
				const match = /^name:\s*(.+)$/m.exec(meta);
				if (match?.[1] !== void 0 && match[1].trim() !== "") name = variantName(preset.id, match[1].trim());
			}
			const orderMatch = /^order:\s*(\d+)\s*$/m.exec(meta);
			if (orderMatch?.[1] !== void 0) orderLine = `order: ${orderMatch[1]}\n`;
		} catch {}
		writeFileSync(join(dir, "preset.yml"), `name: ${yamlScalar(name)}\n` + orderLine + `description: ${yamlScalar(variantDescription(preset.id))}\n`, "utf8");
		generated.add(variantId);
	}
	for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!isDockerVariantId(entry.name)) continue;
		if (!generated.has(entry.name)) rmSync(join(userRoot, entry.name), {
			recursive: true,
			force: true
		});
	}
}
/** Function-plugin plugin contract. */
const name = "dsh-win-docker-workspace";
/** Required services. */
const inject = ["webServer"];
/** Validated plugin config (schemastery applied the defaults). */
const Config = z.object({ route: z.string().default(DEFAULT_ROUTE) });
/**
* Apply the host half: materialize a `win-docker-<mode>` variant for every
* healthy roster preset, register the data route, and contribute the
* per-session `DSH_DOCKER_CONTAINER`/`DSH_DOCKER_SHELL` managed-env facts.
* @param ctx - the host plugin context.
* @param config - the validated configuration.
*/
function apply(ctx, config) {
	const resolved = config;
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const shellPath = join(packageRoot, "lib", "shell.js").replace(/\\/g, "/");
	const fsPath = join(packageRoot, "lib", "fs.js").replace(/\\/g, "/");
	const agentPresets = ctx.get("agentPresets");
	if (agentPresets !== void 0) ctx.effect(() => {
		materializeVariants(agentPresets, dshHome, shellPath, fsPath).catch((error) => {
			console.error(`dsh-win-docker-workspace: Docker preset-variant generation failed: ${messageOf(error)}`);
		});
		return () => {};
	}, "dsh-win-docker-workspace: Docker preset variants");
	const shellEnv = ctx.get("shellEnv");
	if (shellEnv !== void 0) ctx.effect(() => shellEnv.register({
		name: "win-docker-workspace-container",
		variables: {
			DSH_DOCKER_CONTAINER: { description: "The Docker container of the calling session workspace, when the session cwd is a Docker workspace path." },
			DSH_DOCKER_SHELL: { description: "The in-container shell of the calling session workspace, when the workspace has one configured." }
		},
		resolve(execution) {
			const cwd = execution.agent?.session.header.cwd;
			if (cwd === void 0) return {};
			const entry = getWorkspace(cwd);
			if (entry === void 0) return {};
			return entry.shell === void 0 || entry.shell === "" ? { DSH_DOCKER_CONTAINER: entry.container } : {
				DSH_DOCKER_CONTAINER: entry.container,
				DSH_DOCKER_SHELL: entry.shell
			};
		}
	}), "dsh-win-docker-workspace: per-session container env fact");
	const webServer = ctx.get("webServer");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: resolved.route,
		handler: async (req, res) => {
			if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
				json(res, 403, {
					ok: false,
					error: "loopback-only"
				});
				return;
			}
			if (req.method !== "POST") {
				json(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				json(res, 400, {
					ok: false,
					error: messageOf(error)
				});
				return;
			}
			const method = typeof body.method === "string" ? body.method : "";
			const params = body.params === void 0 ? {} : body.params;
			if (params === null || typeof params !== "object" || Array.isArray(params)) {
				json(res, 400, {
					ok: false,
					error: "params must be an object"
				});
				return;
			}
			try {
				json(res, 200, {
					ok: true,
					value: await dispatch(method, params)
				});
			} catch (error) {
				json(res, 200, {
					ok: false,
					error: messageOf(error)
				});
			}
		}
	}), "dsh-win-docker-workspace: dialog data route");
}
//#endregion
export { Config, DEFAULT_ROUTE, apply, inject, name };

//# sourceMappingURL=index.js.map