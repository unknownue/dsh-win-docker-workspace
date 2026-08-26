import { defineConfig } from 'tsdown'

/**
 * Standalone build for dsh-win-docker-workspace. The host half emits three ESM
 * entry files (index/shell/fs) with every `@deepseek-ai/*` import left
 * external — the hosting DeepSeek Harness profile resolves them at runtime.
 * The browser half emits one `lib/client.js` closure registered through
 * `window.__ModuleLoader__.load`, with `react`/`react/jsx-runtime` and every
 * `@deepseek-ai/*` import left external (resolved from the loader module
 * table at runtime, e.g. `defineStore` from the client runtime).
 */
export default defineConfig([
  {
    name: 'dsh-win-docker-workspace',
    entry: {
      index: 'src/index.ts',
      shell: 'src/shell.ts',
      fs: 'src/fs.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    fixedExtension: false,
    external: [/^@deepseek-ai\//],
  },
  {
    name: 'dsh-win-docker-workspace/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [/^react/, /^@deepseek-ai\//],
    banner: 'window.__ModuleLoader__.load({ id: "dsh-win-docker-workspace", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    outputOptions: {
      entryFileNames: 'client.js',
    },
  },
])
