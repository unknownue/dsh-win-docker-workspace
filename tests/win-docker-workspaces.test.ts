import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  anchorPathFor,
  containerOwners,
  containerPathOf,
  getWorkspace,
  listRecords,
  listWorkspaces,
  resolveAnchorPath,
  setWorkspace,
} from '../src/shared/win-docker-workspaces.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-docker-workspace-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('win-docker-workspaces store', () => {
  it('stores a workspace under its own anchor and returns it', () => {
    const anchor = setWorkspace('C:\\workspace', 'gm-qa', undefined)
    expect(anchor).toBe(anchorPathFor('gm-qa', 'C:\\workspace'))
    expect(existsSync(anchor)).toBe(true)
    expect(getWorkspace(anchor)).toEqual({ container: 'gm-qa', containerPath: 'C:\\workspace' })
    expect(getWorkspace('C:\\workspace')).toEqual({ container: 'gm-qa', containerPath: 'C:\\workspace' })
  })

  it('gives two containers presenting the same container path distinct anchors', () => {
    const qa = setWorkspace('C:\\workspace', 'gm-qa', undefined)
    const trunk = setWorkspace('C:\\workspace', 'gm-trunk', undefined)
    expect(qa).not.toBe(trunk)
    expect(resolveAnchorPath(qa)?.entry.container).toBe('gm-qa')
    expect(resolveAnchorPath(trunk)?.entry.container).toBe('gm-trunk')
  })

  it('resolves the shared container path only when exactly one container covers it', () => {
    setWorkspace('C:\\workspace', 'gm-qa', undefined)
    expect(getWorkspace('C:\\workspace\\pyscript\\sub\\a.py')).toEqual({ container: 'gm-qa', containerPath: 'C:\\workspace' })
    setWorkspace('C:\\workspace', 'gm-trunk', undefined)
    expect(getWorkspace('C:\\workspace')).toBeUndefined()
    expect(getWorkspace('C:\\workspace\\pyscript')).toBeUndefined()
    expect(containerOwners('C:\\workspace').map(owner => owner.entry.container).sort()).toEqual(['gm-qa', 'gm-trunk'])
  })

  it('resolves a deep path under an anchor with its remainder', () => {
    const anchor = setWorkspace('C:\\workspace', 'gm-trunk', 'pwsh.exe')
    const match = resolveAnchorPath(`${anchor}\\pyscript\\sub`)
    expect(match?.entry).toEqual({ container: 'gm-trunk', containerPath: 'C:\\workspace', shell: 'pwsh.exe' })
    expect(match?.remainder).toBe('pyscript\\sub')
    expect(getWorkspace(`${anchor}\\pyscript`)).toEqual({ container: 'gm-trunk', containerPath: 'C:\\workspace', shell: 'pwsh.exe' })
  })

  it('clears a stored shell with an empty value', () => {
    const anchor = setWorkspace('C:\\workspace', 'gm-trunk', 'pwsh.exe')
    setWorkspace('C:\\workspace', 'gm-trunk', '')
    expect(getWorkspace(anchor)).toEqual({ container: 'gm-trunk', containerPath: 'C:\\workspace' })
  })

  it('lists stored workspace roots normalized (anchors and legacy keys)', () => {
    const anchor = setWorkspace('c:/workspace/pyscript', 'gm-trunk', undefined)
    expect(listWorkspaces()).toEqual([anchor])
  })

  it('rejects invalid container names', () => {
    expect(() => setWorkspace('C:\\workspace', 'bad name', undefined)).toThrow()
  })

  it('rejects invalid shell names', () => {
    expect(() => setWorkspace('C:\\workspace', 'gm-trunk', 'pwsh -c')).toThrow()
  })

  it('reads a missing store as empty', () => {
    expect(getWorkspace('C:\\workspace')).toBeUndefined()
    expect(listWorkspaces()).toEqual([])
  })

  it('reads a legacy (container-path-keyed) row as containerPath = key', () => {
    writeFileSync(join(home, 'win-docker-workspaces.json'), JSON.stringify({
      'C:\\workspace': { container: 'gm-qa' },
    }, null, 2) + '\n', 'utf8')
    expect(getWorkspace('C:\\workspace')).toEqual({ container: 'gm-qa' })
    const owners = containerOwners('C:\\workspace\\pyscript')
    expect(owners).toHaveLength(1)
    expect(containerPathOf(owners[0]!.entry, owners[0]!.key)).toBe('C:\\workspace')
    expect(listWorkspaces()).toEqual(['C:\\workspace'])
  })

  it('migrates a legacy row of the same container when the workspace is added again', () => {
    writeFileSync(join(home, 'win-docker-workspaces.json'), JSON.stringify({
      'C:\\workspace': { container: 'gm-qa' },
    }, null, 2) + '\n', 'utf8')
    const anchor = setWorkspace('C:\\workspace', 'gm-qa', undefined)
    expect(listWorkspaces()).toEqual([anchor])
    expect(getWorkspace('C:\\workspace')).toEqual({ container: 'gm-qa', containerPath: 'C:\\workspace' })
  })

  it('keeps a legacy row of another container until that container is re-added', () => {
    writeFileSync(join(home, 'win-docker-workspaces.json'), JSON.stringify({
      'C:\\workspace': { container: 'gm-qa' },
    }, null, 2) + '\n', 'utf8')
    setWorkspace('C:\\workspace', 'gm-trunk', undefined)
    expect(getWorkspace('C:\\workspace')).toBeUndefined()
    expect(containerOwners('C:\\workspace').map(owner => owner.entry.container).sort()).toEqual(['gm-qa', 'gm-trunk'])
    const store = JSON.parse(readFileSync(join(home, 'win-docker-workspaces.json'), 'utf8')) as Record<string, unknown>
    expect(store['C:\\workspace']).toEqual({ container: 'gm-qa' })
    expect(listRecords()).toHaveLength(2)
  })
})
