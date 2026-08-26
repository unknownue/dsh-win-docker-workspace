/**
 * Docker preset-variant generator. For every healthy source preset the roster
 * supplies, a `win-docker-<id>` variant is materialized under the roster's user
 * root: the source composition with its shell/filesystem world replaced by the
 * Docker providers, so any mode (standard, minimal, code, cordis, user
 * presets) can run on top of a Docker execution world. The execution world is
 * therefore orthogonal to the mode instead of a mode itself.
 *
 * The transformation is text-level on the top-level rows of the composition
 * (the shape all shipped presets share), with surgical edits for the known
 * special groups; unknown shapes are kept verbatim where possible.
 * @module dsh-win-docker-workspace/host/variants
 */

/** Top-level rows that name the execution world and are replaced by the variant's own. */
const WORLD_ROWS = new Set(['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'filesystem', 'persistent-shell'])

/** The injected Docker world group: providers + the pwsh/fs consumers, entry-local. */
function dockerWorldGroup(shellPath: string, fsPath: string, includeEditor: boolean): string {
  return [
    '# ── Docker execution world (dsh-win-docker-workspace variant) ───────────',
    '# The shell and fs services are provided entry-locally (the isolate',
    '# realm); host services (tools registry, shell-env, jobs) fall through.',
    '# tool-fs-search is intentionally absent: the packaged ripgrep runs on',
    '# the Windows host and cannot open container paths; Docker sessions',
    '# search with shell tools instead.',
    '- id: docker-world',
    "  name: cordis:group",
    '  group: true',
    '  isolate:',
    '    shell: true',
    '    fs: true',
    '  config:',
    '    - id: shell-docker',
    `      name: '${shellPath.replace(/'/g, "''")}'`,
    '    - id: fs-docker',
    `      name: '${fsPath.replace(/'/g, "''")}'`,
    '    - id: tool-pwsh',
    "      name: '@deepseek-ai/dsh-tool-pwsh'",
    '    - id: tool-fs',
    "      name: '@deepseek-ai/dsh-tool-fs'",
    ...(includeEditor
      ? [
          '    - id: str-replace-editor',
          "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
          '      config:',
          '        maxOutputChars: 16000',
        ]
      : []),
    '',
  ].join('\n')
}

/** The sentence appended to a standard-like persona when the variant runs in Docker. */
const PERSONA_APPEND = ' Your working directory {{cwd}} is inside a Windows Docker container: the pwsh tool and the file read/write/edit tools use container paths (like C:\\workspace\\...), and the files are bind-mounted source directories on the host.'

/** The top-level rows of one composition, as (startLine, endLineExclusive) spans. */
function topLevelSpans(lines: readonly string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let start = -1
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.startsWith('- id: ') === true) {
      if (start >= 0) spans.push({ start, end: index })
      start = index
    }
  }
  if (start >= 0) spans.push({ start, end: lines.length })
  return spans
}

/** The row id of a top-level span, or undefined when the first line is malformed. */
function spanId(lines: readonly string[], span: { start: number; end: number }): string | undefined {
  return /^- id: ([A-Za-z0-9_.-]+)/.exec(lines[span.start] ?? '')?.[1]
}

/** Whether a top-level span is a `persona` row with an appendable folded text. */
function appendablePersona(lines: readonly string[], span: { start: number; end: number }): boolean {
  const block = lines.slice(span.start, span.end).join('\n')
  if (!block.includes('complete: true') && /text: [>|-]/.test(block)) {
    // Append only when the folded text actually has content lines.
    const textLine = block.split('\n').find(line => /^(\s*)text: [>|-]/.test(line))
    if (textLine !== undefined) {
      const indent = /^(\s*)/.exec(textLine)?.[1]?.length ?? 0
      return block.split('\n').some(line => line.length > indent && /^\s+/.test(line) && !line.includes(':'))
    }
  }
  return false
}

/** Append the Docker sentence to a persona row's folded text (in place of its last text line). */
function appendPersona(lines: readonly string[], span: { start: number; end: number }): string[] {
  const block = lines.slice(span.start, span.end)
  const textIndex = block.findIndex(line => /^(\s*)text: [>|-]/.test(line))
  if (textIndex < 0) return [...block]
  const indent = /^(\s*)/.exec(block[textIndex] ?? '')?.[1]?.length ?? 0
  let lastText = -1
  for (let index = textIndex + 1; index < block.length; index++) {
    const line = block[index] ?? ''
    if (line.trim() === '') continue
    if (line.length > indent && /^\s+/.test(line)) lastText = index
  }
  if (lastText < 0) return [...block]
  const updated = [...block]
  const textIndent = /^(\s*)/.exec(block[lastText] ?? '')?.[1] ?? '  '
  updated.splice(lastText + 1, 0, `${textIndent}${PERSONA_APPEND}`)
  return updated
}

/**
 * Transform one source preset composition into its Docker variant: drop the
 * execution-world rows, keep everything else verbatim, and append the Docker
 * world group. The persistent-shell group is dropped without replacement
 * (deferred: `docker exec -it` PTY terminal support).
 * @param source - the source composition text.
 * @param shellPath - absolute path of the plugin's built Docker shell provider.
 * @param fsPath - absolute path of the plugin's built Docker fs provider.
 * @returns the variant composition text.
 */
export function transformPresetForDocker(source: string, shellPath: string, fsPath: string): string {
  const lines = source.split('\n')
  const spans = topLevelSpans(lines)
  const kept: string[] = []
  let sawEditor = false
  let personaAppended = false
  for (const span of spans) {
    const id = spanId(lines, span)
    if (id === undefined) {
      kept.push(...lines.slice(span.start, span.end))
      continue
    }
    if (WORLD_ROWS.has(id)) continue
    if (id === 'persona' && !personaAppended && appendablePersona(lines, span)) {
      kept.push(...appendPersona(lines, span))
      personaAppended = true
      continue
    }
    kept.push(...lines.slice(span.start, span.end))
    if (id === 'str-replace-editor') sawEditor = true
  }
  if (source.includes('str-replace-editor')) sawEditor = true
  const result = [...kept]
  if (result.length > 0 && result[result.length - 1] !== '') result.push('')
  result.push(dockerWorldGroup(shellPath, fsPath, sawEditor))
  return result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
}

/** Whether an id is one of this plugin's own preset directories. */
export function isDockerVariantId(id: string): boolean {
  return /^win-docker-[a-z0-9-]+$/.test(id)
}

/** Whether an id is another execution world's variant (the WSL plugin's `wsl-*`). */
export function isForeignVariantId(id: string): boolean {
  return id === 'wsl' || /^wsl-[a-z0-9-]+$/.test(id)
}

/** The variant id for one source preset id. */
export function variantIdFor(sourceId: string): string {
  return `win-docker-${sourceId.toLowerCase()}`
}
