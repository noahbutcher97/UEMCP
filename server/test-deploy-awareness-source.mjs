// Deploy-awareness source wiring guard.
// Run from server/: node test-deploy-awareness-source.mjs
// This proves source wiring only; target deploy proof remains verify-deploy.bat + smoke-live.bat.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import { missingSourceNeedles } from './test-tool-surface-helpers.mjs';

const t = new TestRunner('Deploy Awareness Source Guard');

const serverSource = await readFile('create-uemcp-server.mjs', 'utf-8');
const projectContextSource = await readFile('project-context.mjs', 'utf-8');
const verifyDeploySource = await readFile('verify-deploy.mjs', 'utf-8');
const verifyDeployBatSource = await readFile(join('..', 'verify-deploy.bat'), 'utf-8');
const smokeLiveBatSource = await readFile(join('..', 'smoke-live.bat'), 'utf-8');
const smokeLiveSource = await readFile('run-live-smoke.mjs', 'utf-8');

const serverNeedles = [
  'refreshDeployReadinessForConnectionInfo',
  'refreshEditorReadinessForConnectionInfo',
  "'get_editor_state'",
  "{ skipCache: true }",
  'readiness',
  'deployFreshness',
];
t.assert(
  missingSourceNeedles(serverSource, serverNeedles).length === 0,
  'connection_info force reconnect keeps editor identity and deploy freshness wired',
  missingSourceNeedles(serverSource, serverNeedles).join(', '),
);

const projectContextNeedles = [
  'refreshEditorHandshake',
  'plugin_version',
  'deploy_marker_manifest_version',
  'deployMarkerManifestVersion',
  'deployFreshnessState',
];
t.assert(
  missingSourceNeedles(projectContextSource, projectContextNeedles).length === 0,
  'ProjectContext consumes plugin handshake and deploy marker fields',
  missingSourceNeedles(projectContextSource, projectContextNeedles).join(', '),
);

const verifyDeployNeedles = [
  'MISSING',
  'NEEDS-SYNC',
  'NEEDS-BUILD',
  'NEEDS-DEPLOY',
  'ALL-SYNC',
];
t.assert(
  missingSourceNeedles(verifyDeploySource, verifyDeployNeedles).length === 0,
  'verify-deploy distinguishes missing, sync, build, deploy, and fresh states',
  missingSourceNeedles(verifyDeploySource, verifyDeployNeedles).join(', '),
);

t.assert(
  /verify-deploy\.mjs/.test(verifyDeployBatSource) &&
    /pushd\s+"%~dp0server"/.test(smokeLiveBatSource) &&
    /run-live-smoke\.mjs/.test(smokeLiveBatSource) &&
    /UEMCP_LIVE_SMOKE/.test(smokeLiveSource),
  'deploy proof remains in explicit verify-deploy and opt-in smoke-live entrypoints',
);

process.exit(t.summary());
