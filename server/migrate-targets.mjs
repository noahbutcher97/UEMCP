#!/usr/bin/env node
// migrate-targets.mjs - Convert legacy .uemcp-targets.txt into structured profiles.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateLegacyTargetsToProfiles } from './project-targets.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

function parseArgs(argv) {
  const flags = {
    from: join(REPO_ROOT, '.uemcp-targets.txt'),
    to: join(REPO_ROOT, '.uemcp-targets.json'),
    profiles: ['default', 'smoke', 'release-gate'],
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') flags.from = argv[++i] || '';
    else if (arg === '--to') flags.to = argv[++i] || '';
    else if (arg === '--profiles') {
      flags.profiles = String(argv[++i] || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    } else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--no-color') {
      // Accepted for consistency with other UEMCP CLIs.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

function printHelp() {
  console.log(`migrate-targets.mjs - migrate legacy UEMCP target lists to structured profiles.

Usage:
  node server/migrate-targets.mjs [flags]
  migrate-targets.bat [flags]

Flags:
  --from <path>       legacy .uemcp-targets.txt path
                      default: <repo>/.uemcp-targets.txt
  --to <path>         structured .uemcp-targets.json path
                      default: <repo>/.uemcp-targets.json
  --profiles <list>   comma-separated profiles to seed
                      default: default,smoke,release-gate
  --json              emit machine-readable JSON only
  --help, -h          show this help

The migration is idempotent and merges into an existing JSON config without
removing existing targets or profile entries.`);
}

function printPlain(result) {
  if (result.status === 'missing') {
    console.error(`[ERROR] Legacy targets file not found: ${result.legacyTargetsPath}`);
    return;
  }
  if (result.status === 'empty') {
    console.log(`[WARN] No targets found in ${result.legacyTargetsPath}`);
    return;
  }
  console.log(`Migrated targets source : ${result.legacyTargetsPath}`);
  console.log(`Structured targets     : ${result.configPath}`);
  console.log(`Profiles               : ${result.profiles.join(', ')}`);
  console.log(`Status                 : ${result.status}`);
  for (const item of result.migrated) {
    console.log(`  - ${item.status.toUpperCase()}: ${item.alias} -> ${item.entry}`);
  }
}

function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    printHelp();
    return 2;
  }

  if (flags.help) {
    printHelp();
    return 0;
  }

  const result = migrateLegacyTargetsToProfiles({
    legacyTargetsPath: flags.from,
    configPath: flags.to,
    profiles: flags.profiles,
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printPlain(result);
  }
  return result.status === 'missing' ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  process.exit(main());
}
