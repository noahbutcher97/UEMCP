// write-mcp-config.mjs — render .mcp.json from the repo template.
//
// Why this exists: setup-uemcp.bat used to inline this as a `node -e` one-liner.
// That string had to survive CMD quoting *and* JS escaping at once, which is how
// a `\n` ended up splitting the .bat line in half. Logic that needs escapes
// belongs in a file, where it can also be unit-tested.
//
// The merge behaviour is the point: the config is rendered from the template, so
// a wholesale write silently discarded every unrelated MCP server the user had
// configured whenever they onboarded a second project.
//
// Usage: node write-mcp-config.mjs <templatePath> <targetPath> <repoPathFwd>
// Env: SETUP_ENV_MODE=1 plus PROJECT_ROOT_FWD / PROJECT_NAME for env-mode attach.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_PATH_PLACEHOLDER = '<UEMCP_REPO_PATH>';

/**
 * Merge a rendered template over any pre-existing config.
 *
 * Entries the template defines win (onboarding is authoritative for uemcp);
 * every other server the user had is preserved.
 *
 * @param {object} rendered parsed template, already path-substituted
 * @param {object|null} prior parsed existing .mcp.json, or null when absent/unreadable
 * @returns {object} the config to write
 */
export function mergeMcpConfig(rendered, prior) {
  if (!prior || typeof prior !== 'object' || !prior.mcpServers) return rendered;
  return {
    ...prior,
    ...rendered,
    mcpServers: { ...prior.mcpServers, ...rendered.mcpServers },
  };
}

/**
 * Parse an existing config defensively. A malformed file must not abort
 * onboarding — the template alone is still a valid result.
 *
 * @param {string} targetPath
 * @returns {object|null}
 */
export function readPriorConfig(targetPath) {
  try {
    if (!existsSync(targetPath)) return null;
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} templateText
 * @param {string} repoPathFwd forward-slash repo path substituted into the template
 * @param {{envMode?: boolean, projectRootFwd?: string, projectName?: string}} [opts]
 */
export function renderTemplate(templateText, repoPathFwd, opts = {}) {
  const substituted = templateText.split(REPO_PATH_PLACEHOLDER).join(repoPathFwd);
  const parsed = JSON.parse(substituted);
  const uemcp = parsed?.mcpServers?.uemcp;
  if (uemcp && opts.envMode) {
    const env = uemcp.env || (uemcp.env = {});
    env.UEMCP_PROJECT_ATTACH_MODE = 'env';
    if (opts.projectRootFwd) env.UNREAL_PROJECT_ROOT = opts.projectRootFwd;
    if (opts.projectName) env.UNREAL_PROJECT_NAME = opts.projectName;
  }
  return parsed;
}

function main() {
  const [templatePath, targetPath, repoPathFwd] = process.argv.slice(2);
  if (!templatePath || !targetPath || !repoPathFwd) {
    console.error('usage: node write-mcp-config.mjs <templatePath> <targetPath> <repoPathFwd>');
    process.exit(1);
  }
  const rendered = renderTemplate(readFileSync(templatePath, 'utf8'), repoPathFwd, {
    envMode: process.env.SETUP_ENV_MODE === '1',
    projectRootFwd: process.env.PROJECT_ROOT_FWD,
    projectName: process.env.PROJECT_NAME,
  });
  const merged = mergeMcpConfig(rendered, readPriorConfig(targetPath));
  writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n');
  const kept = Object.keys(merged.mcpServers || {}).filter((k) => k !== 'uemcp');
  if (kept.length > 0) console.log(`Preserved existing MCP servers: ${kept.join(', ')}`);
}

// Entry-point detection by resolved path, not suffix: the test file's name
// also ends with this module's filename, so a suffix check fires main() on
// import. Mirrors sync-plugin-helper.mjs.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
