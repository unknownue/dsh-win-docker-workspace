import { c as isWindowsDrivePath, d as normalizeWindowsPath, t as getWorkspace } from "./win-docker-workspaces-BWIkm72X.js";
import z from "@deepseek-ai/schemastery";
import { ShellExecutor } from "@deepseek-ai/dsh-shell";
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
//#region \0@oxc-project+runtime@0.146.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/shell.ts
/**
* UTF-8 output pinning prepended to every command (same as `dsh-pwsh-local`):
* Windows PowerShell 5.1 writes the console/OEM code page by default, which
* garbles non-ASCII output; the subprocess collector decodes bytes as UTF-8.
*/
const ENCODING_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";
/** Default SIGTERM→SIGKILL grace period (matches `dsh-pwsh-local`). */
const DEFAULT_GRACE_MS = 3e3;
/** Default per-stream spill cap (matches `dsh-pwsh-local`). */
const DEFAULT_MAX_SPILL_BYTES = 67108864;
/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader) {
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy,
		...read.spillPath !== void 0 ? { spillPath: read.spillPath } : {}
	};
}
function assertPositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`docker-shell: ${name} must be a positive finite number`);
}
/** Whether an environment key is credential-shaped and must not enter the container. */
function credentialShaped(key) {
	return /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key);
}
/**
* Reject a resolved configuration this executor could not run with, so a
* stored value is refused where it is written instead of failing at the next
* command.
* @param config - the schema-validated configuration.
* @throws Error naming the field that cannot be used.
*/
function assertServiceableDockerConfig(config) {
	const resolved = config;
	assertPositiveFinite("timeoutMs", resolved.timeoutMs);
	assertPositiveFinite("maxTimeoutMs", resolved.maxTimeoutMs);
	assertPositiveFinite("maxOutputBytes", resolved.maxOutputBytes);
	assertPositiveFinite("maxSpillBytes", resolved.maxSpillBytes);
	assertPositiveFinite("graceMs", resolved.graceMs);
	if (resolved.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`docker-shell: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	if (resolved.shellPath !== void 0 && resolved.shellPath.trim() === "") throw new Error("docker-shell: shellPath must be a non-empty executable name");
	if (resolved.dockerPath !== void 0 && resolved.dockerPath.trim() === "") throw new Error("docker-shell: dockerPath must be a non-empty executable path");
}
/**
* Docker pwsh executor over the LOCAL subprocess service: `docker` is a Windows
* executable, so the Windows-side spawn, bounded output, spill files, and
* process-group termination are the local subprocess seam's mechanics; this
* executor supplies the container-world argv, cwd translation, and env passing.
*/
var DockerShellExecutor = class DockerShellExecutor extends ShellExecutor {
	static inject = ["subprocess"];
	static Config = z.object({
		cwd: z.string(),
		container: z.string(),
		shellPath: z.string().default("powershell.exe"),
		dockerPath: z.string().default("docker.exe"),
		timeoutMs: z.number().default(12e4),
		maxTimeoutMs: z.number().default(6e5),
		maxOutputBytes: z.number().default(64e3),
		maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
		graceMs: z.number().default(DEFAULT_GRACE_MS)
	});
	resolved;
	/** Validated config (schemastery applied the defaults before construction). */
	get config() {
		return this.resolved;
	}
	constructor(ctx, config) {
		super(ctx);
		const entry = config;
		assertServiceableDockerConfig(entry);
		this.resolved = entry;
	}
	/**
	* Resolve a request into a fully-specified spec: fill `workdir` from
	* `config.cwd`, and `timeoutMs` from `config.timeoutMs`, capped at
	* `config.maxTimeoutMs`. The tool layer calls this before
	* {@link run}/{@link start}, so those methods receive explicit values.
	*/
	resolve(request) {
		const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, "docker-shell: request.timeoutMs");
		const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes;
		assertPositiveFinite("request.stdoutMaxBytes", stdoutMaxBytes);
		return {
			command: request.command,
			workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
			timeoutMs,
			stdoutMaxBytes,
			...request.signal ? { signal: request.signal } : {},
			...request.stdin !== void 0 ? { stdin: request.stdin } : {},
			...request.env !== void 0 ? { env: request.env } : {},
			...request.dshEnv !== void 0 ? { dshEnv: request.dshEnv } : {},
			sandboxPolicy: request.sandboxPolicy
		};
	}
	/**
	* Resolve the container for a workdir that carries none. The chain: the
	* calling session's container (`DSH_DOCKER_CONTAINER`, contributed by the
	* host half from the session's workspace), then the store entry covering the
	* workdir, then the configured `container`. Fails loud when every source is
	* absent rather than guessing a container the path does not belong to.
	* @param spec - the resolved execution spec (its dshEnv carries the session fact).
	* @param containerPath - the normalized container workdir.
	* @returns the container name.
	*/
	resolveContainer(spec, containerPath) {
		const fromEnv = spec.dshEnv?.DSH_DOCKER_CONTAINER;
		if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
		const fromStore = getWorkspace(containerPath);
		if (fromStore !== void 0) return fromStore.container;
		const configured = this.config.container;
		if (configured !== void 0 && configured !== "") return configured;
		throw new Error("docker-shell: container path carries no container; no session DSH_DOCKER_CONTAINER, workspace store entry, or container config is available");
	}
	/**
	* Merge the caller env layers into `-e KEY=VALUE` args for `docker exec`,
	* skipping credential-shaped names so host secrets never enter the container
	* implicitly. The `docker` process itself is spawned with the ambient host
	* environment unchanged.
	* @param spec - the resolved execution spec.
	* @returns the `-e` argv fragments.
	*/
	envArgs(spec) {
		const env = {
			NO_COLOR: "1",
			...spec.env,
			...spec.dshEnv
		};
		const args = [];
		for (const [key, value] of Object.entries(env)) {
			if (credentialShaped(key)) continue;
			args.push("-e", `${key}=${value}`);
		}
		return args;
	}
	/**
	* Translate a resolved spec into the container execution plan. Fails loud on
	* a workdir that is not a Windows container path.
	* @param spec - the resolved execution spec.
	* @returns the translated plan, including the complete argv.
	*/
	plan(spec) {
		const workdir = spec.workdir;
		if (!isWindowsDrivePath(workdir)) throw new Error(`docker-shell: workdir "${workdir}" is not a Windows container path`);
		const containerPath = normalizeWindowsPath(workdir);
		const container = this.resolveContainer(spec, containerPath);
		return {
			container,
			containerPath,
			hostCwd: process.env.SystemRoot ?? process.cwd(),
			argv: [
				this.config.dockerPath,
				"exec",
				"-i",
				"-w",
				containerPath,
				...this.envArgs(spec),
				container,
				this.config.shellPath,
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`${ENCODING_PREAMBLE}${spec.command}`
			]
		};
	}
	/** Map a plan onto a fully-specified subprocess spawn. */
	spawnSpec(plan, spec, stdoutMaxBytes, signal) {
		const collect = (maxBytes) => ({
			maxBytes,
			spill: { maxBytes: this.config.maxSpillBytes }
		});
		return {
			argv: plan.argv,
			cwd: plan.hostCwd,
			stdio: {
				stdin: spec.stdin !== void 0 ? { data: spec.stdin } : "ignore",
				stdout: collect(stdoutMaxBytes),
				stderr: collect(this.config.maxOutputBytes)
			},
			graceMs: this.config.graceMs,
			signal
		};
	}
	/** The collect-mode readers this executor requested (present by construction). */
	static collected(handle) {
		const { stdout, stderr } = handle.collected;
		/* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
		if (stdout === void 0 || stderr === void 0) throw new Error("docker-shell: subprocess implementation dropped a requested collect stream");
		/* v8 ignore stop */
		return {
			stdout,
			stderr
		};
	}
	/** Run one command in the foreground. */
	async run(spec) {
		try {
			var _usingCtx$1 = _usingCtx();
			const plan = this.plan(spec);
			const d = _usingCtx$1.u(deadline(spec.signal, spec.timeoutMs, "DOCKER_PWSH_TIMEOUT"));
			const handle = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, spec.stdoutMaxBytes, d.signal));
			const outcome = await handle.done;
			const collected = DockerShellExecutor.collected(handle);
			const timedOut = timeoutOf(d.signal, "DOCKER_PWSH_TIMEOUT") !== void 0;
			const aborted = d.signal.aborted && !timedOut;
			return {
				...outcome,
				timedOut,
				aborted,
				timeoutMs: spec.timeoutMs,
				stdout: finalOutput(collected.stdout),
				stderr: finalOutput(collected.stderr)
			};
		} catch (_) {
			_usingCtx$1.e = _;
		} finally {
			_usingCtx$1.d();
		}
	}
	/** Start one command in the background and return its live handle. */
	start(spec) {
		const plan = this.plan(spec);
		const running = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, this.config.maxOutputBytes, spec.signal));
		const collected = DockerShellExecutor.collected(running);
		let spawnFailureNote;
		const consumeSpawnFailure = () => {
			const note = spawnFailureNote ?? "";
			spawnFailureNote = void 0;
			return note;
		};
		let stdoutOffset = 0;
		let stderrOffset = 0;
		const proc = {
			status: "running",
			exitCode: null,
			signal: null,
			done: running.done.then((outcome) => {
				if (proc.status === "running") proc.status = spec.signal?.aborted === true || outcome.signal !== null ? "killed" : "completed";
				proc.exitCode = outcome.exitCode;
				proc.signal = outcome.signal;
			}, (error) => {
				proc.status = "killed";
				spawnFailureNote = `spawn failed: ${String(error)}`;
			}),
			readOutput: () => {
				const out = collected.stdout.readFrom(stdoutOffset);
				const err = collected.stderr.readFrom(stderrOffset);
				stdoutOffset = out.nextOffset;
				stderrOffset = err.nextOffset;
				const errText = err.text.length > 0 ? err.text : consumeSpawnFailure();
				const separator = out.text.length > 0 && !out.text.endsWith("\n") ? "\n" : "";
				return {
					delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
					lossy: out.lossy || err.lossy,
					...out.spillPath !== void 0 ? { stdoutSpillPath: out.spillPath } : {},
					...err.spillPath !== void 0 ? { stderrSpillPath: err.spillPath } : {}
				};
			},
			kill: () => {
				if (proc.status !== "running") return false;
				proc.status = "killed";
				running.terminate();
				return true;
			}
		};
		return proc;
	}
};
//#endregion
export { DockerShellExecutor, DockerShellExecutor as default, assertServiceableDockerConfig };

//# sourceMappingURL=shell.js.map