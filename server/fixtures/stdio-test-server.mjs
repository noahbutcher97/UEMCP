// Test-only launcher: use the production server factory and transport without
// registering disposable fixture names in the developer checkout's NDA files.
// Production server.mjs deliberately has no environment switch for this.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createUemcpServer } from '../create-uemcp-server.mjs';

const app = await createUemcpServer({
  env: process.env,
  cwd: process.cwd(),
  argv: process.argv,
  writeProjectCodenames: false,
});
await app.start(new StdioServerTransport());
