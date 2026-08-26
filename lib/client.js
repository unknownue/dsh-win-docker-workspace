window.__ModuleLoader__.load({ id: "dsh-win-docker-workspace", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
//#region src/client/api.ts
/**
* Thin fetch client for the Host plugin route. The browser calls
* POST /win-docker-workspace/api with a `{ method, params }` envelope and the
* Host answers `{ ok: true, value }` or `{ ok: false, error }`.
*/
/** Relative route the Host half registers (same-origin with the web server). */
const ENDPOINT = "/win-docker-workspace/api";
/** Human text for an unknown rejection. */
function errorMessage(value) {
	return value instanceof Error ? value.message : String(value);
}
/**
* Perform one POST call and unwrap the envelope.
* @param method - the Host method name.
* @param params - the method payload.
* @returns the unwrapped value, or throws an Error on network or `ok:false`.
*/
async function call(method, params = {}) {
	let response;
	try {
		response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				method,
				params
			})
		});
	} catch (error) {
		throw new Error(`win-docker-workspace request failed: ${errorMessage(error)}`);
	}
	let envelope;
	try {
		envelope = await response.json();
	} catch {
		throw new Error(`win-docker-workspace answered non-JSON (${response.status})`);
	}
	if (!envelope.ok) throw new Error(envelope.error);
	return envelope.value;
}
/**
* List the running containers on the host.
* @returns container names in `docker ps` order.
*/
async function listContainers() {
	return call("listContainers", {});
}
/**
* List one container's bind mounts.
* @param container - container name.
* @returns the bind mounts.
*/
async function listMounts(container) {
	return call("listMounts", { container });
}
/**
* List one directory level inside a container (through its bind mounts).
* @param container - container name.
* @param path - absolute container directory to list.
* @returns the level's listing with ancestry.
*/
async function listDir(container, path) {
	return call("listDir", {
		container,
		path
	});
}
/**
* Check whether a container path exists and is a directory.
* @param container - container name.
* @param path - absolute container path.
* @returns existence and directory facts.
*/
async function check(container, path) {
	return call("check", {
		container,
		path
	});
}
/**
* Store the container/shell facts of one Docker workspace.
* @param path - the workspace root container path.
* @param container - the container name.
* @param shell - optional shell; empty string clears the stored value.
*/
async function setWorkspace(path, container, shell) {
	return call("setWorkspace", {
		path,
		container,
		shell
	});
}
/**
* Ensure the container path exists as a host directory (a realpath anchor so
* the DSH workspace service accepts it); the filesystem provider then lists it
* through the container instead of the host placeholder.
* @param path - the container workspace root path.
*/
async function ensurePath(path) {
	return call("ensurePath", { path });
}
/**
* List the stored Docker workspace roots.
* @returns the canonical container paths.
*/
async function listWorkspaces() {
	return call("listWorkspaces", {});
}
//#endregion
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
* Whether a session cwd falls inside any stored Docker workspace root. Used by
* the browser half's mode-variant binding (container paths cannot be told
* apart from ordinary Windows paths by shape alone, so the host-provided
* workspace set is the predicate).
* @param cwd - the session working directory (a container path).
* @param roots - the stored workspace roots (canonical container paths).
* @returns whether the cwd equals or descends from a workspace root.
*/
function isWithinWorkspace(cwd, roots) {
	const cwdKey = normalizeWindowsPath(cwd).toLowerCase();
	for (const root of roots) {
		const rootKey = normalizeWindowsPath(root).toLowerCase();
		if (cwdKey === rootKey || cwdKey.startsWith(`${rootKey}\\`)) return true;
	}
	return false;
}
/**
* The deepest common ancestor directory of a set of absolute Windows paths,
* used as the default browse root for a container's bind-mount destinations
* (e.g. `C:\workspace` for `C:\workspace\pyscript`, `C:\workspace\csscript`).
* @param paths - absolute Windows paths.
* @returns the common ancestor (a normalized path), or null for no shared root.
*/
function commonAncestor(paths) {
	if (paths.length === 0) return null;
	const split = paths.map((path) => normalizeWindowsPath(path).split("\\"));
	const first = split[0];
	const common = [];
	for (let index = 0; index < first.length; index++) {
		const segment = first[index];
		if (split.every((segments) => segments[index] !== void 0 && segments[index].toLowerCase() === segment.toLowerCase())) common.push(segment);
		else break;
	}
	return common.length === 0 ? null : normalizeWindowsPath(common.join("\\"));
}
//#endregion
//#region src/client/AddWinDockerWorkspace.tsx
/** The sidebar footer trigger: a D-letter action that opens the dialog. */
function DockerWorkspaceTrigger({ wide, t, actions }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		className: wide ? "ddw-action ddw-action--wide" : "ddw-action ddw-action--rail",
		title: t("action.title"),
		"aria-label": t("action.title"),
		onClick: () => actions.setOpen(true),
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "ddw-letter",
			"aria-hidden": "true",
			children: "D"
		})
	});
}
/** A tiny inline container glyph for the dialog's directory rows. */
function DockerGlyph({ size = 16 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "3",
				y: "5",
				width: "18",
				height: "14",
				rx: "2",
				stroke: "currentColor",
				strokeWidth: "1.6"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "7",
				y: "8",
				width: "4",
				height: "4",
				rx: "0.5",
				stroke: "currentColor",
				strokeWidth: "1.4"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "13",
				y: "8",
				width: "4",
				height: "4",
				rx: "0.5",
				stroke: "currentColor",
				strokeWidth: "1.4"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M8 15h3M13 15h3",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round"
			})
		]
	});
}
/**
* The "Add Docker workspace…" dialog, rendered in the shell overlay layer.
* @param props - store share + injected face.
*/
function DockerWorkspaceDialog({ useStore, actions, t, checkPreset, listContainers, listMounts, listDir, check, createWorkspace }) {
	const open = useStore((state) => state.open);
	const [opening, setOpening] = (0, react.useState)(false);
	const [containers, setContainers] = (0, react.useState)([]);
	const [container, setContainer] = (0, react.useState)("");
	const [pathInput, setPathInput] = (0, react.useState)("C:\\workspace");
	const [shell, setShell] = (0, react.useState)("");
	const [listing, setListing] = (0, react.useState)(null);
	const [browsePath, setBrowsePath] = (0, react.useState)("C:\\workspace");
	const [browsing, setBrowsing] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const browseSeq = (0, react.useRef)(0);
	const close = () => {
		actions.setOpen(false);
	};
	const refreshBrowse = async (root, targetContainer) => {
		const seq = ++browseSeq.current;
		setBrowsing(true);
		setBrowsePath(root);
		try {
			const value = await listDir(targetContainer, root);
			if (seq === browseSeq.current) setListing(value);
		} catch {
			if (seq === browseSeq.current) {
				setListing(null);
				setError((previous) => previous ?? t("error.loadDir"));
			}
		} finally {
			if (seq === browseSeq.current) setBrowsing(false);
		}
	};
	const onContainerChange = async (name) => {
		setContainer(name);
		setError(null);
		if (name === "") return;
		let mounts;
		try {
			mounts = await listMounts(name);
		} catch {
			setError(t("error.loadMounts"));
			return;
		}
		const root = commonAncestor(mounts.map((mount) => mount.destination)) ?? mounts[0]?.destination ?? "C:\\workspace";
		setPathInput(root);
		refreshBrowse(root, name);
	};
	(0, react.useEffect)(() => {
		if (!open) return;
		let cancelled = false;
		setError(null);
		setOpening(true);
		(async () => {
			let presetIssue;
			try {
				presetIssue = await checkPreset();
			} catch {
				presetIssue = t("error.loadContainers");
			}
			let names;
			try {
				names = await listContainers();
			} catch {
				if (cancelled) return;
				setOpening(false);
				setError(t("error.loadContainers"));
				return;
			}
			if (cancelled) return;
			setContainers(names);
			const first = names[0] ?? "";
			setContainer(first);
			setOpening(false);
			if (presetIssue !== void 0) setError(presetIssue);
			if (first !== "") onContainerChange(first);
		})();
		return () => {
			cancelled = true;
		};
	}, [open]);
	(0, react.useEffect)(() => {
		if (!open) return;
		const onKey = (event) => {
			if (event.key === "Escape" && !busy) close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, busy]);
	const onDrill = (name) => {
		const next = containerChildPath(listing?.path ?? browsePath, name);
		setPathInput(next);
		refreshBrowse(next, container);
	};
	const onUp = () => {
		const parent = listing?.parent ?? null;
		if (parent === null) return;
		setPathInput(parent);
		refreshBrowse(parent, container);
	};
	const onCheck = async () => {
		setError(null);
		if (!isWindowsDrivePath(pathInput)) {
			setError(t("error.invalidPath"));
			return;
		}
		let facts;
		try {
			facts = await check(container, pathInput);
		} catch {
			setError(t("error.pathNotFound"));
			return;
		}
		if (!facts.exists || !facts.isDirectory) {
			setError(t("error.pathNotFound"));
			return;
		}
		if (!facts.inBindMount && !facts.containsMounts) {
			setError(t("error.notInBindMount"));
			return;
		}
		refreshBrowse(pathInput, container);
	};
	const onConfirm = async () => {
		setError(null);
		if (!isWindowsDrivePath(pathInput)) {
			setError(t("error.invalidPath"));
			return;
		}
		setBusy(true);
		try {
			let facts;
			try {
				facts = await check(container, pathInput);
			} catch {
				setError(t("error.pathNotFound"));
				return;
			}
			if (!facts.exists || !facts.isDirectory) {
				setError(t("error.pathNotFound"));
				return;
			}
			if (!facts.inBindMount && !facts.containsMounts) {
				setError(t("error.notInBindMount"));
				return;
			}
			const failure = await createWorkspace(pathInput, container, shell.trim());
			if (failure !== void 0) {
				setError(failure);
				return;
			}
			close();
		} finally {
			setBusy(false);
		}
	};
	const children = (listing?.entries.filter((entry) => entry.kind === "directory") ?? []).map((entry) => entry.name);
	const maskClick = () => {
		if (!busy) close();
	};
	const listScroll = () => {};
	if (!open) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "ddw-overlay",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "ddw-overlay-mask",
			onClick: maskClick
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "ddw-card",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": t("dialog.title"),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "ddw-header",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "ddw-title",
						children: t("dialog.title")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "ddw-close",
						"aria-label": t("dialog.cancel"),
						onClick: maskClick,
						children: "✕"
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "ddw-body",
					children: [
						error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ddw-error",
							children: [error, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "ddw-retry",
								onClick: () => setError(null),
								children: t("dialog.retry")
							})]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ddw-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "ddw-field-label",
								htmlFor: "ddw-container",
								children: t("dialog.container")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								id: "ddw-container",
								className: "ddw-select",
								value: container,
								disabled: opening || busy,
								onChange: (event) => void onContainerChange(event.target.value),
								children: containers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: opening ? t("dialog.loading") : ""
								}) : containers.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: name,
									children: name
								}, name))
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ddw-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "ddw-field-label",
								htmlFor: "ddw-path",
								children: t("dialog.path")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "ddw-input-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "ddw-path",
									className: "ddw-input",
									value: pathInput,
									placeholder: t("dialog.pathPlaceholder"),
									disabled: opening || busy,
									onChange: (event) => setPathInput(event.target.value)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "ddw-check-btn",
									disabled: opening || busy,
									onClick: () => void onCheck(),
									children: t("dialog.check")
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ddw-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "ddw-field-label",
								htmlFor: "ddw-shell",
								children: t("dialog.shell")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "ddw-shell",
								className: "ddw-input",
								value: shell,
								placeholder: t("dialog.shellPlaceholder"),
								disabled: opening || busy,
								autoComplete: "off",
								spellCheck: false,
								onChange: (event) => setShell(event.target.value)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "ddw-feedback",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "ddw-breadcrumb",
								children: browsePath
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "ddw-dirlist",
								onScroll: listScroll,
								children: [browsing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "ddw-dir-empty",
									children: t("dialog.loading")
								}) : listing?.parent !== null && listing !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "ddw-dir-row ddw-dir-row--up",
									onClick: onUp,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DockerGlyph, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dialog.upLevel") })]
								}) : null, !browsing && children.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "ddw-dir-empty",
									children: t("dialog.browseEmpty")
								}) : children.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "ddw-dir-row",
									onClick: () => onDrill(name),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DockerGlyph, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name })]
								}, name))]
							})]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "ddw-actions",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "ddw-btn",
						disabled: busy,
						onClick: maskClick,
						children: t("dialog.cancel")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "ddw-btn ddw-btn--primary",
						disabled: busy || opening,
						onClick: () => void onConfirm(),
						children: busy ? t("dialog.loading") : t("dialog.confirm")
					})]
				})
			]
		})]
	});
}
//#endregion
//#region src/client/stores.ts
/**
* Shared dialog-open state for the Docker workspace trigger (sidebar footer)
* and the dialog (shell.overlay). The factory is exported only — a module-level
* handle would pin the store identity across plugin reloads. `apply` creates
* ONE handle and passes it to both registrations.
*/
/**
* Create the shared handle for the Docker workspace dialog.
* @returns the store handle (spec + identity + factory).
*/
function createDockerWorkspaceStore() {
	return (0, _deepseek_ai_dsh_client_runtime_client.defineStore)({
		init: () => ({ open: false }),
		actions: { setOpen: (draft, open) => {
			draft.open = open;
		} }
	});
}
//#endregion
//#region src/client/styles.ts
/**
* Third-party stylesheet injection for the Docker workspace UI (the plugin
* builds no CSS bundle, so styles are injected as one idempotent `<style>`).
* Colors derive exclusively from the `--dsw-*` design tokens.
*/
const STYLE_TAG_DATA_ATTRIBUTE = "data-plugin=\"dsh-win-docker-workspace\"";
const STYLES = `
/* Sidebar-foot icon action beside Settings (28px round in the wide sidebar,
   36px round in the rail), matching the shell's icon-button language. */
.ddw-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition:
    background-color 120ms var(--dsw-ease-in-out, ease-in-out),
    color 120ms var(--dsw-ease-in-out, ease-in-out);
}
.ddw-action:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.ddw-action:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-pressed, var(--dsw-alias-interactive-bg-hover));
}
.ddw-action:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.ddw-action:disabled { cursor: default; opacity: 0.6; }
.ddw-action--rail {
  width: 36px;
  height: 36px;
  color: var(--dsw-alias-label-primary);
}
.ddw-action svg { flex: none; }

/* The D letter mark of the sidebar action (sized for wide/rail buttons). */
.ddw-letter {
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  user-select: none;
}
.ddw-action--rail .ddw-letter { font-size: 17px; }

/* Full-viewport overlay + centered card (mirrors the platform Mask/Dialog). */
.ddw-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.ddw-overlay-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.ddw-card {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(440px, 100%);
  max-height: min(640px, 90vh);
  padding: 0 0 20px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
  font-family: var(--dsw-font-family);
}
.ddw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 18px 20px 12px;
}
.ddw-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.ddw-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.ddw-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ddw-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 0 20px;
  overflow: auto;
}
.ddw-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ddw-field-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.ddw-select {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.ddw-input-row { display: flex; gap: 8px; align-items: center; }
.ddw-input {
  box-sizing: border-box;
  flex: 1;
  height: 36px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.ddw-input:focus, .ddw-select:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.ddw-check-btn {
  flex: none;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 12px;
}
.ddw-check-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ddw-check-btn:disabled { cursor: default; }

/* Directory browse list. */
.ddw-dirlist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  min-height: 120px;
  max-height: 200px;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
}
.ddw-breadcrumb {
  padding: 0 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ddw-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}
.ddw-dir-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ddw-dir-row:disabled { cursor: default; color: var(--dsw-alias-label-tertiary); }
.ddw-dir-row--up { color: var(--dsw-alias-label-secondary); }
.ddw-dir-row svg { flex: none; color: var(--dsw-alias-label-tertiary); }
.ddw-dir-empty {
  padding: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* Error strip. */
.ddw-error {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.ddw-retry {
  margin-left: 6px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}

/* Dialog footer actions. */
.ddw-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 0;
}
.ddw-btn {
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font-size: 14px;
}
.ddw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ddw-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.ddw-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ddw-btn:disabled { cursor: default; opacity: 0.6; }
`;
/**
* Idempotently inject the plugin stylesheet. No-op when a tag with the
* plugin's data attribute already exists.
*/
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[${STYLE_TAG_DATA_ATTRIBUTE}]`) !== null) return;
	const style = document.createElement("style");
	style.setAttribute("data-plugin", "dsh-win-docker-workspace");
	style.textContent = STYLES;
	document.head.appendChild(style);
}
//#endregion
//#region src/client/locales.ts
/**
* Bilingual dictionaries for the `winDockerWorkspace` locale namespace.
* Product copy is Chinese; English is the parallel export.
*/
/** The `winDockerWorkspace` translations (Chinese, the primary product copy). */
const zh = {
	"action.add": "Docker 工作区",
	"action.title": "添加 Docker 工作区…",
	"dialog.title": "添加 Docker 工作区",
	"dialog.container": "容器",
	"dialog.path": "路径",
	"dialog.pathPlaceholder": "C:\\workspace\\pyscript",
	"dialog.shell": "容器内 shell",
	"dialog.shellPlaceholder": "留空则使用 powershell.exe",
	"dialog.loading": "正在加载…",
	"dialog.browseEmpty": "此目录没有子文件夹",
	"dialog.upLevel": "..（返回上级）",
	"dialog.check": "检查",
	"dialog.confirm": "创建并打开",
	"dialog.cancel": "取消",
	"dialog.retry": "重试",
	"error.loadContainers": "无法获取运行中的容器列表，请确认 Docker 已启动且处于 Windows 容器模式",
	"error.loadMounts": "无法读取该容器的挂载列表",
	"error.loadDir": "无法浏览该目录",
	"error.presetMissing": "未找到健康的 win-docker preset，请确认插件宿主端已安装并配置该 preset",
	"error.invalidPath": "请输入以盘符开头的容器绝对路径（如 C:\\workspace\\pyscript）",
	"error.invalidShell": "shell 名无效：仅可含字母、数字、_、.、-，可带 .exe 后缀",
	"error.pathNotFound": "该路径不存在、或是文件；请选择一个文件夹",
	"error.notInBindMount": "该路径既不在容器的 bind-mount 挂载内、也不是挂载点的父目录，文件工具无法读写；请选择挂载目录或其父目录（如 C:\\workspace 或 C:\\workspace\\pyscript）",
	"error.createFailed": "创建工作区失败"
};
/** The `winDockerWorkspace` translations (English). */
const en = {
	"action.add": "Docker Workspace",
	"action.title": "Add Docker workspace…",
	"dialog.title": "Add Docker workspace",
	"dialog.container": "Container",
	"dialog.path": "Path",
	"dialog.pathPlaceholder": "C:\\workspace\\pyscript",
	"dialog.shell": "Container shell",
	"dialog.shellPlaceholder": "Leave empty to use powershell.exe",
	"dialog.loading": "Loading…",
	"dialog.browseEmpty": "No subdirectories here",
	"dialog.upLevel": ".. (up)",
	"dialog.check": "Check",
	"dialog.confirm": "Create & open",
	"dialog.cancel": "Cancel",
	"dialog.retry": "Retry",
	"error.loadContainers": "Could not list running containers; confirm Docker is running in Windows container mode",
	"error.loadMounts": "Could not read this container's mounts",
	"error.loadDir": "Could not browse this directory",
	"error.presetMissing": "No healthy \"win-docker\" preset found; confirm the plugin host side installed and configured it",
	"error.invalidPath": "Enter an absolute container path starting with a drive letter (e.g. C:\\workspace\\pyscript)",
	"error.invalidShell": "Invalid shell: only letters, digits, _ . - (an optional .exe suffix)",
	"error.pathNotFound": "The path does not exist or is a file; choose a folder",
	"error.notInBindMount": "This path is neither inside a container bind mount nor an ancestor of one, so the file tools cannot read or write it; choose a mounted directory or its parent (e.g. C:\\workspace or C:\\workspace\\pyscript)",
	"error.createFailed": "Failed to create the workspace"
};
//#endregion
//#region src/client/index.ts
/** Required services (cordis fiber inject). */
const inject = [
	"slots",
	"locale",
	"connection",
	"sessions",
	"workspaces"
];
/**
* Mount the sidebar action and the auto-binding effect.
* @param ctx - the browser plugin context.
*/
function apply(ctx) {
	const { api } = ctx.get("connection");
	const workspaces = ctx.get("workspaces");
	const sessions = ctx.get("sessions");
	ensureStyles();
	ctx.effect(() => ctx.locale.register("winDockerWorkspace", {
		zh,
		en
	}), "dsh-win-docker-workspace: locale dictionaries");
	const t = ctx.locale.bind("winDockerWorkspace");
	const injected = () => ({
		t,
		checkPreset: async () => {
			let roster;
			try {
				roster = (await api.agentPresets.list({})).result;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			if (!roster.ok) return roster.error.message;
			if (roster.value.presets.find((entry) => entry.id.startsWith("win-docker-") && entry.broken === void 0) === void 0) return t("error.presetMissing");
		},
		listContainers: () => listContainers(),
		listMounts: (container) => listMounts(container),
		listDir: (container, path) => listDir(container, path),
		check: (container, path) => check(container, path),
		createWorkspace: async (path, container, shell) => {
			try {
				await ensurePath(path);
				const view = await workspaces.create({ path });
				await setWorkspace(path, container, shell);
				workspaces.startSession(view.workspaceId);
				return;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		}
	});
	const store = createDockerWorkspaceStore();
	ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
		name: "sidebar.footer.action",
		id: "win-docker-workspace",
		inject: injected,
		store
	}, DockerWorkspaceTrigger)), "dsh-win-docker-workspace: sidebar footer action");
	ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "win-docker-workspace-dialog",
		inject: injected,
		store
	}, DockerWorkspaceDialog)), "dsh-win-docker-workspace: shell overlay dialog");
	ctx.effect(() => {
		const inFlight = /* @__PURE__ */ new Set();
		const attempts = /* @__PURE__ */ new Map();
		const MAX_ATTEMPTS = 3;
		let variants = /* @__PURE__ */ new Set();
		let defaultPreset;
		let workspaceRoots = /* @__PURE__ */ new Set();
		const refreshRoster = () => {
			api.agentPresets.list({}).then((response) => {
				const result = response.result;
				if (!result.ok) return;
				variants = new Set(result.value.presets.filter((entry) => entry.broken === void 0 && entry.id.startsWith("win-docker-")).map((entry) => entry.id));
				defaultPreset = result.value.presets.find((entry) => entry.isDefault === true)?.id;
			}).catch(() => {});
		};
		const refreshWorkspaces = () => {
			listWorkspaces().then((roots) => {
				workspaceRoots = new Set(roots);
			}).catch(() => {});
		};
		refreshRoster();
		refreshWorkspaces();
		const maybeBind = () => {
			const state = sessions.list.getSnapshot();
			for (const id of state.ids) {
				const summary = state.byId[id];
				if (summary === void 0 || !summary.blank || summary.cwd === void 0) continue;
				if (!isWithinWorkspace(summary.cwd, [...workspaceRoots])) continue;
				const current = summary.agentPreset;
				if (current !== void 0 && current.startsWith("win-docker-")) continue;
				const base = current ?? defaultPreset;
				if (base === void 0 || base.startsWith("win-docker-")) continue;
				const target = `win-docker-${base.toLowerCase()}`;
				if (!variants.has(target)) continue;
				if (inFlight.has(id) || (attempts.get(id) ?? 0) >= MAX_ATTEMPTS) continue;
				inFlight.add(id);
				const selectPreset = api.agentPresets.select;
				selectPreset({
					sessionId: id,
					agentPreset: target
				}).then((response) => {
					if (response.result.ok) sessions.noteAgentPreset(id, target);
				}).catch(() => {
					attempts.set(id, (attempts.get(id) ?? 0) + 1);
				}).finally(() => {
					inFlight.delete(id);
				});
			}
		};
		maybeBind();
		const unsubscribe = sessions.list.subscribe(() => maybeBind());
		const timer = window.setInterval(() => {
			refreshRoster();
			refreshWorkspaces();
		}, 6e4);
		return () => {
			unsubscribe();
			window.clearInterval(timer);
		};
	}, "dsh-win-docker-workspace: Docker mode-variant binding");
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
//# sourceMappingURL=client.js.map