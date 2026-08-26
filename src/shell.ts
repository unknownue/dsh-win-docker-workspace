/**
 * Windows Docker Service Provider for the `ctx.shell` capability seam. Every
 * command runs inside one Windows container as
 * `docker exec -i -w <containerPath> <container> powershell.exe -NoLogo
 * -NoProfile -NonInteractive -Command <command>`, so the model-facing pwsh
 * dialect matches the execution world exactly — the "like direct calls"
 * experience of a container workspace session.
 *
 * The executor is a fresh implementation modeled on
 * `@deepseek-ai/dsh-pwsh-local` (same deadline fusion, bounded collect,
 * background adaptation, and UTF-8 output preamble) and on
 * `dsh-wsl-workspace`'s shell provider (workdir→execution-world planning over
 * the LOCAL subprocess service), but does NOT register the shared `shell`
 * settings namespace: the host composition already registers it through its
 * own executor, and a second registration from a preset realm would collide.
 * Configuration rides the preset row instead.
 * @module dsh-win-docker-workspace/shell
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { isWindowsDrivePath, normalizeWindowsPath } from './shared/paths.ts'
import { getWorkspace } from './shared/win-docker-workspaces.ts'

/**
 * UTF-8 output pinning prepended to every command (same as `dsh-pwsh-local`):
 * Windows PowerShell 5.1 writes the console/OEM code page by default, which
 * garbles non-ASCII output; the subprocess collector decodes bytes as UTF-8.
 */
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Default SIGTERM→SIGKILL grace period (matches `dsh-pwsh-local`). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (matches `dsh-pwsh-local`). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory (a container path); per-call workdir wins. */
  cwd?: string
  /** Default container used only when a call's workdir carries no store entry. */
  container?: string
  /** The in-container shell executable (`powershell.exe`, `pwsh`, `cmd`). */
  shellPath?: string
  /** The `docker` executable (absolute path or PATH name). */
  dockerPath?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'container'>> & Pick<Config, 'cwd' | 'container'>

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`docker-shell: ${name} must be a positive finite number`)
  }
}

/** Whether an environment key is credential-shaped and must not enter the container. */
function credentialShaped(key: string): boolean {
  return /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key)
}

/**
 * Reject a resolved configuration this executor could not run with, so a
 * stored value is refused where it is written instead of failing at the next
 * command.
 * @param config - the schema-validated configuration.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableDockerConfig(config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', resolved.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', resolved.maxSpillBytes)
  assertPositiveFinite('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`docker-shell: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (resolved.shellPath !== undefined && resolved.shellPath.trim() === '') {
    throw new Error('docker-shell: shellPath must be a non-empty executable name')
  }
  if (resolved.dockerPath !== undefined && resolved.dockerPath.trim() === '') {
    throw new Error('docker-shell: dockerPath must be a non-empty executable path')
  }
}

/** One translated execution plan: the container-world coordinates plus the argv. */
interface DockerPlan {
  /** Container the command runs in. */
  container: string
  /** Container working directory handed to `docker exec -w`. */
  containerPath: string
  /** A valid Windows directory for the `docker` process itself. */
  hostCwd: string
  /** Full argv to hand to `ctx.subprocess`. */
  argv: readonly string[]
}

/**
 * Docker pwsh executor over the LOCAL subprocess service: `docker` is a Windows
 * executable, so the Windows-side spawn, bounded output, spill files, and
 * process-group termination are the local subprocess seam's mechanics; this
 * executor supplies the container-world argv, cwd translation, and env passing.
 */
