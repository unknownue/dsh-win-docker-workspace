import { describe, expect, it } from 'vitest'
import { isDockerVariantId, transformPresetForDocker, variantIdFor } from '../src/host/variants.ts'

const SHELL = '/abs/dsh-win-docker-workspace/lib/shell.js'
const FS = '/abs/dsh-win-docker-workspace/lib/fs.js'

const SOURCE = [
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  '- id: tool-pwsh',
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '- id: tool-fs-search',
  "  name: '@deepseek-ai/dsh-tool-fs-search'",
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: |-',
  '      You are an agent.',
  '      Work carefully.',
  '- id: str-replace-editor',
  "  name: '@deepseek-ai/dsh-tool-str-replace-editor'",
].join('\n')

describe('transformPresetForDocker', () => {
  it('drops the execution-world rows and injects the Docker world group', () => {
    const out = transformPresetForDocker(SOURCE, SHELL, FS)
    expect(out).not.toContain('id: tool-bash')
    expect(out).not.toContain('id: tool-fs-search')
    expect(out).toContain('- id: tool-pwsh')
    expect(out).toContain('- id: tool-fs')
    expect(out).toContain('- id: docker-world')
    expect(out).toContain(`name: '${SHELL}'`)
    expect(out).toContain(`name: '${FS}'`)
    expect(out).toContain("name: '@deepseek-ai/dsh-tool-pwsh'")
    expect(out).toContain("name: '@deepseek-ai/dsh-tool-fs'")
  })

  it('keeps the editor row and re-injects the editor inside the world group', () => {
    const out = transformPresetForDocker(SOURCE, SHELL, FS)
    expect(out).toContain('id: str-replace-editor')
    expect(out).toContain("name: '@deepseek-ai/dsh-tool-str-replace-editor'")
    expect(out.indexOf('id: docker-world')).toBeLessThan(out.lastIndexOf("name: '@deepseek-ai/dsh-tool-str-replace-editor'"))
  })

  it('appends the Docker sentence to an appendable persona', () => {
    const out = transformPresetForDocker(SOURCE, SHELL, FS)
    expect(out).toContain('inside a Windows Docker container')
  })

  it('keeps unknown top-level rows verbatim', () => {
    const withUnknown = '- id: custom-thing\n  name: x\n' + SOURCE
    const out = transformPresetForDocker(withUnknown, SHELL, FS)
    expect(out).toContain('id: custom-thing')
  })
})

describe('variant ids', () => {
  it('derives the variant id and recognizes it', () => {
    expect(variantIdFor('standard')).toBe('win-docker-standard')
    expect(isDockerVariantId('win-docker-standard')).toBe(true)
    expect(isDockerVariantId('win-docker-code')).toBe(true)
    expect(isDockerVariantId('standard')).toBe(false)
    expect(isDockerVariantId('wsl-standard')).toBe(false)
  })
})
