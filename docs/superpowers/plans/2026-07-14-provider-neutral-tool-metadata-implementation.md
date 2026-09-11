# Provider-Neutral Tool Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make UEMCP's initial discovery surface concise, provider-neutral, size-bounded, SDK-current, and accurately annotated from the existing tool requirement classifier.

**Architecture:** Extract server guidance and annotation policy into focused, pure modules. Register dynamic and management tools through `McpServer.registerTool`, derive annotation hints from the existing requirement result plus an explicit management-state classification, and prove identical observable behavior for representative and unknown client identities over the real MCP wire fixture.

**Tech Stack:** Node.js 22 ES modules, MCP TypeScript SDK 1.29.x, Zod 3, YAML tool definitions, existing `FakeMcpTransport` and `TestRunner` fixtures.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-14-deployment-integrity-and-multi-client-installation-design.md`, especially Server Discoverability and Approval Metadata.
- Keep total server instructions below 2,048 UTF-8 bytes and put UEMCP's category, when to use it, `connection_info`, and `find_tools(query)` within the first 512 UTF-8 bytes.
- Keep every tool description at or below 1,800 UTF-8 bytes.
- Remove client-native tool names and provider brands from server instructions and runtime tips. Documentation may identify tested clients where the distinction is operationally necessary.
- Derive read/mutation annotations from `getToolRequirement`; do not add a second tool-by-tool mutation registry.
- Treat `connection_info`, `detect_project`, `find_tools`, `enable_toolset`, `disable_toolset`, `attach_project`, `detach_project`, and `refresh_project_context` as management session-state tools because they can reconnect, refresh cached context, change attachment, or change exposed tools. Treat `list_toolsets` and `list_project_targets` as pure management inspection.
- Set live/RC/Python mutations conservatively to `destructiveHint: true`. Set management session-state changes to `destructiveHint: false`.
- Omit `idempotentHint` and `openWorldHint` everywhere in this slice.
- Keep runtime project guards authoritative. Annotations are untrusted client hints.
- Preserve dynamic toolsets, initial management-only behavior, roots fallback, elicitation fallback, `notifications/tools/list_changed`, structured management output, and existing tool call behavior.

---

## File Structure

- Create `server/tool-annotations.mjs`: pure conversion from requirement kind and management tool name to frozen MCP annotations.
- Create `server/server-guidance.mjs`: provider-neutral `SERVER_INSTRUCTIONS`, toolset tips, and UTF-8 byte-budget helpers.
- Create `server/test-provider-conformance.mjs`: wire-level client identity, instructions, description, annotations, capability-fallback, and tool-list invariance tests.
- Modify `server/create-uemcp-server.mjs`: import the helpers and register every tool with the supported `registerTool` API and annotations.
- Modify `server/tool-requirements.mjs`: export only the management-session-state set if needed by both policy and tests; keep mutation classification behavior unchanged.
- Modify `server/test-tool-requirements.mjs`: lock the management state classification and annotation matrix.
- Modify `server/test-tool-metadata.mjs`: enforce the 1,800-byte description budget for all `tools.yaml` and additional tool definitions.
- Modify `server/test-mcp-wire.mjs`: replace the test-local deprecated `server.tool` call with `registerTool` without changing wire assertions.
- Modify `tools.yaml`: shorten `read_asset_properties` metadata without changing its input schema or runtime result.
- Modify `docs/specs/tool-surface.md`: retain detailed offline property parser coverage, reason codes, result semantics, and proof boundaries outside the wire description.

---

### Task 1: Lock The Annotation Policy With Failing Tests

**Files:**
- Create: `server/tool-annotations.mjs`
- Modify: `server/test-tool-requirements.mjs`

**Interfaces:**

```js
export const MANAGEMENT_SESSION_STATE_TOOLS = Object.freeze(new Set([
  'connection_info',
  'detect_project',
  'find_tools',
  'enable_toolset',
  'disable_toolset',
  'attach_project',
  'detach_project',
  'refresh_project_context',
]));

