/**
 * Build the browser half into lib/client.js.
 *
 * DSH client plugins are NOT plain ES modules. The web shell fetches the
 * artifact and executes it directly, and the file is expected to hand itself
 * to the loader's module table as a closure factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } });
 *
 * The factory's `require` argument resolves the externals below out of that
 * table — React is the shell's own copy, so bundling it would put a second
 * React in the page.
 *
 * Format verified against two independent sources:
 *   - the preset that emits it: ../DSH/packages/client/tsdown.client.ts
 *   - a shipped artifact:      ~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/client.js
 * and against this workspace's own dsh-gomoku-panel, which ships the same shape.
 *
 * Nothing from @deepseek-ai/dsh-client-* is imported ON PURPOSE. Pulling a
 * rich row component (BashRow, FileMutationRow) would drag ui-primitives and
 * its CSS modules into this bundle, and those class names are content-hashed
 * per build — the copy would load with names the page's stylesheet never
 * defines. v41 sidesteps that entirely by letting DSH render its own rows.
 */
import * as esbuild from 'esbuild'

const ID = 'dsh-llm-claude-code'

/** Modules the loader's table supplies; everything else is inlined. */
const EXTERNAL = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']

await esbuild.build({
  entryPoints: ['src/client/index.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: EXTERNAL,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
