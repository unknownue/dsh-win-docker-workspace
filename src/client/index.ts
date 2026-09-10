/**
 * Browser half of dsh-win-docker-workspace. Registers the "Add Docker
 * workspace…" action beside Settings at the sidebar foot (the official
 * `sidebar.footer.action` slot), and keeps every blank session whose
 * workspace is a Docker container path composed from the Docker VARIANT of the
 * mode it currently runs (`standard` → `win-docker-standard`, PTC →
 * `win-docker-code`, …) — so the Docker execution world composes with any mode
 * instead of being a mode itself.
 *
 * The binding is a watching effect rather than a one-shot dialog action so
 * EVERY creation path (this dialog, the workspace row's New Session, the
 * hero picker) converges on the Docker-backed composition automatically.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale) and the
// ui-sidebar SlotMap merge (the 'sidebar.footer.action' entry) into this
// program. dsh 0.1.2 removed dsh-client-runtime from the client graph and
// moved the typed API surface to the `remote` service, so this plugin
// declares its own minimal service faces below instead of importing them.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { check as checkApi, listContainers as listContainersApi, listDir as listDirApi, listMounts as listMountsApi, listWorkspaces as listWorkspacesApi, setWorkspace as setWorkspaceApi } from './api.ts'
import { DockerWorkspaceDialog, DockerWorkspaceTrigger, type AddWinDockerWorkspaceInjected } from './AddWinDockerWorkspace.tsx'
import { createDockerWorkspaceStore } from './stores.ts'
import { ensureStyles } from './styles.ts'
import { zh, en } from './locales.ts'
import { isWithinWorkspace, normalizeWindowsPath } from '../shared/paths.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.agentPresets', 'sessions', 'uiWorkspace', 'workspaces']

/** Minimal remote-service face (the typert `remote` service in dsh 0.1.2). */
interface DockerRemoteFace {
  agentPresets: {
    list(): Promise<{ ok: boolean; value?: { presets: Array<{ id: string; isDefault?: boolean; broken?: string }> }; error?: { message: string } }>
    select(sessionId: string, agentPreset: string): Promise<{ ok: boolean; error?: { message: string } }>
  }
}

/**
 * Minimal sessions-service face (documented boundary for a third-party
 * plugin). dsh 0.1.2 dropped the per-session `agentPreset` snapshot field
 * and `noteAgentPreset`; the preset now arrives through the `agentPreset`
 * session projection.
 */
interface DockerSessionsFace {
  list: {
    getSnapshot(): { ids: string[]; byId: Record<string, { blank: boolean; cwd?: string; projectionValues?: { agentPreset?: string | null } }> }
    subscribe(fn: () => void): () => void
  }
}

/** Minimal workspaces-service face (create + rename only). */
interface DockerWorkspacesFace {
  create(input: { path: string }): Promise<{ workspaceId: string; title: string }>
  rename(workspaceId: string, title: string): Promise<unknown>
}

/** Minimal uiWorkspace-service face (start-session only). */
interface DockerUiWorkspaceFace {
  startSession(workspaceId?: string): void
}

/** Minimal client-context face for this plugin's service usage. */
interface WinDockerClientContext {
  get(name: 'remote'): DockerRemoteFace
  get(name: 'sessions'): DockerSessionsFace
  get(name: 'workspaces'): DockerWorkspacesFace
  get(name: 'uiWorkspace'): DockerUiWorkspaceFace
  locale: any
  slots: any
  effect(fn: () => void | (() => void), label?: string): void
}

