/**
 * The "Add Docker workspace" trigger (sidebar footer action) and its dialog.
 * They are two registrations sharing one store handle: the trigger renders in
 * `sidebar.footer.action` (owner share `{ wide }`), and the dialog renders in
 * the full-screen `shell.overlay` layer so it is never clipped by the sidebar.
 *
 * Registration omits the typed `locale:` seat (the `winDockerWorkspace`
 * namespace is not merged into `LocaleNamespaceMap`), so the injected face
 * carries the bound translate function instead.
 */

import type * as React from 'react'
import { useEffect, useRef, useState, type UIEventHandler } from 'react'
import { commonAncestor, containerChildPath, isWindowsDrivePath } from '../shared/paths.ts'
import type { DockerDirListing, DockerMount, DockerPathCheck } from './api.ts'

/** The inject face: plain data + callbacks the dialog drives. */
export interface AddWinDockerWorkspaceInjected {
  /** Confirm the deployment exposes a healthy `win-docker` preset. */
  checkPreset(): Promise<string | undefined>
  /** List the running containers on the host. */
  listContainers(): Promise<string[]>
  /** List one container's bind mounts. */
  listMounts(container: string): Promise<DockerMount[]>
  /** List one container directory level (through its bind mounts). */
  listDir(container: string, path: string): Promise<DockerDirListing>
  /** Check a container path's existence/directory facts. */
  check(container: string, path: string): Promise<DockerPathCheck>
  /**
   * Register a workspace over a container path and start a session in it.
   * @param path - the container path.
   * @param container - the container name.
   * @param shell - optional shell; empty = the configured default.
   * @returns undefined on success, else a message to show.
   */
  createWorkspace(path: string, container: string, shell: string): Promise<string | undefined>
  /** Translate a `winDockerWorkspace` dictionary key (follows the DSH locale). */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** The store's write set, baked to the component (the draft is bound away). */
export interface DockerWorkspaceStoreFace {
  useStore: <S>(selector: (s: { open: boolean }) => S, eq?: (a: S, b: S) => boolean) => S
  actions: { setOpen: (open: boolean) => void }
}

/** The sidebar footer trigger: a D-letter action that opens the dialog. */
export function DockerWorkspaceTrigger({ wide, t, actions }: { wide: boolean } & Pick<AddWinDockerWorkspaceInjected, 't'> & DockerWorkspaceStoreFace): React.ReactElement {
  return (
    <button
      type="button"
      className={wide ? 'ddw-action ddw-action--wide' : 'ddw-action ddw-action--rail'}
      title={t('action.title')}
      aria-label={t('action.title')}
      onClick={() => actions.setOpen(true)}
    >
      <span className="ddw-letter" aria-hidden="true">D</span>
    </button>
  )
}

/** A tiny inline container glyph for the dialog's directory rows. */
function DockerGlyph({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="7" y="8" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="13" y="8" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 15h3M13 15h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The "Add Docker workspace…" dialog, rendered in the shell overlay layer.
 * @param props - store share + injected face.
 */
export function DockerWorkspaceDialog({ useStore, actions, t, checkPreset, listContainers, listMounts, listDir, check, createWorkspace }: AddWinDockerWorkspaceInjected & DockerWorkspaceStoreFace): React.ReactElement | null {
  const open = useStore(state => state.open)
  const [opening, setOpening] = useState(false)
  const [containers, setContainers] = useState<string[]>([])
  const [container, setContainer] = useState('')
  const [pathInput, setPathInput] = useState('C:\\workspace')
  const [shell, setShell] = useState('')
  const [listing, setListing] = useState<DockerDirListing | null>(null)
  const [browsePath, setBrowsePath] = useState('C:\\workspace')
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Monotone browse-request sequence: stale responses for a superseded browse are dropped.
  const browseSeq = useRef(0)

  const close = (): void => { actions.setOpen(false) }

  const refreshBrowse = async (root: string, targetContainer: string): Promise<void> => {
    const seq = ++browseSeq.current
    setBrowsing(true)
    setBrowsePath(root)
    try {
      const value = await listDir(targetContainer, root)
      if (seq === browseSeq.current) setListing(value)
    } catch {
      // A failed browse (permission, outside mount) is non-fatal: keep old listing.
      if (seq === browseSeq.current) {
        setListing(null)
        setError((previous) => previous ?? t('error.loadDir'))
      }
    } finally {
      if (seq === browseSeq.current) setBrowsing(false)
    }
  }

  const onContainerChange = async (name: string): Promise<void> => {
    setContainer(name)
    setError(null)
    if (name === '') return
    let mounts: DockerMount[]
    try {
      mounts = await listMounts(name)
    } catch {
      setError(t('error.loadMounts'))
      return
    }
    const root = commonAncestor(mounts.map(mount => mount.destination)) ?? mounts[0]?.destination ?? 'C:\\workspace'
    setPathInput(root)
    void refreshBrowse(root, name)
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setOpening(true)
    void (async () => {
      let presetIssue: string | undefined
      try {
        presetIssue = await checkPreset()
      } catch {
        presetIssue = t('error.loadContainers')
      }
      let names: string[]
      try {
        names = await listContainers()
      } catch {
        if (cancelled) return
        setOpening(false)
        setError(t('error.loadContainers'))
        return
      }
      if (cancelled) return
      setContainers(names)
      const first = names[0] ?? ''
      setContainer(first)
      setOpening(false)
      if (presetIssue !== undefined) setError(presetIssue)
      if (first !== '') void onContainerChange(first)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per open against current t.
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])

  const onDrill = (name: string): void => {
    const next = containerChildPath(listing?.path ?? browsePath, name)
    setPathInput(next)
    void refreshBrowse(next, container)
  }

  const onUp = (): void => {
    const parent = listing?.parent ?? null
    if (parent === null) return
    setPathInput(parent)
    void refreshBrowse(parent, container)
  }

  const onCheck = async (): Promise<void> => {
    setError(null)
    if (!isWindowsDrivePath(pathInput)) {
      setError(t('error.invalidPath'))
      return
    }
    let facts: DockerPathCheck
    try {
      facts = await check(container, pathInput)
    } catch {
      setError(t('error.pathNotFound'))
      return
    }
    if (!facts.exists || !facts.isDirectory) {
      setError(t('error.pathNotFound'))
      return
    }
    if (!facts.inBindMount && !facts.containsMounts) {
      setError(t('error.notInBindMount'))
      return
    }
    void refreshBrowse(pathInput, container)
  }

  const onConfirm = async (): Promise<void> => {
    setError(null)
    if (!isWindowsDrivePath(pathInput)) {
      setError(t('error.invalidPath'))
      return
    }
    setBusy(true)
    try {
      let facts: DockerPathCheck
      try {
        facts = await check(container, pathInput)
      } catch {
        setError(t('error.pathNotFound'))
        return
      }
      if (!facts.exists || !facts.isDirectory) {
        setError(t('error.pathNotFound'))
        return
      }
      if (!facts.inBindMount && !facts.containsMounts) {
        setError(t('error.notInBindMount'))
        return
      }
      const failure = await createWorkspace(pathInput, container, shell.trim())
      if (failure !== undefined) {
        setError(failure)
        return
      }
      close()
    } finally {
      setBusy(false)
    }
  }

  const children = (listing?.entries.filter(entry => entry.kind === 'directory') ?? []).map(entry => entry.name)
  const maskClick = (): void => { if (!busy) close() }
  const listScroll: UIEventHandler<HTMLDivElement> = () => { /* scroll container handles overflow */ }

  if (!open) return null

  return (
    <div className="ddw-overlay">
      <div className="ddw-overlay-mask" onClick={maskClick} />
      <div className="ddw-card" role="dialog" aria-modal="true" aria-label={t('dialog.title')}>
        <div className="ddw-header">
          <h2 className="ddw-title">{t('dialog.title')}</h2>
          <button type="button" className="ddw-close" aria-label={t('dialog.cancel')} onClick={maskClick}>
            ✕
          </button>
        </div>
        <div className="ddw-body">
          {error !== null ? (
            <div className="ddw-error">
              {error}
              <button type="button" className="ddw-retry" onClick={() => setError(null)}>{t('dialog.retry')}</button>
            </div>
          ) : null}
          <div className="ddw-field">
            <label className="ddw-field-label" htmlFor="ddw-container">{t('dialog.container')}</label>
            <select
              id="ddw-container"
              className="ddw-select"
              value={container}
              disabled={opening || busy}
              onChange={event => void onContainerChange(event.target.value)}
            >
              {containers.length === 0
                ? <option value="">{opening ? t('dialog.loading') : ''}</option>
                : containers.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div className="ddw-field">
            <label className="ddw-field-label" htmlFor="ddw-path">{t('dialog.path')}</label>
            <div className="ddw-input-row">
              <input
                id="ddw-path"
                className="ddw-input"
                value={pathInput}
                placeholder={t('dialog.pathPlaceholder')}
                disabled={opening || busy}
                onChange={event => setPathInput(event.target.value)}
              />
              <button type="button" className="ddw-check-btn" disabled={opening || busy} onClick={() => void onCheck()}>
                {t('dialog.check')}
              </button>
            </div>
          </div>
          <div className="ddw-field">
            <label className="ddw-field-label" htmlFor="ddw-shell">{t('dialog.shell')}</label>
            <input
              id="ddw-shell"
              className="ddw-input"
              value={shell}
              placeholder={t('dialog.shellPlaceholder')}
              disabled={opening || busy}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setShell(event.target.value)}
            />
          </div>
          <div className="ddw-feedback">
            <div className="ddw-breadcrumb">{browsePath}</div>
            <div className="ddw-dirlist" onScroll={listScroll}>
              {browsing ? <div className="ddw-dir-empty">{t('dialog.loading')}</div> : (
                listing?.parent !== null && listing !== null
                  ? (
                    <button type="button" className="ddw-dir-row ddw-dir-row--up" onClick={onUp}>
                      <DockerGlyph size={14} />
                      <span>{t('dialog.upLevel')}</span>
                    </button>
                  )
                  : null
              )}
              {!browsing && (children.length === 0)
                ? <div className="ddw-dir-empty">{t('dialog.browseEmpty')}</div>
                : children.map(name => (
                  <button type="button" key={name} className="ddw-dir-row" onClick={() => onDrill(name)}>
                    <DockerGlyph size={14} />
                    <span>{name}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
        <div className="ddw-actions">
          <button type="button" className="ddw-btn" disabled={busy} onClick={maskClick}>{t('dialog.cancel')}</button>
          <button type="button" className="ddw-btn ddw-btn--primary" disabled={busy || opening} onClick={() => void onConfirm()}>
            {busy ? t('dialog.loading') : t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
