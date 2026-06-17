import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';

export class FakeMcpTransport {
  constructor({ timeoutMs = 3000 } = {}) {
    this._outbound = [];
    this._started = false;
    this._closed = false;
    this._nextClientId = 1;
    this._timeoutMs = timeoutMs;
  }

  async start() {
    if (this._started) throw new Error('FakeMcpTransport already started');
    if (this._closed) throw new Error('FakeMcpTransport is closed');
    this._started = true;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this.onclose?.();
  }

  async send(message) {
    this._assertOpen();
    this._outbound.push(message);
  }

  injectMessage(message) {
    this._assertOpen();
    if (!this.onmessage) {
      throw new Error('onmessage not installed; did you forget server.connect(transport)?');
    }
    return this.onmessage(message);
  }

  async sendClientRequest(method, params = {}) {
    const id = this._nextClientId++;
    this.injectMessage(makeJsonRpcMessage({ id, method, params }));
    return this.waitForResponse(id);
  }

  async sendClientNotification(method, params = {}) {
    await this.injectMessage(makeJsonRpcMessage({ method, params }));
  }

  drainNotifications(method) {
    return this._drain(message => !hasId(message) && message.method === method);
  }

  drainServerRequests(method) {
    return this._drain(message => isServerRequest(message) && message.method === method);
  }

  async waitForResponse(id, timeoutMs = this._timeoutMs) {
    return this._waitFor(
      message => hasId(message) && !message.method && message.id === id,
      `response id ${id}`,
      timeoutMs
    );
  }

  async waitForServerRequest(method, timeoutMs = this._timeoutMs) {
    return this._waitFor(
      message => isServerRequest(message) && message.method === method,
      `server request ${method}`,
      timeoutMs
    );
  }

  async respondToServerRequest(method, result = {}) {
    const request = await this.waitForServerRequest(method);
    await this.injectMessage({ jsonrpc: '2.0', id: request.id, result });
    return request;
  }

  async rejectServerRequest(method, code = -32603, message = 'Rejected by FakeMcpTransport') {
    const request = await this.waitForServerRequest(method);
    await this.injectMessage({
      jsonrpc: '2.0',
      id: request.id,
      error: { code, message },
    });
    return request;
  }

  _assertOpen() {
    if (!this._started) throw new Error('FakeMcpTransport not started');
    if (this._closed) throw new Error('FakeMcpTransport is closed');
  }

  _drain(predicate) {
    const matches = [];
    const keep = [];
    for (const message of this._outbound) {
      if (predicate(message)) matches.push(message);
      else keep.push(message);
    }
    this._outbound = keep;
    return matches;
  }

  async _waitFor(predicate, label, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = this._drain(predicate);
      if (matches.length > 0) return matches[0];
      await new Promise(resolve => setImmediate(resolve));
    }
    const preview = JSON.stringify(this._outbound).slice(0, 300);
    throw new Error(`Timed out waiting for ${label}; outbound=${preview}`);
  }
}

function hasId(message) {
  return Object.prototype.hasOwnProperty.call(message, 'id');
}

function isServerRequest(message) {
  return hasId(message) && typeof message.method === 'string';
}

function makeJsonRpcMessage({ id, method, params }) {
  const message = { jsonrpc: '2.0', method };
  if (id !== undefined) message.id = id;
  if (params !== undefined) message.params = params;
  return message;
}

async function runCase(t, name, fn) {
  console.log(`\n-- ${name} --`);
  try {
    await fn();
  } catch (err) {
    t.assert(false, name, err.stack || err.message);
  }
}

export async function runFakeTransportSelfTests() {
  const t = new TestRunner('MCP Fake Transport');

  await runCase(t, 'server notifications are drainable by method', async () => {
    const transport = new FakeMcpTransport();
    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: { reason: 'self-test' },
    });

    const notifications = transport.drainNotifications('notifications/tools/list_changed');
    t.assert(notifications.length === 1, `drained one notification (got ${notifications.length})`);
    t.assert(notifications[0].params.reason === 'self-test', 'notification payload is preserved');
  });

  await runCase(t, 'client requests resolve from server responses', async () => {
    const transport = new FakeMcpTransport();
    transport.onmessage = async (message) => {
      if (message.method === 'ping') {
        await transport.send({ jsonrpc: '2.0', id: message.id, result: { pong: true } });
      }
    };
    await transport.start();

    const response = await transport.sendClientRequest('ping', { value: 7 });
    t.assert(response.result?.pong === true, 'client request receives matching response');
  });

  await runCase(t, 'client notifications are delivered to onmessage', async () => {
    const transport = new FakeMcpTransport();
    let received = null;
    transport.onmessage = (message) => {
      received = message;
    };
    await transport.start();

    await transport.sendClientNotification('notifications/roots/list_changed', { changed: true });
    t.assert(received?.method === 'notifications/roots/list_changed', 'notification method delivered');
    t.assert(received?.params.changed === true, 'notification params delivered');
  });

  await runCase(t, 'server requests are drainable and respondable', async () => {
    const transport = new FakeMcpTransport();
    const inbound = [];
    transport.onmessage = (message) => {
      inbound.push(message);
    };
    await transport.start();

    await transport.send({ jsonrpc: '2.0', id: 41, method: 'roots/list', params: {} });
    const drained = transport.drainServerRequests('roots/list');
    t.assert(drained.length === 1, `drained one roots/list request (got ${drained.length})`);
    t.assert(drained[0].id === 41, 'server request id is preserved');

    await transport.send({ jsonrpc: '2.0', id: 42, method: 'elicitation/create', params: {} });
    const request = await transport.respondToServerRequest('elicitation/create', {
      action: 'accept',
      content: { project_path: 'D:/Example/Example.uproject' },
    });

    t.assert(request.id === 42, 'respondToServerRequest returns the matched request');
    t.assert(
      inbound.some(message => message.id === 42 && message.result?.action === 'accept'),
      'response is delivered back to the server-side onmessage handler'
    );
  });

  await runCase(t, 'server requests can be rejected', async () => {
    const transport = new FakeMcpTransport();
    const inbound = [];
    transport.onmessage = (message) => {
      inbound.push(message);
    };
    await transport.start();

    await transport.send({ jsonrpc: '2.0', id: 43, method: 'roots/list', params: {} });
    const request = await transport.rejectServerRequest('roots/list', -32001, 'roots disabled');

    t.assert(request.id === 43, 'rejectServerRequest returns the matched request');
    t.assert(
      inbound.some(message =>
        message.id === 43 &&
        message.error?.code === -32001 &&
        message.error?.message === 'roots disabled'
      ),
      'error response is delivered back to the server-side onmessage handler'
    );
  });

  return t.summary();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await runFakeTransportSelfTests());
}
