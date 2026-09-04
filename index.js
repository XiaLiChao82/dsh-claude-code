// Stable package entry for the `dsh-llm-claude-code` bundle.
//
// WHY THIS FILE EXISTS, given main.vNN.mjs already sits next to it:
//   The vNN filenames are a DEVELOPMENT device, not versions. cordis's plugin
//   loader re-imports a row only when its `name` changes, so bumping the
//   filename was how a hand-mounted profile row picked up edits without a
//   restart. Every vNN from v21 on is a one-line re-export of main.v20.mjs,
//   and main.v20.mjs is edited in place (see the header of main.v29.mjs).
//
//   A published bundle is referenced BY PACKAGE NAME, not by file path, so
//   that device no longer applies — and an entry whose name carries a version
//   would force `main`/`exports` to churn on every edit. This file is the
//   fixed entry the package manifest points at; the vNN shims stay in the repo
//   for hand-mounted development but are excluded from the published `files`.
//
// `export *` deliberately does not forward a default export: DSH's hard rule
// is that function plugins expose only named `name` / `inject` / `Config` /
// `apply`, and a default export would make the loader drop the namespace.
export * from './main.v20.mjs'
