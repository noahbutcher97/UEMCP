// Exercise advertised output schemas through the official SDK client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createUemcpServer } from './create-uemcp-server.mjs';
import { cleanupCanonicalScratchRoot, createCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Connection Info Official Client Tests');
const prefix = 'uemcp-connection-info-client-';
const scratchRoot = createCanonicalScratchRoot(prefix);
// Generic directory names keep stdio attachment out of the codename ledger.
const root = join(scratchRoot, 'fixtures', 'uemcp-fixture');
mkdirSync(root, { recursive: true });
const emptyWorkspace = join(scratchRoot, 'empty');
mkdirSync(emptyWorkspace);
const uprojectPath = join(root, 'SchemaFixture.uproject');
writeFileSync(uprojectPath, '{"FileVersion":3}\n');

async function checkInfo(client, args, label) {
  // listTools populates the SDK's output validators; do not bypass callTool.
  await client.listTools();
  const result = await client.callTool({ name: 'connection_info', arguments: args });
  t.assert(!result.isError, `${label}: successful tool result`);
  const payload = result.structuredContent;
  t.assert(payload?.editor && payload?.deploy, `${label}: readiness diagnostics retained`);
  t.assert(JSON.stringify(JSON.parse(result.content[0].text)) === JSON.stringify(payload), `${label}: text and structured content agree`);
  return payload;
}

try {
  // Deterministic readiness coverage, without an editor or proprietary assets.
  const app = await createUemcpServer({
    env: {}, cwd: emptyWorkspace, workspaceRoots: [], writeProjectCodenames: false,
    stderr: { write() {} },
    processInspector: () => [],
    deployInspector: () => ({ state: 'stale', code: 'DEPLOY_STALE' }),
    tcpCommandFn: async (_port, type) => ({
      status: 'success',
      result: type === 'get_editor_state' ? {
        project_root: root, uproject_path: uprojectPath,
        project_name: 'SchemaFixture', deploy_marker_present: true,
      } : {},
    }),
    httpCommandFn: async () => ({ status: 'success', result: {} }),
  });
  const client = new Client({ name: 'connection-info-regression', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await app.start(serverTransport);
    await client.connect(clientTransport);
    const unattached = await checkInfo(client, {}, 'unattached');
    t.assert(unattached.projectContext.identity === null, 'unattached session has no project identity');
    await client.callTool({ name: 'attach_project', arguments: {
      uproject_path: uprojectPath, allow_outside_client_roots: true,
    } });
    const refreshed = await checkInfo(client, { force_reconnect: true }, 'attached refresh');
    t.assert(refreshed.editor.state === 'verified', 'plugin handshake verifies fixture identity');
    t.assert(refreshed.deploy.code === 'DEPLOY_STALE', 'stale deploy diagnostic survives validation');
    const cached = await checkInfo(client, {}, 'attached cached');
    t.assert(cached.readiness.deployFreshness === 'stale', 'cached deploy readiness retained');
  } catch (error) {
    t.assert(false, 'official client in-memory lifecycle', error.stack);
  } finally {
    await client.close();
    await app.server.close();
  }

  // Also exercise the real stdio entrypoint, including MCP workspace roots.
  const stdioClient = new Client({ name: 'connection-info-stdio', version: '1.0.0' }, {
    capabilities: { roots: { listChanged: true } },
  });
  let rootsRequests = 0;
  stdioClient.setRequestHandler(ListRootsRequestSchema, () => {
    rootsRequests += 1;
    return { roots: [{ uri: pathToFileURL(root).href, name: 'SchemaFixture' }] };
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
    cwd: emptyWorkspace, env: { UEMCP_PROJECT_ATTACH_MODE: 'workspace' }, stderr: 'pipe',
  });
  try {
    await stdioClient.connect(transport);
    // Initialization requests roots asynchronously; await a completed refresh
    // before asserting attachment rather than relying on process scheduling.
    await stdioClient.callTool({ name: 'refresh_project_context', arguments: {} });
    const payload = await checkInfo(stdioClient, {}, 'stdio roots attachment');
    t.assert(rootsRequests > 0, 'server requested workspace roots');
    t.assert(payload.projectContext.identity?.projectName === 'SchemaFixture', 'stdio session attached to synthetic root');
  } catch (error) {
    t.assert(false, 'official client stdio lifecycle', error.stack);
  } finally {
    await stdioClient.close();
  }
} finally {
  cleanupCanonicalScratchRoot(scratchRoot, prefix);
}

process.exit(t.summary());
