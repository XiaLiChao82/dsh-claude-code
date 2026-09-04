// Filename bump for cordis-plugin-loader: it re-imports only when `name` changes.
// Implementation lives in main.v20.mjs (v29: llm-claude-code.dshTools gates
// every bridged-tool effect v26/v27/v28 added, so turning it off reverts this
// plugin to its v25 behaviour exactly — no restart, no filename change).
//
// Do NOT read a vNN filename as "the code of version NN": v21 onward are all
// one-line re-exports of main.v20.mjs, and main.v20.mjs is edited in place.
// Pointing the profile row at an older shim loads TODAY's implementation under
// an older name. The dshTools flag is the only real rollback.
export * from './main.v20.mjs'
