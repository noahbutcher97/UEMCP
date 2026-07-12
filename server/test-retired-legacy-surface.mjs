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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const retiredPort = ['555', '57'].join('');
const retiredLayer = ['tcp', retiredPort].join('-');
const retiredBridge = ['Unreal', 'MCP'].join('');
const retiredEnv = ['UNREAL_TCP', 'PORT_EXISTING'].join('_');
const retiredConfigKey = ['tcpPort', 'Existing'].join('');
const retiredBundle = ['unreal', 'mcp', 'main'].join('-');

const RETIRED_PATTERNS = [
  { name: 'retired-env', pattern: new RegExp(`\\b${escapeRegExp(retiredEnv)}\\b`) },
  { name: 'retired-config-key', pattern: new RegExp(`\\b${escapeRegExp(retiredConfigKey)}\\b`) },
  { name: 'retired-layer', pattern: new RegExp(`\\b${escapeRegExp(retiredLayer)}\\b`, 'i') },
  { name: 'retired-port', pattern: new RegExp(`\\b${escapeRegExp(retiredPort)}\\b`) },
  { name: 'retired-bundle', pattern: new RegExp(`\\b${escapeRegExp(retiredBundle)}\\b`, 'i') },
  { name: 'retired-bridge', pattern: new RegExp(escapeRegExp(retiredBridge)) },
];

function isAllowedNegativeAssertion(relativePath, line, retiredName) {
  return relativePath === 'server/test-mock-seam.mjs'
    && retiredName === 'retired-layer'
    && line.includes('isLayerAvailable(retiredTcpLayer, true)');
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
      if (isAllowedNegativeAssertion(rel, lines[i], retired.name)) continue;
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
