// Retired legacy surface gate
// Run: cd D:\DevTools\UEMCP\server && node test-retired-legacy-surface.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from './test-helpers.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SERVER_DIR, '..');
const SELF_RELATIVE_PATH = 'server/test-retired-legacy-surface.mjs';

const CURRENT_FACING_PATHS = [
  'server',
  'plugin/UEMCP/Source/UEMCP',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'tools.yaml',
  'manifest.json',
  '.mcp.json.example',
  '.uemcp-targets.json.example',
  'setup-uemcp.bat',
  'migrate-targets.bat',
  'sync-plugin.bat',
  'verify-deploy.bat',
  'test-uemcp-gate.bat',
  'smoke-live.bat',
  'docs/README.md',
  'docs/specs/architecture.md',
  'docs/specs/dynamic-toolsets.md',
  'docs/specs/plugin-design.md',
  'docs/specs/tool-surface.md',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  'Binaries',
  'Intermediate',
  'DerivedDataCache',
  'Saved',
]);

const RETIRED_PATTERNS = [
  { name: 'UNREAL_TCP_PORT_EXISTING', pattern: /\bUNREAL_TCP_PORT_EXISTING\b/ },
  { name: 'tcpPortExisting', pattern: /\btcpPortExisting\b/ },
  { name: 'tcp-55557', pattern: /\btcp-55557\b/i },
  { name: 'legacy-port-55557', pattern: /\b55557\b/ },
  { name: 'unreal-mcp-main', pattern: /\bunreal-mcp-main\b/i },
  { name: 'UnrealMCP', pattern: /UnrealMCP/ },
];

function isRetirementNegativeAssertion(relativePath, line, retiredName) {
  const negativeAssertionLines = [
    "isLayerAvailable('tcp-55557', true)",
    "'retired tcp-55557 layer is not available'",
  ];
  const exemptPatterns = new Set(['tcp-55557', 'legacy-port-55557']);

  return relativePath === 'server/test-mock-seam.mjs'
    && exemptPatterns.has(retiredName)
    && negativeAssertionLines.some(assertion => line.includes(assertion));
}

function walk(path) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  if (!st.isDirectory()) return [];
  const base = path.split(/[\\/]/).pop();
  if (IGNORED_DIRS.has(base)) return [];
  return readdirSync(path).flatMap(name => walk(join(path, name)));
}

function shouldScan(file) {
  return /\.(mjs|js|json|yaml|yml|md|bat|h|cpp|cs|uplugin|uproject)$/i.test(file);
}

const files = CURRENT_FACING_PATHS
  .flatMap(p => walk(join(REPO_ROOT, p)))
  .filter(shouldScan)
  .filter(file => relative(REPO_ROOT, file).replaceAll('\\', '/') !== SELF_RELATIVE_PATH);
const hits = [];

for (const file of files) {
  const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const retired of RETIRED_PATTERNS) {
      if (isRetirementNegativeAssertion(rel, lines[i], retired.name)) continue;
      if (retired.pattern.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${retired.name}: ${lines[i].trim()}`);
      }
    }
  }
}

const t = new TestRunner('Retired Legacy Surface Gate');
t.assert(
  hits.length === 0,
  'current-facing surfaces do not mention retired bridge identifiers',
  hits.join('\n')
);

process.exit(t.summary());
