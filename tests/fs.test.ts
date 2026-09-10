import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('../src/shared/docker.ts', () => ({
  inspectMountsSync: vi.fn(),
  checkContainerPathSync: vi.fn(),
  listContainerDirSync: vi.fn(),
}))

vi.mock('../src/shared/win-docker-workspaces.ts', () => ({
  getWorkspace: vi.fn(),
  listRecords: vi.fn(),
  resolveAnchorPath: vi.fn(),
  containerOwners: vi.fn(),
  containerPathOf: vi.fn(),
}))

import { DockerFileSystem } from '../src/fs.ts'
import { checkContainerPathSync, inspectMountsSync, listContainerDirSync } from '../src/shared/docker.ts'
import { containerOwners, containerPathOf, getWorkspace, listRecords, resolveAnchorPath } from '../src/shared/win-docker-workspaces.ts'

const inspect = vi.mocked(inspectMountsSync)
const check = vi.mocked(checkContainerPathSync)
const listDir = vi.mocked(listContainerDirSync)
const workspace = vi.mocked(getWorkspace)
const records = vi.mocked(listRecords)
const anchor = vi.mocked(resolveAnchorPath)
const owners = vi.mocked(containerOwners)
const pathOf = vi.mocked(containerPathOf)

function makeFs(): DockerFileSystem {
  const ctx = { reflect: { provide: vi.fn() } } as unknown as Context
  return new DockerFileSystem(ctx, { diffBasisMaxBytes: 10 * 1024 * 1024 })
}

describe('DockerFileSystem container-only directories', () => {
  beforeEach(() => {
    records.mockReturnValue([])
    anchor.mockReturnValue(undefined)
    owners.mockReturnValue([])
    pathOf.mockImplementation((entry, key) => (entry.containerPath ?? key) as string)
    workspace.mockReturnValue({ container: 'gm-qa' })
    inspect.mockReturnValue([]) // no mounts → every path is container-only
    check.mockReturnValue({ exists: true, isDirectory: true })
  })

  it('resolves a container-only directory to a synthetic target', async () => {
    const fs = makeFs()
    const target = await fs.resolve('C:\\workspace')
    expect(String(target.targetKey)).toContain('docker-container://gm-qa/')
    expect(target.displayPath).toBe('C:\\workspace')
  })

  it('stats a synthetic target as a directory', async () => {
    const fs = makeFs()
    const target = await fs.resolve('C:\\workspace')
    const info = await fs.stat(target)
    expect(info?.type).toBe('directory')
  })

  it('lists a synthetic target via docker exec', async () => {
    listDir.mockReturnValue([
      { name: 'pyscript', kind: 'directory' },
      { name: 'csscript', kind: 'directory' },
    ])
    const fs = makeFs()
    const target = await fs.resolve('C:\\workspace')
    const entries = await fs.listDir(target)
    expect(entries.map(entry => entry.name)).toEqual(['pyscript', 'csscript'])
    expect(entries.every(entry => entry.type === 'directory')).toBe(true)
  })

  it('throws not-found for a container-only file', async () => {
    check.mockReturnValue({ exists: true, isDirectory: false })
    const fs = makeFs()
    await expect(fs.resolve('C:\\workspace\\file.txt')).rejects.toThrow()
  })
})

describe('DockerFileSystem per-workspace container routing', () => {
  const QA_ANCHOR = 'D:\\anchors\\gm-qa\\C\\workspace'

  beforeEach(() => {
    records.mockReturnValue([])
    owners.mockReturnValue([])
    pathOf.mockImplementation((entry) => (entry.containerPath ?? '') as string)
    workspace.mockReturnValue(undefined)
    inspect.mockReturnValue([]) // container-only: every path synthesizes
    check.mockReturnValue({ exists: true, isDirectory: true })
  })

  it('resolves a relative path against the session anchor workspace', async () => {
    anchor.mockReturnValue({ entry: { container: 'gm-qa', containerPath: 'C:\\workspace' }, anchor: QA_ANCHOR, remainder: '' })
    const fs = makeFs()
    const target = await fs.resolve('pyscript', { cwd: QA_ANCHOR })
    expect(String(target.targetKey)).toContain('docker-container://gm-qa/')
    expect(target.displayPath).toBe('C:\\workspace\\pyscript')
  })

  it('routes an absolute shared container path to the calling session\'s container', async () => {
    // Two containers present the same container path; the session cwd (anchor)
    // is what picks the container.
    anchor.mockImplementation((path) => path.toLowerCase().startsWith('d:\\anchors\\gm-trunk')
      ? { entry: { container: 'gm-trunk', containerPath: 'C:\\workspace' }, anchor: 'D:\\anchors\\gm-trunk\\C\\workspace', remainder: path.slice('D:\\anchors\\gm-trunk\\C\\workspace'.length).replace(/^\\/, '') }
      : undefined)
    const fs = makeFs()
    const target = await fs.resolve('C:\\workspace\\pyscript', { cwd: 'D:\\anchors\\gm-trunk\\C\\workspace' })
    expect(String(target.targetKey)).toContain('docker-container://gm-trunk/')
    expect(target.displayPath).toBe('C:\\workspace\\pyscript')
    expect(check).toHaveBeenCalledWith('gm-trunk', 'C:\\workspace\\pyscript')
  })

  it('translates an anchor spelling back to the container path', async () => {
    anchor.mockImplementation((path) => {
      if (path.toLowerCase().startsWith('d:\\anchors\\gm-qa')) {
        return { entry: { container: 'gm-qa', containerPath: 'C:\\workspace' }, anchor: QA_ANCHOR, remainder: path.slice(QA_ANCHOR.length).replace(/^\\/, '') }
      }
      return undefined
    })
    const fs = makeFs()
    const target = await fs.resolve('D:\\anchors\\gm-qa\\C\\workspace\\pyscript\\a.py')
    expect(String(target.targetKey)).toContain('docker-container://gm-qa/')
    expect(target.displayPath).toBe('C:\\workspace\\pyscript\\a.py')
  })

  it('fails loud when a container path is shared by several containers and no session context exists', async () => {
    owners.mockReturnValue([
      { key: 'D:\\anchors\\gm-qa\\C\\workspace', entry: { container: 'gm-qa', containerPath: 'C:\\workspace' } },
      { key: 'D:\\anchors\\gm-trunk\\C\\workspace', entry: { container: 'gm-trunk', containerPath: 'C:\\workspace' } },
    ])
    const fs = makeFs()
    await expect(fs.resolve('C:\\workspace\\pyscript')).rejects.toThrow(/gm-qa.*gm-trunk|gm-trunk.*gm-qa/)
  })
})
