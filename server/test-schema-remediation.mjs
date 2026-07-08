// Schema remediation and unknown-command guidance tests.
// Run from server/: node test-schema-remediation.mjs

import { z } from 'zod';

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import { executeMenhanceTool, initMenhanceTools } from './menhance-tcp-tools.mjs';

const t = new TestRunner('Schema Remediation Tests');

const fakeToolsYaml = {
  toolsets: {
    animation: {
      tools: {
        get_montage_full: {},
      },
    },
    'asset-registry': {
      tools: {
        get_asset_references: {},
      },
    },
  },
};

initMenhanceTools(fakeToolsYaml);

{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('get_montage_full', { status: 'success', result: {} });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeMenhanceTool('get_montage_full', { montage_path: '/Game/AM_Test' }, cm),
    /asset_path/i,
    'get_montage_full rejects montage_path and names canonical asset_path',
  );
}

{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('get_asset_references', { status: 'success', result: {} });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeMenhanceTool('get_asset_references', { assetPath: '/Game/A' }, cm),
    /asset_path/i,
    'get_asset_references rejects assetPath and names canonical asset_path',
  );
}

{
  const enableToolsetInputShape = z.object({
    toolsets: z.array(z.string()),
  });
  const parsed = enableToolsetInputShape.safeParse({ name: 'offline' });
  t.assert(
    parsed.success === false && /toolsets/i.test(String(parsed.error?.message)),
    'enable_toolset-style shape rejects name and names canonical toolsets',
    parsed.success ? 'unexpected success' : String(parsed.error?.message),
  );
}

{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('bogus_wire_command', {
    status: 'error',
    code: 'UNKNOWN_COMMAND',
    error: 'unknown command: bogus_wire_command',
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  let caught;
  try {
    await cm.send('tcp-55558', 'bogus_wire_command', {}, { skipCache: true });
  } catch (err) {
    caught = err;
  }

  t.assert(
    caught instanceof Error,
    'UNKNOWN_COMMAND rejects with an Error',
    caught ? String(caught) : 'resolved unexpectedly',
  );
  t.assert(
    /find_tools|tools\.yaml|public wrapper/i.test(caught?.message || ''),
    'UNKNOWN_COMMAND errors include next-action guidance',
  );
  t.assert(
    caught?.code === 'UNKNOWN_COMMAND',
    'UNKNOWN_COMMAND errors preserve err.code',
    `got ${JSON.stringify(caught?.code)}`,
  );
}

process.exit(t.summary());
