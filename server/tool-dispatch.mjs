// D202 generic dispatcher.
//
// Clients that snapshot tools/list once and ignore tools/list_changed can
// discover a dynamic tool through find_tools but never call it natively. The
// dispatchers make every registered dynamic tool callable regardless of its
// SDK visibility, without re-implementing anything the native path does: the
// arguments are validated with the SDK's own helpers against the handle's own
// schema, then handed to the same invoke closure the SDK was registered with,
// which carries the project guard, mutation tracking and executor. Parity is
// by construction.

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParseAsync,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

import { isMutationRequirement } from './tool-requirements.mjs';

export const READ_DISPATCHER = 'call_tool';
export const MUTATING_DISPATCHER = 'call_mutating_tool';
export const DISPATCHER_NAMES = Object.freeze([READ_DISPATCHER, MUTATING_DISPATCHER]);

export const DESCRIBE_TOOL_DESCRIPTION = 'Return one tool\'s input schema, description, annotations, and the dispatcher that runs it, without enabling its toolset. Use with call_tool or call_mutating_tool when a tool found by find_tools is not in your tool list.';
export const CALL_TOOL_DESCRIPTION = 'Call any read-only UEMCP tool by name, even when your client has not refreshed its tool list. Same validation, project checks, and result as calling the tool directly. Mutating tools are refused; use call_mutating_tool.';
export const CALL_MUTATING_TOOL_DESCRIPTION = 'Call any mutating UEMCP tool by name, even when your client has not refreshed its tool list. Same validation, project and ownership checks, mutation tracking, security gates, and result as calling the tool directly. Read-only tools are refused; use call_tool.';

export const DISPATCH_ERROR_CODES = Object.freeze({
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  WRONG_DISPATCHER: 'WRONG_DISPATCHER',
});

// Mirrors the SDK's tools/list fallback for a tool with no object schema.
const EMPTY_OBJECT_JSON_SCHEMA = Object.freeze({ type: 'object', properties: {} });

/** The dispatcher that runs a tool of this requirement class. */
export function dispatcherFor(requirement) {
  return isMutationRequirement(requirement) ? MUTATING_DISPATCHER : READ_DISPATCHER;
}

/**
 * Registry of dispatchable dynamic tools. Only registerToolGroup adds to it, so
 * management tools and status: planned tools (never registered) are absent.
 */
export class ToolDispatchRegistry {
  constructor() {
    this._entries = new Map();
  }

  /**
   * @param {string} name
   * @param {{handle: object, invoke: Function, toolsetName: string, requirement: string}} entry
   */
  add(name, entry) {
    if (this._entries.has(name)) throw new Error(`Tool ${name} is already dispatchable`);
    if (typeof entry.invoke !== 'function') throw new Error(`Tool ${name} has no invoke closure`);
    this._entries.set(name, Object.freeze({ ...entry }));
  }

  get(name) {
    return this._entries.get(name) || null;
  }

  get size() {
    return this._entries.size;
  }

  /** The tools/list view of one tool, produced exactly as the SDK produces it. */
  describe(name) {
    const entry = this.get(name);
    if (!entry) return notFound(name);
    const { handle } = entry;
    const obj = normalizeObjectSchema(handle.inputSchema);
    return {
      ok: true,
      tool: name,
      toolset: entry.toolsetName,
      description: handle.description,
      inputSchema: obj
        ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' })
        : EMPTY_OBJECT_JSON_SCHEMA,
      annotations: handle.annotations,
      requirement: entry.requirement,
      dispatcher: dispatcherFor(entry.requirement),
    };
  }

  /**
   * Validate and run one tool through the named dispatcher. Returns the native
   * CallToolResult verbatim. Validation failures throw the same McpError the
   * SDK's tools/call throws, so the client sees identical text.
   */
  async call(dispatcherName, name, args, extra) {
    const entry = this.get(name);
    if (!entry) return errorResult(notFound(name));

    const expected = dispatcherFor(entry.requirement);
    if (expected !== dispatcherName) return errorResult(wrongDispatcher(name, dispatcherName, expected));

    const { handle } = entry;
    const schema = normalizeObjectSchema(handle.inputSchema) ?? handle.inputSchema;
    let parsedArgs = args;
    if (schema) {
      const parsed = await safeParseAsync(schema, args ?? {});
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(parsed.error)}`,
        );
      }
      parsedArgs = parsed.data;
    }
    return await entry.invoke(parsedArgs, extra);
  }
}

function notFound(name) {
  return {
    ok: false,
    code: DISPATCH_ERROR_CODES.TOOL_NOT_FOUND,
    message: `No dispatchable tool named "${name}". Management tools are called directly; planned tools are not registered. Use find_tools to discover tool names.`,
    next: { tool: 'find_tools' },
  };
}

function wrongDispatcher(name, used, expected) {
  return {
    ok: false,
    code: DISPATCH_ERROR_CODES.WRONG_DISPATCHER,
    message: `${name} must be called through ${expected}, not ${used}.`,
    next: { tool: expected },
  };
}

function errorResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
