/**
 * Host half of dsh-win-docker-workspace. Three responsibilities:
 *
 * 1. Materialize a `win-docker-<mode>` variant for every healthy roster preset
 *    under `<dshHome>/.agent-presets/` (the roster's auto-scanned user root),
 *    so the Docker execution world — `shell-docker` + `fs-docker` behind one
 *    entry-local realm, with `tool-pwsh`/`tool-fs` consumers — composes with
 *    ANY mode instead of being a mode itself. The preset rows name THIS
 *    package's built lib files by absolute path, which the preset mount
 *    resolves to `file:` URLs without relying on bare specifier resolution
 *    from the preset's home directory.
 *
 * 2. Serve the browser dialog's data route (`/win-docker-workspace/api`):
 *    running-container discovery, bind-mount listing, directory listing, path
 *    checks, and the per-workspace container/shell store. Loopback-only,
 *    matching the sensitivity of the privileged configuration surface.
 *
 * 3. Contribute the per-session `DSH_DOCKER_CONTAINER`/`DSH_DOCKER_SHELL`
 *    managed-env facts so the Docker shell executor can resolve a plain
 *    container workdir to the calling session's container.
 * @module dsh-win-docker-workspace
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { checkContainerPathSync, inspectMountsSync, listContainerDirSync, listContainers } from './shared/docker.ts'
import { getWorkspace, listWorkspaces, setWorkspace } from './shared/win-docker-workspaces.ts'
import {
  containsMount,
  isWindowsDrivePath,
  isValidContainerName,
  isValidShellName,
  mapContainerToHost,
  normalizeWindowsPath,
} from './shared/paths.ts'
import { isDockerVariantId, isForeignVariantId, transformPresetForDocker, variantIdFor } from './host/variants.ts'

/** The HTTP route this plugin serves (a relative, same-origin path). */
export const DEFAULT_ROUTE = '/win-docker-workspace/api'

/**
 * Bilingual display labels for the shipped source modes, matching the app's
 * own built-in copy in each language. The DSH picker localizes only the four
 * built-in ids itself; `win-docker-*` variant ids render the preset.yml text
 * verbatim, so the plugin writes one bilingual string so both locales can
 * identify each variant. Custom presets keep their own name.
 */
const MODE_DISPLAY_LABELS: Readonly<Record<string, { en: string; zh: string }>> = {
  standard: { en: 'Standard mode', zh: '标准模式' },
  code: { en: 'Code mode', zh: 'PTC 模式' },
  minimal: { en: 'Minimal mode', zh: '极简模式' },
  cordis: { en: 'Creator mode', zh: '创造模式' },
}

/**
 * Quote a value as a single-line YAML single-quoted scalar. Plain scalars
 * cannot contain `: ` (colon + space), which plain English sentences do —
 * written unquoted they make the whole preset.yml unparsable, dropping the
 * name, description and order together.
 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The variant name for one shipped mode (bilingual) or a custom preset. */
function variantName(presetId: string, sourceName: string): string {
  const labels = MODE_DISPLAY_LABELS[presetId]
  return labels === undefined ? `Docker · ${sourceName}` : `Docker · ${labels.en}（${labels.zh}）`
}

/** The variant description for one shipped mode (bilingual) or a custom preset. */
function variantDescription(presetId: string): string {
  const labels = MODE_DISPLAY_LABELS[presetId]
  const display = labels === undefined ? presetId : `${labels.en}（${labels.zh}）`
  return `Docker execution world for ${display}: pwsh and file tools run inside the Windows container.`
}

/** Plugin config. */
export interface Config {
  /** The route under which the dialog data API is served. */
  route?: string
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** The `webServer.register` route contract this plugin consumes. */
interface WebServerRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

interface WebServerService {
  register(route: WebServerRoute): () => void
}

/** The `ctx.shellEnv` registry face this plugin consumes (optional service). */
interface ShellEnvService {
  register(contributor: {
    name: string
    variables: Readonly<Record<string, { description: string }>>
    resolve(execution: {
      agent?: { session: { header: { cwd?: string } } }
    }): Readonly<Partial<Record<string, string>>>
  }): () => void
}

/** One directory entry the dialog lists. */
interface DockerDirEntryWire {
  name: string
  kind: 'directory' | 'file' | 'other'
}

/** One directory level plus its breadcrumb ancestry. */
interface DockerDirListingWire {
  path: string
  parent: string | null
  entries: DockerDirEntryWire[]
}

/** The wire envelope every method answers with. */
type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

const MAX_BODY_BYTES = 1024 * 1024

/** The loopback hostnames the data route answers to (DNS-rebinding fence). */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when a socket address is loopback (any IPv4/IPv6 spelling). */
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** The hostname part of a `Host` header value (port and IPv6 brackets stripped). */
function hostNameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end >= 0 ? host.slice(1, end) : host
  }
  return host.split(':')[0] ?? ''
}