export function getToolAnnotations(toolName, requirement);
// -> a new frozen object containing only readOnlyHint and optional destructiveHint
```

- [ ] **Step 1: Add the failing table-driven annotation test**

In `server/test-tool-requirements.mjs`, import `getToolAnnotations` and assert this complete matrix:

```js
const cases = [
  ['project_info', TOOL_REQUIREMENT_KINDS.OFFLINE_READ, { readOnlyHint: true }],
  ['get_editor_state', TOOL_REQUIREMENT_KINDS.LIVE_READ, { readOnlyHint: true }],
  ['rc_get_property', TOOL_REQUIREMENT_KINDS.RC_READ, { readOnlyHint: true }],
  ['create_blueprint', TOOL_REQUIREMENT_KINDS.LIVE_MUTATION, { readOnlyHint: false, destructiveHint: true }],
  ['rc_set_property', TOOL_REQUIREMENT_KINDS.RC_MUTATION, { readOnlyHint: false, destructiveHint: true }],
  ['run_python_command', TOOL_REQUIREMENT_KINDS.PYTHON_EXEC, { readOnlyHint: false, destructiveHint: true }],
  ['list_toolsets', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: true }],
  ['list_project_targets', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: true }],
  ['connection_info', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['detect_project', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['find_tools', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['enable_toolset', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['disable_toolset', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['attach_project', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['detach_project', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['refresh_project_context', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
];
```

For every returned object, assert it is frozen, contains neither `idempotentHint` nor `openWorldHint`, and is not the same object instance as another call.

Run:

```powershell
cd D:\DevTools\UEMCP\server
node test-tool-requirements.mjs
```

Expected: fail with `ERR_MODULE_NOT_FOUND` for `tool-annotations.mjs`.

- [ ] **Step 2: Implement the exact pure mapping**

Create `server/tool-annotations.mjs` with one switch over `TOOL_REQUIREMENT_KINDS`. Return `{ readOnlyHint: true }` for the three read kinds; return `{ readOnlyHint: false, destructiveHint: true }` for the three mutation kinds; for management, test `MANAGEMENT_SESSION_STATE_TOOLS` and return either session-state or pure-inspection annotations. Throw `Unknown tool requirement kind: <value>` for an unrecognized kind so a new classifier value cannot silently inherit an unsafe default.

The implementation must not import `tools.yaml`, duplicate `LIVE_MUTATION_OVERRIDES`, or special-case any non-management tool name.

- [ ] **Step 3: Run the focused requirement tests**

Run `node test-tool-requirements.mjs`.

Expected: all existing classifier assertions and the new annotation assertions pass.

- [ ] **Step 4: Commit Task 1**

```powershell
git add server/tool-annotations.mjs server/test-tool-requirements.mjs
git commit -m "Add requirement-derived MCP tool annotations"
```

---

### Task 2: Move Every Tool To The Supported Registration API

**Files:**
- Modify: `server/create-uemcp-server.mjs`
- Modify: `server/test-mcp-wire.mjs`
- Modify: `server/test-tool-metadata.mjs`

**Interfaces:**

```js
function registerToolGroup(server, toolsetManager, projectContext, log,
  toolsetName, label, defs, schemaBuilder, executor);

function registerManagementTool(name, configObject, handler);
```

Both helpers must call:

```js
server.registerTool(name, {
  description: def.description,
  inputSchema: schemaBuilder(def),
  annotations: getToolAnnotations(name, requirement),
}, handler);
```

Management tools retain `outputSchema: MANAGEMENT_OUTPUT_SHAPE` and pass `TOOL_REQUIREMENT_KINDS.MANAGEMENT` to the annotation helper.

- [ ] **Step 1: Add failing source and wire assertions**

Extend `server/test-tool-metadata.mjs` to assert that production `create-uemcp-server.mjs` contains no `.tool(` call and that every `tools/list` row exposes `annotations`. Extend `server/test-mcp-wire.mjs` to register its local fixture tool with `registerTool` and assert the wire response still exposes the same name, description, schema, and handler behavior.

Run:

```powershell
node test-tool-metadata.mjs
node test-mcp-wire.mjs
```

Expected: metadata test fails because production still calls `server.tool`; wire test remains red until its fixture registration is migrated.

- [ ] **Step 2: Migrate dynamic registration**

In `registerToolGroup`, preserve the existing guard, mutation accounting, logging, error result, disabled handle, and `toolsetManager.registerToolHandle` flow. Change only registration configuration:

```js
const requirement = getToolRequirement(name, toolsetName, def);
const handle = server.registerTool(
  name,
  {
    description: def.description,
    inputSchema: schemaBuilder(def),
    annotations: getToolAnnotations(name, requirement),
  },
  async (args) => { /* existing handler body unchanged */ },
);
```

Do not convert Zod shape objects to JSON Schema manually; the SDK accepts the existing shape.

- [ ] **Step 3: Annotate management registration**

Add `annotations: getToolAnnotations(name, TOOL_REQUIREMENT_KINDS.MANAGEMENT)` in `registerManagementTool`. Preserve `outputSchema` and each existing handler. Add a startup assertion that the explicit management-state set contains only registered management names and that every registered management name receives one of the two tested policies.

- [ ] **Step 4: Migrate the test-local SDK call and run focused tests**

Replace `server.tool(name, description, shape, handler)` in `server/test-mcp-wire.mjs` with `server.registerTool(name, { description, inputSchema: shape }, handler)`.

Run:

```powershell
node test-tool-requirements.mjs
node test-tool-metadata.mjs
node test-mcp-wire.mjs
node test-project-server-wire.mjs
```

Expected: all focused suites pass; dynamic enable/disable and list-changed assertions remain unchanged.

- [ ] **Step 5: Commit Task 2**

```powershell
git add server/create-uemcp-server.mjs server/test-mcp-wire.mjs server/test-tool-metadata.mjs
git commit -m "Register all tools through the supported MCP SDK API"
```

---

### Task 3: Extract Provider-Neutral Guidance And Enforce Byte Budgets

**Files:**
- Create: `server/server-guidance.mjs`
- Modify: `server/create-uemcp-server.mjs`
- Modify: `server/test-tool-metadata.mjs`
- Modify: `tools.yaml`
- Modify: `docs/specs/tool-surface.md`

**Interfaces:**

```js
export const SERVER_INSTRUCTIONS = '<joined provider-neutral text>';
export const TOOLSET_TIPS = Object.freeze({ /* current tip structure */ });
export const utf8Bytes = value => Buffer.byteLength(value, 'utf8');
export const SERVER_PREFIX_LIMIT_BYTES = 512;
export const SERVER_INSTRUCTION_LIMIT_BYTES = 2048;
export const TOOL_DESCRIPTION_LIMIT_BYTES = 1800;
```

- [ ] **Step 1: Write failing guidance-budget tests**

Move budget assertions into `server/test-tool-metadata.mjs` and require:

```js
t.assert(utf8Bytes(SERVER_INSTRUCTIONS) < 2048, 'server instructions are below 2 KiB');
t.assert(
  SERVER_INSTRUCTIONS.slice(0, 512).includes('connection_info') &&
  SERVER_INSTRUCTIONS.slice(0, 512).includes('find_tools(query)'),
  'first 512 characters contain the discovery workflow',
);
```

Also perform the real byte-prefix test by truncating a UTF-8 buffer to 512 bytes and decoding it. Assert the prefix contains `Unreal Engine`, when-to-use wording, `connection_info`, and `find_tools(query)`. Scan instructions and every flattened tip case-insensitively for these forbidden tokens: `Claude`, `Codex`, `Gemini`, `ChatGPT`, `` `Read` ``, `` `Grep` ``, and `` `Glob` ``. Scan every registered description with `Buffer.byteLength(description, 'utf8') <= 1800` and print the offending tool name and byte count on failure.

Run `node test-tool-metadata.mjs`.

Expected: fail on the existing native-tool tips and the oversized `read_asset_properties` description.

- [ ] **Step 2: Extract and replace server instructions**

Create `server/server-guidance.mjs` and begin `SERVER_INSTRUCTIONS` with this exact text so the first 512 UTF-8 bytes are self-contained:

```text
UEMCP provides Unreal Engine project, asset, Blueprint, level, animation, editor, and runtime tools. Use it for UE-specific inspection or mutation that ordinary filesystem and search tools cannot perform. Start with connection_info to verify project, deployment, and editor context. Call find_tools(query) to discover and enable the smallest relevant toolset. Offline tools read project files without an editor; live tools require the matching editor.
```

Append concise guidance for disabling unused toolsets, progressive `list_config_values`, and gameplay-tag globs while remaining under 2,048 bytes. Replace native-tool tips with:

```text
Use the client's native source-search capability to find C++ class names under Source/, then use get_actor_properties to inspect level instances.
```

and:

```text
Use the client's native source-search capability to inspect C++ base-class signatures before adding function or event nodes. Confirm event names exactly.
```

Import `SERVER_INSTRUCTIONS` and `TOOLSET_TIPS` into `create-uemcp-server.mjs`; keep `collectTips` behavior unchanged.

- [ ] **Step 3: Replace the oversized wire description without losing durable semantics**

Replace only `read_asset_properties.description` in `tools.yaml` with this bounded description:

```text
Read serialized UPROPERTY values from a selected .uasset/.umap export. The default is the Blueprint CDO or primary asset export; use export_index from list_asset_exports when names are duplicated. Supports common scalar, reference, gameplay-tag, engine-struct, array, set, scalar-key map, and field-path values. Unsupported layouts return explicit markers and reason codes rather than being skipped. property_names adds one status row per requested name. max_bytes bounds decoded payload and reports truncation. include_subobjects performs bounded same-package traversal with depth, row, and aggregate payload limits. Results prove serialized values only; absent fields do not prove inherited native or Blueprint defaults. Collision summaries appear only for serialized collision/profile/BodyInstance data.
```

Add a `read_asset_properties parser contract` section to `docs/specs/tool-surface.md` containing the full reason-code taxonomy, supported struct/container list, export-selection reasons, requested-property statuses, subobject decode statuses, collision caveat, and aggregate budget behavior removed from the wire description. The documentation must explicitly say it is durable parser reference, not additional tool-wire metadata.

- [ ] **Step 4: Run the byte-budget and regression tests**

Run:

```powershell
node test-tool-metadata.mjs
node test-project-server-wire.mjs
node test-offline-asset-info.mjs
```

Expected: all available assertions pass; the offline fixture suite may skip only under its existing documented project gate, not because of metadata changes.

- [ ] **Step 5: Commit Task 3**

```powershell
git add server/server-guidance.mjs server/create-uemcp-server.mjs server/test-tool-metadata.mjs tools.yaml docs/specs/tool-surface.md
git commit -m "Make UEMCP discovery guidance provider neutral"
```

---

### Task 4: Add Brand-Invariant MCP Conformance Coverage

**Files:**
- Create: `server/test-provider-conformance.mjs`
- Modify: `server/create-uemcp-server.mjs` only if a capability bug is exposed

**Interfaces:**

The test uses the real `createUemcpServer`, `FakeMcpTransport`, `initialize`, `tools/list`, and `tools/call` wire path. Client cases are:

```js
const clients = [
  { name: 'claude-code', version: '2.1.210' },
  { name: 'codex', version: '0.144.4' },
  { name: 'gemini-cli', version: '0.41.2' },
  { name: 'visual-studio-code', version: '1.128.1' },
  { name: 'unknown-mcp-host', version: '9.9.9' },
];
```

- [ ] **Step 1: Add the failing conformance fixture**

For every client identity, initialize once with no roots/elicitation capability and once with roots plus form elicitation. Capture and normalize:

- initialize `serverInfo`, capabilities, and instructions;
- initial management tool names, descriptions, schemas, and annotations;
- `connection_info` response with no project;
- `find_tools` response while unattached;
- tool names after attaching the same temporary fixture project;
- tool names and one list-changed notification after enabling the same toolset.

Remove only request IDs, timestamps, and temporary absolute paths. Deep-compare every normalized snapshot to the unknown-host baseline. Separately assert roots-capable clients resolve the same unambiguous root, clients without roots use the current inherited-workspace fallback, and clients without elicitation receive `ELICITATION_UNAVAILABLE` rather than a brand-specific branch.

Run `node test-provider-conformance.mjs`.

Expected: fail until annotations and extracted guidance are visible on the wire; no assertion may whitelist a client brand.

- [ ] **Step 2: Close only capability-driven differences**

If the fixture finds a difference, change code only when it is keyed by negotiated `capabilities`, project roots, or explicit request arguments. Do not inspect `clientInfo.name` to select instructions, tools, schemas, annotations, or toolset behavior. Preserve existing roots and elicitation fallbacks.

- [ ] **Step 3: Run the conformance and wire suites**

Run:

```powershell
node test-provider-conformance.mjs
node test-mcp-wire.mjs
node test-project-server-wire.mjs
```

Expected: all client snapshots match except the explicitly capability-derived root/elicitation results.

- [ ] **Step 4: Commit Task 4**

```powershell
git add server/test-provider-conformance.mjs server/create-uemcp-server.mjs
git commit -m "Add provider-neutral MCP conformance coverage"
```

---

### Task 5: Run The Metadata Release Gate

**Files:**
- Verify only; fix only files already named in this plan if a regression is found.

- [ ] **Step 1: Run the focused suites from `server/`**

```powershell
node test-tool-requirements.mjs
node test-tool-metadata.mjs
node test-provider-conformance.mjs
node test-mcp-wire.mjs
node test-project-server-wire.mjs
```

Expected: every suite exits `0` with no unexpected skip.

- [ ] **Step 2: Run static policy scans**

```powershell
rg -n "server\.tool\(|\.tool\(" create-uemcp-server.mjs test-mcp-wire.mjs
rg -n "Claude|Codex|Gemini|ChatGPT|`Read`|`Grep`|`Glob`" create-uemcp-server.mjs server-guidance.mjs
```

Expected: first command finds no deprecated registrations; second finds no provider/native-tool guidance. A provider name in the conformance test data is expected and is outside this scan.

- [ ] **Step 3: Run the default rotation**

```powershell
node run-rotation.mjs --json
```

Expected: all non-live assertions pass. Existing environment-gated fixture/live suites may report their documented skips.

- [ ] **Step 4: Review the diff and commit any verification-only correction**

```powershell
git diff --check
git status --short
```

Expected: only files named in this plan are modified and there is no whitespace error. If no correction was required, do not create an empty commit.

- [ ] **Step 5: Request review and merge before Plan 2**

The PR description must include instruction/description byte counts, the explicit management-state tool set, focused test totals, default rotation total, and a statement that no client installation behavior changed in this PR.
