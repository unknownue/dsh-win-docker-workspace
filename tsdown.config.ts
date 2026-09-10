import { defineConfig } from 'tsdown'

/**
 * Standalone build for dsh-win-docker-workspace. The host half emits three ESM
 * entry files (index/shell/fs) with every `@deepseek-ai/*` import left
 * external — the hosting DeepSeek Harness profile resolves them at runtime.
 * The browser half emits one `lib/client.js` closure registered through
 * `window.__ModuleLoader__.load`, with `react`/`react/jsx-runtime` left
 * external (provided by the host's module table).
 *
 * dsh 0.1.2 removed `@deepseek-ai/dsh-client-runtime` from the client module
 * graph and moved the plugin store engine to `@deepseek-ai/dsh-client-store` —
 * a package with NO `./client` export and no `dsh.client` manifest, so it can
 * never be a row of the browser module graph. It MUST be bundled into this
 * client artifact instead of being required at runtime: a `require()` for a
 * module with no graph row makes the client module system throw loud, which
 * aborts the whole web app boot when this plugin is enabled.
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
    external: (id: string) => /^react/.test(id) || (/^@deepseek-ai\//.test(id) && !id.startsWith('@deepseek-ai/dsh-client-store')),
    // immer/zustand dev branches reference process.env.NODE_ENV, which the
    // browser module system does not define; pin them to production drops.
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: 'window.__ModuleLoader__.load({ id: "dsh-win-docker-workspace", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    outputOptions: {
      entryFileNames: 'client.js',
    },
  },
])