/**
 * Mount the sidebar action and the auto-binding effect.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: WinDockerClientContext): void {
  const remote = ctx.get('remote')
  const workspaces = ctx.get('workspaces') as unknown as DockerWorkspacesFace
  const uiWorkspace = ctx.get('uiWorkspace') as unknown as DockerUiWorkspaceFace
  const sessions = ctx.get('sessions') as unknown as DockerSessionsFace

  ensureStyles()

  ctx.effect(
    () => ctx.locale.register('winDockerWorkspace' as never, { zh, en }),
    'dsh-win-docker-workspace: locale dictionaries',
  )

  // The injected translate function reads the live DeepSeek Harness locale,
  // so the dialog copy follows the app language setting automatically.
  const t = ctx.locale.bind('winDockerWorkspace' as never) as unknown as (key: string, params?: Record<string, unknown>) => string

  const injected = (): AddWinDockerWorkspaceInjected => ({
    t,
    checkPreset: async (): Promise<string | undefined> => {
      let roster
      try {
        roster = await remote.agentPresets.list()
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      if (!roster.ok) return roster.error?.message ?? 'roster read failed'
      const healthy = (roster.value?.presets ?? []).find((entry: { id: string; broken?: string }) =>
        entry.id.startsWith('win-docker-') && entry.broken === undefined)
      if (healthy === undefined) return t('error.presetMissing')
      return undefined
    },
    listContainers: () => listContainersApi(),
    listMounts: (container) => listMountsApi(container),
    listDir: (container, path) => listDirApi(container, path),
    check: (container, path) => checkApi(container, path),
    createWorkspace: async (path, container, shell): Promise<string | undefined> => {
      try {
        // Each (container, container path) pair gets its own host anchor
        // directory: the harness workspace registry identifies workspaces by
        // canonical HOST path, so registering the container path itself would
        // collapse two containers that present the same path into one
        // workspace. The anchor keeps them fully independent.
        const { anchor } = await setWorkspaceApi(path, container, shell)
        const view = await workspaces.create({ path: anchor })
        const desiredTitle = `${container} · ${normalizeWindowsPath(path)}`
        if (view.title !== desiredTitle) {
          try {
            await workspaces.rename(view.workspaceId, desiredTitle)
          } catch {
            // Cosmetic: a name conflict keeps the default (basename) title.
          }
        }
        uiWorkspace.startSession(view.workspaceId)
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })

  const store = createDockerWorkspaceStore()

  ctx.effect(
    () => ctx.slots.inject(
      'sidebar.footer.action',
      () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'win-docker-workspace', inject: injected, store },
        DockerWorkspaceTrigger,
      ),
    ),
    'dsh-win-docker-workspace: sidebar footer action',
  )

  ctx.effect(
    () => ctx.slots.inject(
      'shell.overlay',
      () => ctx.slots.register(
        { name: 'shell.overlay', id: 'win-docker-workspace-dialog', inject: injected, store },
        DockerWorkspaceDialog,
      ),
    ),
    'dsh-win-docker-workspace: shell overlay dialog',
  )

  // Mode-variant binding: a blank session whose workspace is a Docker container
  // path is recomposed to the Docker variant of the mode it currently runs.
  // Container paths cannot be told from ordinary Windows paths by shape, so the
  // predicate is the host-provided workspace-root set (refreshed with the roster).
  ctx.effect(() => {
    const inFlight = new Set<string>()
    const attempts = new Map<string, number>()
    const MAX_ATTEMPTS = 3
    let variants = new Set<string>()
    let defaultPreset: string | undefined
    let workspaceRoots = new Set<string>()

    const refreshRoster = (): void => {
      void remote.agentPresets.list().then((result) => {
        if (!result.ok) return
        const presets = result.value?.presets ?? []
        variants = new Set(presets
          .filter((entry) => entry.broken === undefined && entry.id.startsWith('win-docker-'))
          .map((entry) => entry.id))
        defaultPreset = presets.find((entry) => entry.isDefault === true)?.id
      }).catch(() => {
        // A failed roster read leaves the previous mapping.
      })
    }

    const refreshWorkspaces = (): void => {
      void listWorkspacesApi().then((roots) => {
        workspaceRoots = new Set(roots)
      }).catch(() => {
        // A failed workspace read leaves the previous mapping.
      })
    }

    refreshRoster()
    refreshWorkspaces()

    const maybeBind = (): void => {
      const state = sessions.list.getSnapshot()
      for (const id of state.ids) {
        const summary = state.byId[id]
        if (summary === undefined || !summary.blank || summary.cwd === undefined) continue
        if (!isWithinWorkspace(summary.cwd, [...workspaceRoots])) continue
        const current = summary.projectionValues?.agentPreset ?? undefined
        if (current !== undefined && current.startsWith('win-docker-')) continue
        const base = current ?? defaultPreset
        if (base === undefined || base.startsWith('win-docker-')) continue
        const target = `win-docker-${base.toLowerCase()}`
        if (!variants.has(target)) continue
        if (inFlight.has(id) || (attempts.get(id) ?? 0) >= MAX_ATTEMPTS) continue
        inFlight.add(id)
        void remote.agentPresets.select(id, target)
          .then((response) => {
            if (response.ok) {
              // dsh 0.1.2: the session's agentPreset projection advances over
              // the wire (agent-preset/selected event); nothing to note locally.
            }
          })
          .catch(() => {
            attempts.set(id, (attempts.get(id) ?? 0) + 1)
          })
          .finally(() => {
            inFlight.delete(id)
          })
      }
    }
    maybeBind()
    const unsubscribe = sessions.list.subscribe(() => maybeBind())
    const timer = window.setInterval(() => {
      refreshRoster()
      refreshWorkspaces()
    }, 60_000)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, 'dsh-win-docker-workspace: Docker mode-variant binding')
}
