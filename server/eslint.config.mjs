// Minimal lint gate (D188). Enforces exactly two hygiene rules — nothing more:
//   - no-empty:   swallowed-error guard, applies everywhere (blocks that contain only
//                 a comment, e.g. `catch { /* why */ }`, are NOT flagged — that's
//                 ESLint's own default behavior, not a config exemption here).
//   - no-console: production code (the module graph reachable from server.mjs /
//                 create-uemcp-server.mjs) may not use console.log/info/debug;
//                 console.warn/console.error remain allowed everywhere for genuine
//                 diagnostics.
//
// CLI/standalone/test files legitimately print to stdout and are exempt from
// no-console (but still subject to no-empty). Membership was verified by grepping
// the import graph rooted at server.mjs/create-uemcp-server.mjs — a file lands here
// only if nothing in that graph imports it, directly or transitively:
//   - test-*.mjs                     — rotation test files
//   - run-rotation.mjs                — rotation runner CLI
//   - verify-deploy.mjs               — Q3-A verify-deploy CLI
//   - sync-plugin-helper.mjs          — W-L deploy-marker CLI helper
//   - migrate-targets.mjs             — one-shot targets-file migration CLI
//   - _bench-*.mjs                    — transport benchmark spike (test-only)
//   - run-live-smoke.mjs, live-smoke-*.mjs — opt-in live-editor smoke CLI scripts
//   - oracle-freshness.mjs, rotation-oracle-freshness.mjs — only imported by
//     run-rotation.mjs and test-*.mjs; never reached from the MCP server path
const CLI_ONLY_GLOBS = [
  'test-*.mjs',
  'run-rotation.mjs',
  'verify-deploy.mjs',
  'sync-plugin-helper.mjs',
  'migrate-targets.mjs',
  '_bench-*.mjs',
  'run-live-smoke.mjs',
  'live-smoke-*.mjs',
  'oracle-freshness.mjs',
  'rotation-oracle-freshness.mjs',
];

export default [
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-empty': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: CLI_ONLY_GLOBS,
    rules: {
      'no-console': 'off',
    },
  },
];
