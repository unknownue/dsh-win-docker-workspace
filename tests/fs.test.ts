import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('../src/shared/docker.ts', () => ({
  inspectMountsSync: vi.fn(),
  checkContainerPathSync: vi.fn(),
  listContainerDirSync: vi.fn(),
}))

vi.mock('../src/shared/win-docker-workspaces.ts', () => ({
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
}))

import { DockerFileSystem } from '../src/fs.ts'
import { checkContainerPathSync, inspectMountsSync, listContainerDirSync } from '../src/shared/docker.ts'
import { getWorkspace, listWorkspaces } from '../src/shared/win-docker-workspaces.ts'

const inspect = vi.mocked(inspectMountsSync)
const check = vi.mocked(checkContainerPathSync)
const listDir = vi.mocked(listContainerDirSync)
const workspace = vi.mocked(getWorkspace)
const workspaces = vi.mocked(listWorkspaces)

function makeFs(): DockerFileSystem {
  const ctx = { reflect: { provide: vi.fn() } } as unknown as Context
  return new DockerFileSystem(ctx, { diffBasisMaxBytes: 10 * 1024 * 1024 })
}

describe('DockerFileSystem container-only directories', () => {
  beforeEach(() => {
    workspaces.mockReturnValue([])
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
