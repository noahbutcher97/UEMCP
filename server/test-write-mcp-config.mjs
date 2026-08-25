// test-write-mcp-config.mjs — pure-function tests for .mcp.json rendering + merge.
//
// The merge is the load-bearing part: onboarding renders the config from the
// repo template, so a wholesale write drops every unrelated MCP server the user
// configured. These assertions pin that behaviour down.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mergeMcpConfig,
  readPriorConfig,
  renderTemplate,
  REPO_PATH_PLACEHOLDER,
} from './write-mcp-config.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('write-mcp-config');

const TEMPLATE = JSON.stringify({
  mcpServers: {
    uemcp: {
      command: 'node',
      args: [`${REPO_PATH_PLACEHOLDER}/server/server.mjs`],
      env: { UNREAL_TCP_TIMEOUT_MS: '10000' },
    },
  },
}, null, 2);

// ── renderTemplate ───────────────────────────────────────────────
{
  const rendered = renderTemplate(TEMPLATE, 'D:/Repo/UEMCP');
  t.assert(rendered.mcpServers.uemcp.args[0] === 'D:/Repo/UEMCP/server/server.mjs',
    'repo path placeholder substituted');
  t.assert(rendered.mcpServers.uemcp.env.UEMCP_PROJECT_ATTACH_MODE === undefined,
    'attach mode absent without env mode');

  const envMode = renderTemplate(TEMPLATE, 'D:/Repo/UEMCP', {
    envMode: true, projectRootFwd: 'D:/Proj', projectName: 'Proj',
  });
  const env = envMode.mcpServers.uemcp.env;
  t.assert(env.UEMCP_PROJECT_ATTACH_MODE === 'env', 'env mode sets attach mode');
  t.assert(env.UNREAL_PROJECT_ROOT === 'D:/Proj', 'env mode sets project root');
  t.assert(env.UNREAL_PROJECT_NAME === 'Proj', 'env mode sets project name');
  t.assert(env.UNREAL_TCP_TIMEOUT_MS === '10000', 'env mode preserves template env');
}

// ── mergeMcpConfig ───────────────────────────────────────────────
{
  const rendered = renderTemplate(TEMPLATE, 'D:/Repo/UEMCP');

  t.assert(mergeMcpConfig(rendered, null).mcpServers.uemcp !== undefined,
    'no prior config yields the rendered template');

  const prior = {
    mcpServers: {
      uemcp: { command: 'node', args: ['stale.mjs'] },
      'jira-bridge': { command: 'node', args: ['jira.mjs'] },
      'perforce-bridge': { command: 'node', args: ['p4.mjs'] },
    },
  };
  const merged = mergeMcpConfig(rendered, prior);
  t.assert(merged.mcpServers['jira-bridge'] !== undefined
    && merged.mcpServers['perforce-bridge'] !== undefined,
    'unrelated MCP servers survive onboarding');
  t.assert(merged.mcpServers.uemcp.args[0] === 'D:/Repo/UEMCP/server/server.mjs',
    'onboarding is authoritative for the uemcp entry');
  t.assert(Object.keys(merged.mcpServers).length === 3, 'no servers dropped or duplicated');

  // Non-mcpServers top-level keys are user data too.
  const withExtras = mergeMcpConfig(rendered, { ...prior, someOtherKey: { a: 1 } });
  t.assert(withExtras.someOtherKey?.a === 1, 'unrelated top-level keys survive');

  // A prior file with no mcpServers is not a merge source.
  t.assert(mergeMcpConfig(rendered, { unrelated: true }).mcpServers.uemcp !== undefined,
    'prior without mcpServers falls back to rendered');
}

// ── readPriorConfig: malformed input must not abort onboarding ────
{
  const dir = mkdtempSync(join(tmpdir(), 'uemcp-mcpcfg-'));
  try {
    const missing = join(dir, 'absent.json');
    t.assert(readPriorConfig(missing) === null, 'absent file reads as null');

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ this is not json');
    t.assert(readPriorConfig(bad) === null, 'malformed file reads as null rather than throwing');

    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ mcpServers: { other: {} } }));
    t.assert(readPriorConfig(good)?.mcpServers?.other !== undefined, 'valid file parses');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(t.summary());