export class DockerShellExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    cwd: z.string(),
    container: z.string(),
    shellPath: z.string().default('powershell.exe'),
    dockerPath: z.string().default('docker.exe'),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  private readonly resolved: ResolvedConfig

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.resolved
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const entry = config as ResolvedConfig
    assertServiceableDockerConfig(entry)
    this.resolved = entry
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd`, and `timeoutMs` from `config.timeoutMs`, capped at
   * `config.maxTimeoutMs`. The tool layer calls this before
   * {@link run}/{@link start}, so those methods receive explicit values.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'docker-shell: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
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
  private resolveContainer(spec: ShellExecSpec, containerPath: string): string {
    const fromEnv = spec.dshEnv?.DSH_DOCKER_CONTAINER
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    const fromStore = getWorkspace(containerPath)
    if (fromStore !== undefined) return fromStore.container
    const configured = this.config.container
    if (configured !== undefined && configured !== '') return configured
    throw new Error(
      'docker-shell: container path carries no container; no session DSH_DOCKER_CONTAINER, '
      + 'workspace store entry, or container config is available',
    )
  }

  /**
   * Merge the caller env layers into `-e KEY=VALUE` args for `docker exec`,
   * skipping credential-shaped names so host secrets never enter the container
   * implicitly. The `docker` process itself is spawned with the ambient host
   * environment unchanged.
   * @param spec - the resolved execution spec.
   * @returns the `-e` argv fragments.
   */
  private envArgs(spec: ShellExecSpec): readonly string[] {
    const env: Record<string, string> = { NO_COLOR: '1', ...spec.env, ...spec.dshEnv }
    const args: string[] = []
    for (const [key, value] of Object.entries(env)) {
      if (credentialShaped(key)) continue
      args.push('-e', `${key}=${value}`)
    }
    return args
  }

  /**
   * Translate a resolved spec into the container execution plan. Fails loud on
   * a workdir that is not a Windows container path.
   * @param spec - the resolved execution spec.
   * @returns the translated plan, including the complete argv.
   */
  private plan(spec: ShellExecSpec): DockerPlan {
    const workdir = spec.workdir
    if (!isWindowsDrivePath(workdir)) {
      throw new Error(`docker-shell: workdir "${workdir}" is not a Windows container path`)
    }
    const containerPath = normalizeWindowsPath(workdir)
    const container = this.resolveContainer(spec, containerPath)
    // The `docker` process itself needs a plain Windows directory: its own cwd
    // is irrelevant (`-w` sets the container side). SystemRoot always exists.
    const hostCwd = process.env.SystemRoot ?? process.cwd()
    const argv = [
      this.config.dockerPath,
      'exec', '-i',
      '-w', containerPath,
      ...this.envArgs(spec),
      container,
      this.config.shellPath,
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `${ENCODING_PREAMBLE}${spec.command}`,
    ]
    return { container, containerPath, hostCwd, argv }
  }

  /** Map a plan onto a fully-specified subprocess spawn. */
  private spawnSpec(plan: DockerPlan, spec: ShellExecSpec, stdoutMaxBytes: number, signal: AbortSignal | undefined): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: plan.argv,
      cwd: plan.hostCwd,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
    }
  }

  /** The collect-mode readers this executor requested (present by construction). */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('docker-shell: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  /** Run one command in the foreground. */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const plan = this.plan(spec)
    using d = deadline(spec.signal, spec.timeoutMs, 'DOCKER_PWSH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = DockerShellExecutor.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'DOCKER_PWSH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr),
    }
  }

  /** Start one command in the background and return its live handle. */
  start(spec: ShellExecSpec): ShellProcess {
    const plan = this.plan(spec)
    // Background runs ignore timeoutMs; callers stop them through kill() or spec.signal.
    const running = this.ctx.subprocess.spawn(this.spawnSpec(plan, spec, this.config.maxOutputBytes, spec.signal))
    const collected = DockerShellExecutor.collected(running)

    // A spawn failure produces no process output, so the subprocess service has
    // nothing to buffer; the note is delivered exactly once through the read path.
    let spawnFailureNote: string | undefined
    const consumeSpawnFailure = (): string => {
      const note = spawnFailureNote ?? ''
      spawnFailureNote = undefined
      return note
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
      }, (error: unknown) => {
        proc.status = 'killed'
        spawnFailureNote = `spawn failed: ${String(error)}`
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }
}

export default DockerShellExecutor