/** True when the request's `Host` header names a loopback host. */
function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOSTNAMES.has(hostNameOf(host).toLowerCase())
}

/** Human text for an unknown rejection. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Write one JSON envelope. */
function json(res: ServerResponse, status: number, body: Envelope<unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/** Collect and parse the request body, bounded. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Validate a wire-supplied container name before it becomes a `docker exec`/
 * `docker inspect` argv element.
 * @param value - the raw wire value.
 * @returns the validated container name.
 */
function requireContainer(value: unknown): string {
  if (typeof value !== 'string' || !isValidContainerName(value)) {
    throw new Error('container must match the name pattern [A-Za-z0-9][A-Za-z0-9_.-]*')
  }
  return value
}

/** Validate a wire-supplied workspace path and return its canonical container form. */
function requireContainerPath(value: unknown): string {
  if (typeof value !== 'string' || !isWindowsDrivePath(value)) {
    throw new Error('path must be an absolute Windows container path (C:\\...)')
  }
  return normalizeWindowsPath(value)
}

/** Validate a wire-supplied shell executable name. */
function requireShell(value: unknown): string {
  if (typeof value !== 'string' || !isValidShellName(value)) {
    throw new Error('shell must be a plain executable name (e.g. powershell.exe)')
  }
  return value
}

/** Resolve one directory listing inside the container (full filesystem via docker exec). */
function listDockerDir(container: string, path: string): DockerDirListingWire {
  const normalized = normalizeWindowsPath(path)
  const entries: DockerDirEntryWire[] = listContainerDirSync(container, normalized)
    .slice(0, 1000)
    .map((entry): DockerDirEntryWire => ({ name: entry.name, kind: entry.kind }))
    .sort((a, b) => {
      if (a.kind === 'directory' && b.kind !== 'directory') return -1
      if (a.kind !== 'directory' && b.kind === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
  const parentPath = dirname(normalized)
  return { path: normalized, parent: parentPath === normalized ? null : parentPath, entries }
}

/** Resolve one existence/directory check inside the container, plus the bind-mount facts. */
function checkDockerPath(container: string, path: string): { exists: boolean; isDirectory: boolean; inBindMount: boolean; containsMounts: boolean } {
  const normalized = normalizeWindowsPath(path)
  const check = checkContainerPathSync(container, normalized)
  const mounts = inspectMountsSync(container)
  const inBindMount = mapContainerToHost(normalized, mounts) !== null
  const containsMounts = containsMount(normalized, mounts)
  return { ...check, inBindMount, containsMounts }
}

/** Route one method dispatch. */
async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'listContainers': {
      return listContainers()
    }
    case 'listMounts': {
      const container = requireContainer(params.container)
      return inspectMountsSync(container).map(mount => ({
        source: mount.source,
        destination: mount.destination,
      }))
    }
    case 'listDir': {
      const container = requireContainer(params.container)
      const path = requireContainerPath(params.path)
      return listDockerDir(container, path)
    }
    case 'check': {
      const container = requireContainer(params.container)
      const path = requireContainerPath(params.path)
      return checkDockerPath(container, path)
    }
    case 'setWorkspace': {
      const path = requireContainerPath(params.path)
      const container = requireContainer(params.container)
      const shell = params.shell === undefined || params.shell === '' ? undefined : requireShell(params.shell)
      setWorkspace(path, container, shell)
      return null
    }
    case 'ensurePath': {
      const path = requireContainerPath(params.path)
      mkdirSync(path, { recursive: true })
      return null
    }
    case 'listWorkspaces': {
      return listWorkspaces()
    }
    default:
      throw new Error(`unknown method "${method}"`)
  }
}

/** The `ctx.agentPresets` roster face this plugin consumes (optional service). */
interface AgentPresetsService {
  list(): Promise<{ id: string; broken?: string; path: string }[]>
  read(id: string): Promise<string>
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
async function materializeVariants(
  agentPresets: AgentPresetsService,
  dshHome: string,
  shellPath: string,
  fsPath: string,
): Promise<void> {
  const presets = await agentPresets.list()
  const userRoot = join(dshHome, '.agent-presets')
  const generated = new Set<string>()
  for (const preset of presets) {
    if (preset.broken !== undefined) continue
    if (isDockerVariantId(preset.id)) continue
    if (isForeignVariantId(preset.id)) continue
    const variantId = variantIdFor(preset.id)
    const source = await agentPresets.read(preset.id)
    const transformed = transformPresetForDocker(source, shellPath, fsPath)
    const dir = join(userRoot, variantId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.cordis.yml'), transformed, 'utf8')
    const labels = MODE_DISPLAY_LABELS[preset.id]
    let name = variantName(preset.id, preset.id)
    let orderLine = ''
    try {
      const meta = readFileSync(join(dirname(preset.path), 'preset.yml'), 'utf8')
      if (labels === undefined) {
        const match = /^name:\s*(.+)$/m.exec(meta)
        if (match?.[1] !== undefined && match[1].trim() !== '') {
          name = variantName(preset.id, match[1].trim())
        }
      }
      const orderMatch = /^order:\s*(\d+)\s*$/m.exec(meta)
      if (orderMatch?.[1] !== undefined) orderLine = `order: ${orderMatch[1]}\n`
    } catch {
      // Absent or unreadable display metadata falls back to the id-based name.
    }
    writeFileSync(
      join(dir, 'preset.yml'),
      `name: ${yamlScalar(name)}\n`
      + orderLine
      + `description: ${yamlScalar(variantDescription(preset.id))}\n`,
      'utf8',
    )
    generated.add(variantId)
  }
  for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!isDockerVariantId(entry.name)) continue
    if (!generated.has(entry.name)) rmSync(join(userRoot, entry.name), { recursive: true, force: true })
  }
}

/** Function-plugin plugin contract. */
export const name = 'dsh-win-docker-workspace'

/** Required services. */
export const inject = ['webServer']

/** Validated plugin config (schemastery applied the defaults). */
export const Config: z<Config> = z.object({
  route: z.string().default(DEFAULT_ROUTE),
})

/**
 * Apply the host half: materialize a `win-docker-<mode>` variant for every
 * healthy roster preset, register the data route, and contribute the
 * per-session `DSH_DOCKER_CONTAINER`/`DSH_DOCKER_SHELL` managed-env facts.
 * @param ctx - the host plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const shellPath = join(packageRoot, 'lib', 'shell.js').replace(/\\/g, '/')
  const fsPath = join(packageRoot, 'lib', 'fs.js').replace(/\\/g, '/')

  const agentPresets = ctx.get('agentPresets') as unknown as AgentPresetsService | undefined
  if (agentPresets !== undefined) {
    ctx.effect(() => {
      void materializeVariants(agentPresets, dshHome, shellPath, fsPath).catch((error) => {
        console.error(`dsh-win-docker-workspace: Docker preset-variant generation failed: ${messageOf(error)}`)
      })
      return () => {}
    }, 'dsh-win-docker-workspace: Docker preset variants')
  }

  const shellEnv = ctx.get('shellEnv') as unknown as ShellEnvService | undefined
  if (shellEnv !== undefined) {
    ctx.effect(() => shellEnv.register({
      name: 'win-docker-workspace-container',
      variables: {
        DSH_DOCKER_CONTAINER: {
          description: 'The Docker container of the calling session workspace, when the session cwd is a Docker workspace path.',
        },
        DSH_DOCKER_SHELL: {
          description: 'The in-container shell of the calling session workspace, when the workspace has one configured.',
        },
      },
      resolve(execution) {
        const cwd = execution.agent?.session.header.cwd
        if (cwd === undefined) return {}
        const entry = getWorkspace(cwd)
        if (entry === undefined) return {}
        return entry.shell === undefined || entry.shell === ''
          ? { DSH_DOCKER_CONTAINER: entry.container }
          : { DSH_DOCKER_CONTAINER: entry.container, DSH_DOCKER_SHELL: entry.shell }
      },
    }), 'dsh-win-docker-workspace: per-session container env fact')
  }

  const webServer = ctx.get('webServer') as unknown as WebServerService
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: resolved.route,
    handler: async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
        json(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readBody(req)
      } catch (error) {
        json(res, 400, { ok: false, error: messageOf(error) })
        return
      }
      const method = typeof body.method === 'string' ? body.method : ''
      const params = body.params === undefined ? {} : body.params
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        json(res, 400, { ok: false, error: 'params must be an object' })
        return
      }
      try {
        const value = await dispatch(method, params as Record<string, unknown>)
        json(res, 200, { ok: true, value })
      } catch (error) {
        json(res, 200, { ok: false, error: messageOf(error) })
      }
    },
  }), 'dsh-win-docker-workspace: dialog data route')
}
