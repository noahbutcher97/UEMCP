const mode = process.argv[2] ?? 'normal';
let buffer = '';

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function initializeResult(request) {
  const version = mode === 'report-launch'
    ? `${process.env.SMOKE_ENV_PROBE ?? 'missing'}|${process.cwd()}`
    : process.env.PATH ? '1.0.0-path-present' : '1.0.0-no-path';
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: 'sample-mcp',
        version,
      },
      instructions: 'Sample MCP peer for bounded deployment protocol checks.',
    },
  };
}

function handle(request) {
  if (request.method === 'initialize') {
    if (mode === 'hang-initialize') return;
    if (mode === 'exit-early') {
      process.exit(3);
      return;
    }
    if (mode === 'invalid-initialize') {
      process.stdout.write('not-json\n');
      return;
    }
    if (mode === 'fail-initialize') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'initialize rejected' } });
      return;
    }
    send(initializeResult(request));
    return;
  }
  if (request.method === 'tools/list') {
    if (mode === 'hang-tools') return;
    if (mode === 'fail-tools') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'tools unavailable' } });
      return;
    }
    if (mode === 'invalid-tools') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools: 'invalid' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'sample_tool',
          description: 'A deterministic sample tool.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      },
    });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      process.exitCode = 2;
    }
  }
});
