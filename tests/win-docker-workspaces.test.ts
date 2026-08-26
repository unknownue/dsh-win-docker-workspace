import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getWorkspace, listWorkspaces, setWorkspace } from '../src/shared/win-docker-workspaces.ts'

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
  it('stores and reads a workspace entry', () => {
    setWorkspace('C:\\workspace\\pyscript', 'gm-trunk', undefined)
    expect(getWorkspace('C:\\workspace\\pyscript')).toEqual({ container: 'gm-trunk' })
  })

  it('resolves a deep path to its workspace root by longest prefix', () => {
    setWorkspace('C:\\workspace\\pyscript', 'gm-trunk', undefined)
    setWorkspace('C:\\workspace\\docs', 'gm-trunk', 'pwsh.exe')
    expect(getWorkspace('C:\\workspace\\pyscript\\sub\\a.py')).toEqual({ container: 'gm-trunk' })
    expect(getWorkspace('C:\\workspace\\docs\\x.md')).toEqual({ container: 'gm-trunk', shell: 'pwsh.exe' })
  })

  it('returns undefined for an unknown path', () => {
    expect(getWorkspace('C:\\other\\dir')).toBeUndefined()
  })

  it('clears a stored shell with an empty value', () => {
    setWorkspace('C:\\workspace\\pyscript', 'gm-trunk', 'pwsh.exe')
    setWorkspace('C:\\workspace\\pyscript', 'gm-trunk', '')
    expect(getWorkspace('C:\\workspace\\pyscript')).toEqual({ container: 'gm-trunk' })
  })

  it('lists stored workspace roots normalized', () => {
    setWorkspace('c:/workspace/pyscript', 'gm-trunk', undefined)
    expect(listWorkspaces()).toEqual(['C:\\workspace\\pyscript'])
  })

  it('rejects invalid container names', () => {
    expect(() => setWorkspace('C:\\workspace\\pyscript', 'bad name', undefined)).toThrow()
  })

  it('rejects invalid shell names', () => {
    expect(() => setWorkspace('C:\\workspace\\pyscript', 'gm-trunk', 'pwsh -c')).toThrow()
  })

  it('reads a missing store as empty', () => {
    expect(getWorkspace('C:\\workspace\\pyscript')).toBeUndefined()
    expect(listWorkspaces()).toEqual([])
  })
})
