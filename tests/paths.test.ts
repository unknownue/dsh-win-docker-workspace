import { describe, expect, it } from 'vitest'
import {
  commonAncestor,
  containerChildPath,
  containsMount,
  isWindowsDrivePath,
  isValidContainerName,
  isValidShellName,
  isWithinWorkspace,
  mapContainerToHost,
  mapHostToContainer,
  normalizeWindowsPath,
  type BindMount,
} from '../src/shared/paths.ts'

const mounts: readonly BindMount[] = [
  { source: 'E:\\Work\\GM10\\trunk_branch\\code\\client\\script', destination: 'C:\\workspace\\pyscript' },
  { source: 'E:\\Work\\GM10\\trunk_branch\\code\\client_csharp\\game_project', destination: 'C:\\workspace\\csscript' },
  { source: 'E:\\Workspace\\shared\\docs', destination: 'C:\\workspace\\docs' },
]

describe('normalizeWindowsPath', () => {
  it('folds forward slashes, uppercases the drive, and strips a trailing separator', () => {
    expect(normalizeWindowsPath('c:/workspace/pyscript/')).toBe('C:\\workspace\\pyscript')
    expect(normalizeWindowsPath('C:\\workspace\\pyscript')).toBe('C:\\workspace\\pyscript')
    expect(normalizeWindowsPath('c:')).toBe('C:\\')
  })

  it('collapses repeated separators', () => {
    expect(normalizeWindowsPath('C:\\\\workspace//pyscript')).toBe('C:\\workspace\\pyscript')
  })
})

describe('mapContainerToHost / mapHostToContainer', () => {
  it('maps a mount root exactly', () => {
    expect(mapContainerToHost('C:\\workspace\\pyscript', mounts)).toBe('E:\\Work\\GM10\\trunk_branch\\code\\client\\script')
  })

  it('maps a descendant through the longest matching mount', () => {
    expect(mapContainerToHost('C:\\workspace\\pyscript\\sub\\a.py', mounts)).toBe('E:\\Work\\GM10\\trunk_branch\\code\\client\\script\\sub\\a.py')
  })

  it('returns null outside every mount', () => {
    expect(mapContainerToHost('C:\\windows\\system32', mounts)).toBeNull()
  })

  it('round-trips container→host→container', () => {
    const host = mapContainerToHost('C:\\workspace\\csscript\\Assets', mounts)
    expect(host).not.toBeNull()
    expect(mapHostToContainer(host as string, mounts)).toBe('C:\\workspace\\csscript\\Assets')
  })

  it('is case-insensitive on the drive letter and path', () => {
    expect(mapContainerToHost('c:\\workspace\\docs\\a.md', mounts)).toBe('E:\\Workspace\\shared\\docs\\a.md')
  })
})

describe('isWithinWorkspace', () => {
  const roots = ['C:\\workspace\\pyscript', 'C:\\workspace\\docs']

  it('matches a root and its descendants', () => {
    expect(isWithinWorkspace('C:\\workspace\\pyscript', roots)).toBe(true)
    expect(isWithinWorkspace('C:\\workspace\\pyscript\\sub\\x.py', roots)).toBe(true)
    expect(isWithinWorkspace('c:\\workspace\\docs', roots)).toBe(true)
  })

  it('rejects unrelated paths', () => {
    expect(isWithinWorkspace('C:\\workspace\\csscript', roots)).toBe(false)
    expect(isWithinWorkspace('E:\\other', roots)).toBe(false)
  })
})

describe('containerChildPath', () => {
  it('joins a child under a root', () => {
    expect(containerChildPath('C:\\workspace\\pyscript', 'sub')).toBe('C:\\workspace\\pyscript\\sub')
  })
})

describe('commonAncestor', () => {
  it('finds the shared parent of mount destinations', () => {
    expect(commonAncestor(['C:\\workspace\\pyscript', 'C:\\workspace\\csscript', 'C:\\workspace\\engine'])).toBe('C:\\workspace')
  })

  it('returns the drive root when paths share only the drive', () => {
    expect(commonAncestor(['C:\\pyscript', 'C:\\csscript'])).toBe('C:\\')
  })

  it('is case-insensitive and normalizes separators', () => {
    expect(commonAncestor(['c:/workspace/pyscript', 'C:\\workspace\\docs'])).toBe('C:\\workspace')
  })

  it('returns null for an empty input', () => {
    expect(commonAncestor([])).toBeNull()
  })
})

describe('containsMount', () => {
  it('is true when a mount destination is a strict descendant', () => {
    expect(containsMount('C:\\workspace', mounts)).toBe(true)
    expect(containsMount('c:\\workspace', mounts)).toBe(true)
  })

  it('is false when the path is inside a mount or unrelated', () => {
    expect(containsMount('C:\\workspace\\pyscript', mounts)).toBe(false)
    expect(containsMount('C:\\windows', mounts)).toBe(false)
  })
})

describe('validators', () => {
  it('validates container names strictly', () => {
    expect(isValidContainerName('gm-trunk')).toBe(true)
    expect(isValidContainerName('gm_trunk.2')).toBe(true)
    expect(isValidContainerName('-bad')).toBe(false)
    expect(isValidContainerName('has space')).toBe(false)
    expect(isValidContainerName('a/b')).toBe(false)
  })

  it('validates shell names strictly', () => {
    expect(isValidShellName('powershell.exe')).toBe(true)
    expect(isValidShellName('pwsh')).toBe(true)
    expect(isValidShellName('cmd.exe')).toBe(true)
    expect(isValidShellName('pwsh -c')).toBe(false)
    expect(isValidShellName('..\\evil.exe')).toBe(false)
  })

  it('recognizes Windows drive paths', () => {
    expect(isWindowsDrivePath('C:\\workspace')).toBe(true)
    expect(isWindowsDrivePath('c:/workspace')).toBe(true)
    expect(isWindowsDrivePath('/home/user')).toBe(false)
  })
})
