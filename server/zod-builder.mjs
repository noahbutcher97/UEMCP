// zod-builder.mjs — Build Zod schemas from tools.yaml param definitions.
//
// Extracted from server.mjs so unit tests can exercise the schema builder
// without triggering server.mjs's top-level main() side-effect.
//
// Wire-protocol note (F-1): boolean and number types use z.coerce.* because
// some MCP client wrappers stringify typed params during transit. Without
// coercion, a caller passing { summarize_by_class: true } would arrive as
// { summarize_by_class: "true" } and fail Zod validation.

import { z } from 'zod';

export function buildZodSchema(params) {
  if (!params || Object.keys(params).length === 0) {
    return {};
  }

  const schema = {};
  for (const [name, def] of Object.entries(params)) {
    let field;
    switch (def.type) {
      case 'string':
        field = z.string();
        break;
      case 'integer':
      case 'number':
        field = z.coerce.number();
        break;
      case 'boolean':
        field = z.coerce.boolean();
        break;
      case 'array':
        field = z.array(def.items === 'string' ? z.string() : z.any());
        break;
      case 'object':
        field = z.record(z.any());
        break;
      default:
        field = z.any();
    }

    if (def.describe || def.description) {
      field = field.describe(def.describe || def.description || '');
    }

    if (!def.required) {
      field = field.optional();
      if (def.default !== undefined) {
        field = field.default(def.default);
      }
    }

    schema[name] = field;
  }
  return schema;
}
