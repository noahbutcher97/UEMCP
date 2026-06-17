// UEMCP stdio entrypoint.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createUemcpServer } from './create-uemcp-server.mjs';

const app = await createUemcpServer({
  env: process.env,
  cwd: process.cwd(),
  argv: process.argv,
});

try {
  await app.start(new StdioServerTransport());
} catch (err) {
  process.stderr.write(`[uemcp] Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
}
