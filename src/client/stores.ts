/**
 * Shared dialog-open state for the Docker workspace trigger (sidebar footer)
 * and the dialog (shell.overlay). The factory is exported only — a module-level
 * handle would pin the store identity across plugin reloads. `apply` creates
 * ONE handle and passes it to both registrations.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Dialog-open state shared between the trigger button and the overlay dialog. */
type DockerWorkspaceState = {
  open: boolean
}

/** The store's write set: the trigger opens, the dialog opens/closes. */
type DockerWorkspaceActions = {
  setOpen: (draft: DockerWorkspaceState, open: boolean) => void
}

/**
 * Create the shared handle for the Docker workspace dialog.
 * @returns the store handle (spec + identity + factory).
 */
export function createDockerWorkspaceStore(): EngineStoreHandle<DockerWorkspaceState, DockerWorkspaceActions> {
  return defineStore({
    init: (): DockerWorkspaceState => ({ open: false }),
    actions: {
      setOpen: (draft: DockerWorkspaceState, open: boolean) => { draft.open = open },
    },
  })
}
