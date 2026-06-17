# Project Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement session-local UEMCP project attachment so the server auto-attaches only from unambiguous workspace topology, stays unresolved in ambiguous tool workspaces, uses explicit manual attachment on demand, and reports project, editor, deploy, and transport readiness as separate facts.

**Architecture:** Add a ProjectContext layer between MCP lifecycle/config and all project-scoped handlers. ProjectContext owns canonical `.uproject` identity, MCP roots, candidates, attach mode, generation, reset events, and readiness facts. ConnectionManager becomes transport/cache health only and receives the currently attached project root from ProjectContext. ToolsetManager gates project-scoped tool visibility from ProjectContext readiness rather than ambient env.

**Tech Stack:** Node.js ES modules, `@modelcontextprotocol/sdk` v1.29.0 installed under `server/node_modules`, Zod, js-yaml, PowerShell-backed Windows process inspection, Unreal Engine C++ plugin under `plugin/UEMCP`, existing batch wrappers and test rotation.

---

## Source Inputs

- Spec: `docs/superpowers/specs/2026-06-16-project-attachment-design.md`
- Current server entrypoint: `server/server.mjs`
- Current connection ownership: `server/connection-manager.mjs`
- Current tool visibility: `server/toolset-manager.mjs`
- Current registry: `tools.yaml`
- Current editor/deploy identity logic: `server/verify-deploy.mjs`, `server/sync-plugin-helper.mjs`
- Current MCP wire harness: `server/test-mcp-wire.mjs`
- Current fixture helpers: `server/test-helpers.mjs`, `server/fixtures/uemcp-fixture/UEMCPFixture.uproject`
- Current live smoke files in the dirty worktree: `server/live-smoke-harness.mjs`, `server/run-live-smoke.mjs`, `smoke-live.bat`
- Config/docs to migrate: `.mcp.json.example`, `setup-uemcp.bat`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/specs/configuration.md`, `docs/specs/architecture.md`, `docs/specs/dynamic-toolsets.md`

## Research Checkpoints

At the start of implementation, and again before final verification, refresh these primary sources and write findings to `docs/reports/project-attachment-research-2026-06-16.md`.

- [ ] Review MCP lifecycle docs: `https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle`
  - Acceptance: report confirms initialization order, initialized notification timing, negotiated capability rule, and timeout/cancellation expectations.
- [ ] Review MCP roots docs: `https://modelcontextprotocol.io/specification/2025-06-18/client/roots`
  - Acceptance: report confirms `roots/list`, `file://` roots, `roots.listChanged`, root-change notification behavior, and root boundary expectations.
- [ ] Review MCP elicitation docs: `https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation`
  - Acceptance: report confirms negotiated-only usage, `accept`/`decline`/`cancel`, non-sensitive input rule, and flat primitive schema restriction.
- [ ] Review MCP tools docs: `https://modelcontextprotocol.io/specification/2025-06-18/server/tools`
  - Acceptance: report confirms `tools/list_changed`, `outputSchema`, `structuredContent`, and tool-result error behavior.
- [ ] Review MCP security docs: `https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices`
  - Acceptance: report confirms scope minimization and local-server compromise implications for outside-root attachment warnings.
- [ ] Refresh SDK usage with Context7 for `/modelcontextprotocol/typescript-sdk/v1.29.0`.
  - Acceptance: report includes exact current SDK APIs for `McpServer.registerTool`, `server.server.getClientCapabilities()`, `server.server.listRoots()`, `server.server.elicitInput()`, `server.server.oninitialized`, and `sendToolListChanged()`.
- [ ] Verify local SDK code before coding.

Run from `D:\DevTools\UEMCP`:

```powershell
node -e "const p=require('./server/node_modules/@modelcontextprotocol/sdk/package.json'); console.log(p.version)"
rg -n "getClientCapabilities\(|listRoots\(|elicitInput\(|sendToolListChanged\(|registerTool" server\node_modules\@modelcontextprotocol\sdk\dist\esm\server
```

Expected output:

- First command prints `1.29.0`.
- Second command shows hits in `server/index.js`, `server/index.d.ts`, `server/mcp.js`, and `server/mcp.d.ts`.

Stop condition:

- If the installed SDK no longer exposes those APIs, do not continue with code edits. Update the research report with the incompatible API evidence and patch this implementation plan first.

## Context Refresh Checkpoints

Run these before the first code edit, before every large phase handoff, and before the final audit:

```powershell
git status --short
Get-Content docs\superpowers\specs\2026-06-16-project-attachment-design.md
rg -n "UNREAL_PROJECT_ROOT|UEMCP_PROJECT_ATTACH_MODE|known-test-targets|checkOfflineAvailable|ToolsetManager|ConnectionManager|tools/list_changed|outputSchema|listRoots|elicitInput" server docs tools.yaml .mcp.json.example setup-uemcp.bat README.md AGENTS.md CLAUDE.md
```

Acceptance:

- Existing dirty files are recorded in the phase notes and not reverted unless they are part of this implementation.
- Any user edits discovered in files touched by this work are read before patching.
- The spec remains the active source of truth. If code pressure reveals a spec contradiction, patch the spec before implementation proceeds.

## Target File Plan

Create these new server modules:

- `server/project-errors.mjs`
- `server/project-identity.mjs`
- `server/project-targets.mjs`
- `server/project-context.mjs`
- `server/project-tools.mjs`
- `server/project-hygiene.mjs`
- `server/editor-processes.mjs`
- `server/tool-requirements.mjs`
- `server/test-mcp-fake-transport.mjs`
- `server/create-uemcp-server.mjs`
- `server/test-project-identity.mjs`
- `server/test-project-targets.mjs`
- `server/test-project-context.mjs`
- `server/test-project-tools.mjs`
- `server/test-project-server-wire.mjs`

Modify these existing server files:

- `server/server.mjs`
- `server/connection-manager.mjs`
- `server/toolset-manager.mjs`
- `server/tool-index.mjs`
- `server/offline-tools.mjs`
- `server/verify-deploy.mjs`
- `server/sync-plugin-helper.mjs`
- `server/test-helpers.mjs`
- `server/test-mcp-wire.mjs`
- `server/run-rotation.mjs`
- `server/live-smoke-harness.mjs`
- `server/run-live-smoke.mjs`
- `server/package.json`

Modify these registry/config/docs files:

- `tools.yaml`
- `.mcp.json.example`
- `setup-uemcp.bat`
- `verify-deploy.bat`
- `smoke-live.bat`
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/specs/configuration.md`
- `docs/specs/architecture.md`
- `docs/specs/dynamic-toolsets.md`

Modify plugin identity only after server-side identity tests are green:

- `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp`
- `plugin/UEMCP/Source/UEMCP/Public/EdgeCaseHandlers.h` only if the public header comment needs the new response shape.
- `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTests.cpp` if an automation assertion can be added without requiring a project-specific asset.

## Review Sharpenings Added After Plan Audit

These are non-negotiable execution constraints discovered during the second scrutiny pass.

- Do not implement roots tests by extending the existing one-way fake transport inline. Create `server/test-mcp-fake-transport.mjs` with bidirectional request/response support so server-initiated `roots/list` and `elicitation/create` requests are tested through the SDK path.
- Do not depend on package-manager range drift for MCP SDK features. Pin `@modelcontextprotocol/sdk` to `^1.29.0` in `server/package.json` and preserve `1.29.0` or newer in `server/package-lock.json`.
- Do not clear offline parser state from ConnectionManager by reaching into module internals. Export `resetOfflineAssetCache()` from `server/offline-tools.mjs` and call it through the ProjectContext reset listener.
- Do not infer mutator risk from tool names alone. Add `server/tool-requirements.mjs` with explicit per-tool requirement overrides and conservative layer defaults.
- Do not accept outside-client-root attachment by accident. Default `attach_project` rejects outside-root paths when MCP client roots are present unless `allow_outside_client_roots: true` is explicitly supplied.
- Do not weaken existing deploy tooling behavior while moving helpers. `server/verify-deploy.mjs` and `server/sync-plugin-helper.mjs` must preserve their current public exports and CLI output contracts.
- Do not overclaim live readiness before plugin identity exists. Until a plugin handshake returns project identity, TCP/RC reachability can only be `reachable`, not `transportOwnershipState: verified`.

---

## Phase 1: Research Report And Baseline Audit

- [ ] Create `docs/reports/project-attachment-research-2026-06-16.md`.
- [ ] Record the official MCP and local SDK findings from the Research Checkpoints.
- [ ] Record current `git status --short`.
- [ ] Record the current SDK installed version and API grep evidence.
- [ ] Record current env references.
- [ ] Pin the SDK dependency range used by this plan.
  - Modify `server/package.json` so `@modelcontextprotocol/sdk` is `^1.29.0`.
  - Run `npm install --package-lock-only --ignore-scripts` from `server/` to normalize `server/package-lock.json` without reinstalling packages.
  - Record the installed version in the research report.

Commands:

```powershell
git status --short
node -e "const p=require('./server/node_modules/@modelcontextprotocol/sdk/package.json'); console.log(p.version)"
rg -n "UNREAL_PROJECT_ROOT|UNREAL_PROJECT_NAME|UEMCP_PROJECT_ATTACH_MODE" server docs tools.yaml .mcp.json.example setup-uemcp.bat README.md AGENTS.md CLAUDE.md
cd server
npm install --package-lock-only --ignore-scripts
node -e "const p=require('./node_modules/@modelcontextprotocol/sdk/package.json'); console.log(p.version)"
```

Acceptance:

- Research report exists.
- Report states that local installed SDK is `1.29.0`.
- `server/package.json` declares `@modelcontextprotocol/sdk` as `^1.29.0`.
- Lockfile remains on `@modelcontextprotocol/sdk` `1.29.0` or a newer version verified against the same APIs.
- Report separates official MCP rules from inferred UEMCP design decisions.
- Report has a section named `Implementation Constraints From Research`.

## Phase 2: Project Identity And Target Normalization

- [ ] Add `server/project-errors.mjs`.
  - Export `PROJECT_ERROR_CODES` with exactly these string values:

```js
export const PROJECT_ERROR_CODES = Object.freeze({
  PROJECT_NOT_ATTACHED: 'PROJECT_NOT_ATTACHED',
  PROJECT_AMBIGUOUS: 'PROJECT_AMBIGUOUS',
  PROJECT_PATH_INVALID: 'PROJECT_PATH_INVALID',
  PROJECT_PATH_UNSUPPORTED: 'PROJECT_PATH_UNSUPPORTED',
  PROJECT_OUTSIDE_CLIENT_ROOT: 'PROJECT_OUTSIDE_CLIENT_ROOT',
  PROJECT_ATTACH_MODE_INVALID: 'PROJECT_ATTACH_MODE_INVALID',
  PROJECT_CONTEXT_CHANGED: 'PROJECT_CONTEXT_CHANGED',
  GENERATION_STALE: 'GENERATION_STALE',
  ROOTS_UNSUPPORTED: 'ROOTS_UNSUPPORTED',
  ELICITATION_UNAVAILABLE: 'ELICITATION_UNAVAILABLE',
  EDITOR_UNAVAILABLE: 'EDITOR_UNAVAILABLE',
  EDITOR_IDENTITY_UNKNOWN: 'EDITOR_IDENTITY_UNKNOWN',
  EDITOR_PROJECT_MISMATCH: 'EDITOR_PROJECT_MISMATCH',
  TRANSPORT_OWNER_UNKNOWN: 'TRANSPORT_OWNER_UNKNOWN',
  DEPLOY_STALE: 'DEPLOY_STALE',
  BLOCKED_CONFIG: 'BLOCKED_CONFIG',
  IN_FLIGHT_MUTATION_BLOCKED: 'IN_FLIGHT_MUTATION_BLOCKED',
  TARGET_ALIAS_AMBIGUOUS: 'TARGET_ALIAS_AMBIGUOUS',
  TARGET_ENTRY_INVALID: 'TARGET_ENTRY_INVALID',
});
```

  - Export `makeProjectError(code, message, details = {})`.
  - Export `makeProjectToolResult(errorOrPayload)` helpers that return both `content` and `structuredContent` for tool handlers that have output schemas.
- [ ] Add `server/project-identity.mjs`.
  - Export `decodeFileUriToLocalPath(uri)`.
  - Export `normalizeProjectInput(input, options)`.
  - Export `findDirectUprojects(root, fsImpl)`.
  - Export `scanWorkspaceRoot(root, options)`.
  - Export `isInsidePath(child, parent, platform)`.
  - Export `canonicalizePath(path, fsImpl)`.
  - Export `normalizeComparisonPath(pathValue)`.
  - Export `extractUprojectFromCommandLine(commandLine)`.
  - Export `createProjectIdentity({ projectRoot, uprojectPath, source, fsImpl, clientRoots })`.
  - `createProjectIdentity()` returns this exact shape:

```js
{
  projectRoot,
  canonicalProjectRoot,
  uprojectPath,
  canonicalUprojectPath,
  projectName,
  source,
  insideClientRoot,
  outsideClientRoot,
  warnings,
}
```

- [ ] Add `server/project-targets.mjs`.
  - Move or wrap `parseTargetsFile(content)` from `server/verify-deploy.mjs`.
  - Export `readProjectTargets({ repoRoot, targetsPath, fsImpl, clientRoots })`.
  - Export `buildTargetAliases(candidates)`.
- [ ] Update `server/verify-deploy.mjs` to import `parseTargetsFile`, `normalizePath`, and `extractUprojectFromCommandLine` from shared identity modules, preserving exported names for existing tests.
- [ ] Update `server/sync-plugin-helper.mjs` imports so full-path editor lock behavior still uses the shared identity model.
- [ ] Add `server/test-project-identity.mjs`.
- [ ] Add `server/test-project-targets.mjs`.

Required unit coverage:

- [ ] Direct workspace with exactly one direct `.uproject`.
- [ ] Direct workspace with multiple direct `.uproject` files remains ambiguous.
- [ ] Direct-child project auto-resolves when exactly one child has exactly one direct `.uproject`.
- [ ] Multiple child projects remain ambiguous.
- [ ] No recursive scan below immediate children.
- [ ] Case-insensitive `.uproject` extension matching.
- [ ] `file:///D:/Path With Space/Project.uproject` decodes to a local Windows path.
- [ ] Non-local `file://server/share/Project.uproject` returns `PROJECT_PATH_UNSUPPORTED` unless canonicalized UNC access succeeds.
- [ ] Raw path prefix checks are segment-aware.
- [ ] UEMCP repo guard rejects `server/fixtures/uemcp-fixture` for workspace auto-attach.
- [ ] `.uemcp-targets.txt` absent, empty, valid, partially invalid, duplicate stems, and alias collisions.
- [ ] Candidate listing does not register codenames.

Commands:

```powershell
cd server
node test-project-identity.mjs
node test-project-targets.mjs
node test-verify-deploy.mjs
node test-sync-plugin-helper.mjs
```

Acceptance:

- Every command exits `0`.
- The verify/sync tests continue to prove full-path editor matching.
- No existing deploy verdict wording loses `SYNC`, `NEEDS-SYNC`, `NEEDS-BUILD`, `NEEDS-DEPLOY`, or editor-lock semantics.

## Phase 3: ProjectContext Core

- [ ] Add `server/project-context.mjs`.
- [ ] ProjectContext constructor accepts:

```js
{
  cwd,
  repoRoot,
  env,
  sdkServer,
  fsImpl,
  processInspector,
  deployInspector,
}
```

- [ ] ProjectContext state exposes:
  - `attachmentState`
  - `attachMode`
  - `generation`
  - `identity`
  - `workspaceRoots`
  - `candidates`
  - `legacyEnvCandidate`
  - `warnings`
  - `lastResolvedAt`
  - `editorIdentityState`
  - `editorCandidates`
  - `transportOwnershipState`
- [ ] Implement `initializeFromProcessHints()` with default `workspace` mode.
- [ ] Implement explicit `UEMCP_PROJECT_ATTACH_MODE=env`.
- [ ] Implement invalid attach mode warning with code `PROJECT_ATTACH_MODE_INVALID`.
- [ ] Implement `refreshFromClientRoots({ reason })`.
- [ ] Implement `attachProject(input, options)`.
  - Accept exactly one of `project_root`, `uproject_path`, `target`, or `from_running_editor`.
  - Reject outside-client-root paths with `PROJECT_OUTSIDE_CLIENT_ROOT` when MCP client roots are present and `allow_outside_client_roots !== true`.
  - When `allow_outside_client_roots === true`, attach and include a warning named `outside_client_roots`.
  - Reject `target` when it resolves to more than one canonical `.uproject` with `TARGET_ALIAS_AMBIGUOUS`.
- [ ] Implement `detachProject(options)`.
- [ ] Implement `refreshProjectContext(options)`.
  - Refresh must not change an explicit manual attachment unless client roots are present and the attached path is now outside all roots.
  - In that root-boundary violation case, return `PROJECT_OUTSIDE_CLIENT_ROOT` and require explicit reattach with `allow_outside_client_roots: true`.
- [ ] Implement generation increment exactly once per attach, detach, root change, or explicit refresh.
- [ ] Implement reset listener registration:

```js
projectContext.onReset(async ({ generation, reason, previousIdentity, nextIdentity }) => {
  await connectionManager.resetProjectScopedState({ generation, reason });
  await toolsetManager.applyProjectContext(projectContext.snapshot());
});
```

- [ ] Add `server/test-project-context.mjs`.

Required unit coverage:

- [ ] Default mode with env set records `legacyEnvCandidate` but does not attach.
- [ ] `UEMCP_PROJECT_ATTACH_MODE=env` attaches after validation.
- [ ] Invalid attach mode warns and falls back to workspace mode.
- [ ] Env conflict with workspace candidate is reported.
- [ ] Explicit attach accepts project root, `.uproject` path, unique target alias, and running-editor candidate.
- [ ] Ambiguous target alias returns `TARGET_ALIAS_AMBIGUOUS`.
- [ ] Outside-root explicit attach warns unless `allow_outside_client_roots` policy rejects it.
- [ ] Detach clears explicit attachment and reruns workspace auto-resolution.
- [ ] Generation increments once before reset observers run.
- [ ] Reset observers see the new generation.

Commands:

```powershell
cd server
node test-project-context.mjs
```

Acceptance:

- The test proves generation values numerically, including reset observer order.
- No ProjectContext test reads or mutates global process env directly; tests pass explicit env maps.

## Phase 4: Testable Server Factory And MCP Lifecycle

- [ ] Add `server/test-mcp-fake-transport.mjs`.
  - Export `FakeMcpTransport`.
  - Support client-to-server requests with `sendClientRequest(method, params)`.
  - Support client-to-server notifications with `sendClientNotification(method, params)`.
  - Support server-to-client requests by detecting outbound JSON-RPC messages that have both `id` and `method`.
  - Support `respondToServerRequest(method, result)` and `rejectServerRequest(method, code, message)`.
  - Support `drainNotifications(method)`.
  - Support `drainServerRequests(method)`.
  - Reuse this helper from `server/test-mcp-wire.mjs` after the new helper is green.
- [ ] Add `server/create-uemcp-server.mjs`.
  - Move server construction, config creation, manager construction, management tool registration, dynamic tool registration, and startup sequencing out of `server/server.mjs`.
  - Export `createUemcpServer(options)`.
  - Return `{ server, connectionManager, toolsetManager, toolIndex, projectContext, start }`.
- [ ] Reduce `server/server.mjs` to a thin stdio entrypoint:

```js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createUemcpServer } from './create-uemcp-server.mjs';

const app = await createUemcpServer({ env: process.env, cwd: process.cwd() });
await app.start(new StdioServerTransport());
```

- [ ] Wire `server.server.oninitialized` to call `projectContext.refreshFromClientRoots({ reason: 'initialized' })`.
- [ ] Register a notification handler for `notifications/roots/list_changed` on the underlying SDK server.
  - Import `RootsListChangedNotificationSchema` from `@modelcontextprotocol/sdk/types.js`.
  - Call `server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => projectContext.refreshFromClientRoots({ reason: 'roots_list_changed' }))`.
- [ ] Use `server.server.getClientCapabilities()` after initialization.
- [ ] Use `server.server.listRoots()` only when roots support is negotiated.
- [ ] Use `server.server.elicitInput()` only when elicitation support is negotiated and a user-initiated management action asks for it.
- [ ] Add an `attach_project` input field `prompt: boolean` for elicitation.
  - If `prompt === true` and no other attach source is provided, use elicitation when negotiated.
  - If elicitation is unavailable, return `ELICITATION_UNAVAILABLE` with `next.tool = "attach_project"`.
  - The elicitation form schema contains only flat primitive fields: `project_path` string, `target` string, and `allow_outside_client_roots` boolean.
  - Do not send target candidate arrays inside the elicitation schema; include candidate summaries in the message text and `structuredContent` of the calling tool result.
- [ ] Do not request roots or elicit input before the initialize handshake completes.
- [ ] Keep management tools visible at startup.
- [ ] Ensure project-scoped dynamic tools are disabled before connect.
- [ ] Add `server/test-project-server-wire.mjs`.

Required wire coverage:

- [ ] Protocol `2024-11-05` with empty capabilities does not call `roots/list` or elicitation.
- [ ] Protocol with roots support calls `roots/list` after initialized.
- [ ] Protocol with roots support but rejected `roots/list` response records `ROOTS_UNSUPPORTED`, keeps startup non-fatal, and uses the configured fallback root source without treating env or targets as authority.
- [ ] `roots/list` result with one direct project auto-attaches and emits one tool-list notification if visible tools changed.
- [ ] Multiple root candidates remain unresolved.
- [ ] `notifications/roots/list_changed` increments generation, clears auto-attached state, and re-resolves.
- [ ] Elicitation accept attaches the selected path.
- [ ] Elicitation decline returns `ELICITATION_UNAVAILABLE` or a declined structured project result.
- [ ] Elicitation cancel returns a non-attached structured project result.
- [ ] `tools/list` immediately after initialize contains management tools only until root auto-resolution completes.
- [ ] Management tools registered through `registerTool` expose `outputSchema`.

Commands:

```powershell
cd server
node test-mcp-fake-transport.mjs
node test-project-server-wire.mjs
node test-mcp-wire.mjs
```

Acceptance:

- All three commands exit `0`.
- Wire tests assert exact `notifications/tools/list_changed` counts for attach and detach.
- Wire tests assert `structuredContent` for management-tool project errors.

## Phase 5: Toolset Visibility And Notification Batching

- [ ] Add `server/tool-requirements.mjs`.
  - Export `TOOL_REQUIREMENT_KINDS`:

```js
export const TOOL_REQUIREMENT_KINDS = Object.freeze({
  MANAGEMENT: 'management',
  OFFLINE_READ: 'offline_read',
  LIVE_READ: 'live_read',
  LIVE_MUTATION: 'live_mutation',
  RC_READ: 'rc_read',
  RC_MUTATION: 'rc_mutation',
  PYTHON_EXEC: 'python_exec',
});
```

  - Export `getToolRequirement(toolName, toolsetName, toolDef)`.
  - Default rules:
    - Management tools are `MANAGEMENT`.
    - `offline` toolset tools are `OFFLINE_READ`.
    - `http-30010` tools are `RC_READ` unless listed in explicit mutation overrides.
    - `run_python_command` is `PYTHON_EXEC`.
    - TCP toolsets are `LIVE_READ` unless listed in explicit mutation overrides.
  - Explicit mutation overrides must include asset creation/compile/save/delete/rename/duplicate, PIE start/stop or PIE input, Python execution, RC writes, geometry generation, and sidecar regeneration.
  - Add `server/test-tool-requirements.mjs`.
- [ ] Modify `server/toolset-manager.mjs`.
  - `load()` must parse tools and build the index only.
  - Remove startup auto-enable of `offline`.
  - Add `isProjectScopedToolset(name)`.
  - Add `applyProjectContext(snapshot)`.
  - Add `enable(names, { source })` where `source` is `manual`, `find_tools`, or `project_context`.
  - Add blocked result arrays with stable codes for project-scoped toolsets.
  - Add `setToolsetVisibilityBatch(toolsetNames, visible)`.
- [ ] Implement a single-notification visibility batch.
  - Use the public `RegisteredTool.enabled` property after verifying it exists in SDK v1.29.0.
  - Mutate all affected handles.
  - Call `server.server.sendToolListChanged()` exactly once when visibility changed.
  - Keep existing `handle.enable()` and `handle.disable()` behavior for isolated non-batch operations only when one notification per user action is acceptable.
  - Do not access SDK private `_registeredTools`.
  - Add a regression assertion that SDK `tools/list` filters on the public `RegisteredTool.enabled` field after direct mutation.
- [ ] Update `find_tools` behavior.
  - It may search the full catalog while unresolved.
  - It must not enable project-scoped toolsets while unresolved.
  - It returns blocked entries with `PROJECT_NOT_ATTACHED` guidance.
- [ ] Update `enable_toolset` behavior.
  - It rejects project-scoped toolsets while unresolved with `PROJECT_NOT_ATTACHED`.
  - It does not partially enable blocked project toolsets.
- [ ] Update `list_toolsets` reasons.
  - Remove default guidance that says normal MCP users must set `UNREAL_PROJECT_ROOT`.
  - Mention env only under explicit env compatibility.
- [ ] Add or extend tests in `server/test-project-server-wire.mjs` and `server/test-tool-registry-truth.mjs`.

Required coverage:

- [ ] Unresolved startup exposes management tools only.
- [ ] Default env hints do not auto-enable `offline`.
- [ ] `find_tools("gameplay tags")` returns offline matches as blocked while unresolved.
- [ ] `enable_toolset(["offline"])` returns blocked while unresolved.
- [ ] Manual attach enables the `offline` toolset when `checkOfflineAvailable(attachedProjectRoot)` succeeds.
- [ ] Detach disables project-scoped visibility.
- [ ] Attach and detach each emit exactly one tool-list notification when visibility changes.
- [ ] Metadata-only refresh emits no tool-list notification.

Commands:

```powershell
cd server
node test-tool-requirements.mjs
node test-project-server-wire.mjs
node test-tool-registry-truth.mjs
```

Acceptance:

- No test depends on counting the current total number of registry tools except registry truthfulness tests that derive counts from `tools.yaml`.

## Phase 6: Management Tools And Structured Results

- [ ] Add `server/project-tools.mjs`.
  - Export management tool definitions and handlers for:
    - `connection_info`
    - `detect_project`
    - `find_tools`
    - `list_toolsets`
    - `enable_toolset`
    - `disable_toolset`
    - `list_project_targets`
    - `attach_project`
    - `detach_project`
    - `refresh_project_context`
  - Export these Zod input shapes:

```js
export const ATTACH_PROJECT_INPUT_SHAPE = {
  project_root: z.string().optional(),
  uproject_path: z.string().optional(),
  target: z.string().optional(),
  from_running_editor: z.string().optional(),
  allow_outside_client_roots: z.boolean().optional().default(false),
  force_generation_change: z.boolean().optional().default(false),
  prompt: z.boolean().optional().default(false),
};

export const CONNECTION_INFO_INPUT_SHAPE = {
  force_reconnect: z.boolean().optional().default(false),
};

export const FIND_TOOLS_INPUT_SHAPE = {
  query: z.string(),
  max_results: z.number().int().optional().default(15),
};
```

  - Export shared output schema shapes for `projectContext`, `projectError`, and `toolsetResult`.
- [ ] Update `tools.yaml`.
  - Management tool count becomes `10`.
  - Add `list_project_targets`, `attach_project`, `detach_project`, `refresh_project_context`.
  - Update `connection_info`, `detect_project`, `find_tools`, `enable_toolset`, and `list_toolsets` descriptions.
- [ ] Register management tools with `server.registerTool` and `outputSchema`.
- [ ] Implement `connection_info(force_reconnect=true)` to refresh:
  - ProjectContext resolution.
  - Editor process identity.
  - Deploy freshness for attached project.
  - TCP 55558 reachability.
  - RC 30010 reachability.
  - Transport ownership proof from plugin handshake when the handshake response contains project identity.
- [ ] Implement `list_project_targets` using repo-root `.uemcp-targets.txt`.
- [ ] Implement `detect_project` as candidate reporting only; it must not attach.
- [ ] Implement `attach_project` exactly-one-source validation.
- [ ] Implement `detach_project`.
- [ ] Implement `refresh_project_context`.

Required structured result coverage:

- [ ] `PROJECT_NOT_ATTACHED` result has `isError: true`, text content, and `structuredContent`.
- [ ] `PROJECT_AMBIGUOUS`, `PROJECT_PATH_INVALID`, `PROJECT_OUTSIDE_CLIENT_ROOT`, and `TARGET_ENTRY_INVALID` are stable codes.
- [ ] `list_project_targets` reports `absent`, `empty`, `valid`, and `partially_invalid`.
- [ ] `connection_info` separates attachment, offline availability, deploy freshness, editor identity, TCP reachability, RC reachability, transport ownership, and enabled toolsets.
- [ ] `detect_project` reports `EDITOR_IDENTITY_UNKNOWN` when process exists but command-line access is denied.

Commands:

```powershell
cd server
node test-project-tools.mjs
node test-project-server-wire.mjs
node test-tool-metadata.mjs
```

Acceptance:

- `tools.yaml` and runtime `tools/list` agree for all management tools and dynamic tools.
- Existing clients still receive human-readable text content.

## Phase 7: ConnectionManager Reset And Readiness Separation

- [ ] Modify `server/offline-tools.mjs`.
  - Export `resetOfflineAssetCache()`.
  - Implementation must call:

```js
assetCache.entries.clear();
assetCache.lastBulkCheckMs = 0;
assetCache.indexDirty = false;
```

  - Add assertions to an existing offline test or `server/test-project-context.mjs` proving all three fields reset.
- [ ] Modify `server/connection-manager.mjs`.
  - Add `setAttachedProject(identityOrNull)`.
  - Add `getAttachedProjectRoot()`.
  - Add `resetProjectScopedState({ generation, reason, resetMetrics = false })`.
  - Change `checkOfflineAvailable()` to `checkOfflineAvailable(projectRoot)` and reject missing `projectRoot` with `PROJECT_NOT_ATTACHED`.
  - Clear `ResultCache`.
  - Reset all active layer statuses to `UNKNOWN`.
  - Clear detected editor state.
  - Destroy RC keep-alive agent.
  - Reset `_rcCallsSinceRecycle`, `_rcTokens`, `_rcLastRefillTs`, `_rcRelaunchHintFired`, and project-scoped relaunch hint state.
  - Preserve documented process-wide metrics unless `resetMetrics` is true.
- [ ] Modify offline handler dispatch to receive ProjectContext root instead of `connectionManager.resolvedProjectRoot`.
- [ ] Keep `resolvedProjectRoot` as a compatibility getter during migration if existing tests still read it.
- [ ] Add tests to `server/test-project-context.mjs` or a new reset-focused section.

Required coverage:

- [ ] ResultCache is cleared on attach and detach.
- [ ] Offline asset cache is cleared on attach and detach.
- [ ] Layer health resets on attach and detach.
- [ ] Detected editor state clears.
- [ ] RC keep-alive agent is destroyed.
- [ ] RC per-project counters reset.
- [ ] Process-wide metrics remain unless explicitly reset.

Commands:

```powershell
cd server
node test-offline-asset-info.mjs
node test-mock-seam.mjs
node test-project-context.mjs
node test-rc-wire.mjs
```

Acceptance:

- Existing ConnectionManager TCP and RC tests still pass.
- Reset tests prove state changes with direct object assertions, not log text.

## Phase 8: Shared Execution Guard And Generation Policy

- [ ] Add a shared guard in `server/project-context.mjs`:

```js
export async function withProjectContextGuard(projectContext, options, fn) {
  const startedGeneration = projectContext.generation;
  const readiness = projectContext.evaluateToolReadiness(options);
  if (!readiness.ok) return makeProjectToolResult(readiness.error);
  const result = await fn({ generation: startedGeneration, identity: readiness.identity });
  if (projectContext.generation !== startedGeneration) {
    return makeProjectToolResult(makeProjectError('PROJECT_CONTEXT_CHANGED', 'Project context changed while the tool was running.', { detailCode: 'GENERATION_STALE' }));
  }
  return result;
}
```

- [ ] Route every dynamic tool callback through this guard in `server/create-uemcp-server.mjs`.
- [ ] Classify tool requirements by calling `getToolRequirement()` from `server/tool-requirements.mjs`:
  - `OFFLINE_READ` requires attached project and offline root.
  - `LIVE_READ` requires attached project, editor identity, and TCP reachability.
  - `LIVE_MUTATION` requires live mutation readiness.
  - `RC_READ` requires attached project, editor identity, and RC reachability; if transport ownership is unverified, result includes `transportOwnershipState: "unverified"` but may proceed only for read-only diagnostics.
  - `RC_MUTATION` requires attached project, editor identity, RC reachability, and transport ownership verified by plugin/process policy.
  - `PYTHON_EXEC` requires `UEMCP_ENABLE_PYTHON_EXEC=1` plus `LIVE_MUTATION` readiness.
- [ ] Add in-flight mutator tracking.
- [ ] Block attach/detach with `IN_FLIGHT_MUTATION_BLOCKED` while mutators are in flight unless explicit force is set.
- [ ] Add stale-generation discard before cache writes and layer health writes.

Required coverage:

- [ ] Direct stale client call to a disabled project-scoped tool returns `PROJECT_NOT_ATTACHED` when callback is reached.
- [ ] Generation change during a read returns `PROJECT_CONTEXT_CHANGED`.
- [ ] Stale read result does not update caches.
- [ ] Attach/detach blocks while a fake live mutator is in flight.
- [ ] Force attach/detach records warning and proceeds.
- [ ] Live mutators are blocked when editor identity is unknown or mismatched.

Commands:

```powershell
cd server
node test-project-server-wire.mjs
node test-mock-seam.mjs
node test-tcp-tools.mjs
```

Acceptance:

- Guard is centralized; individual tool modules do not each reimplement attachment checks.

## Phase 9: Editor Identity, Deploy Readiness, And Plugin Handshake

- [ ] Add `server/editor-processes.mjs`.
  - Export `parseEditorProcessLines(stdout)`.
  - Export `listEditorProcesses({ spawnSyncImpl } = {})`.
  - Import `extractUprojectFromCommandLine()` and `normalizeComparisonPath()` from `server/project-identity.mjs`.
- [ ] Move process inspection helpers into `server/editor-processes.mjs` while preserving `verify-deploy.mjs` exports:
  - `parseEditorProcessLines`
  - `listEditorProcesses`
  - `extractUprojectFromCommandLine`
  - `normalizePath`
- [ ] Update `connection_info` editor readiness to use full canonical `.uproject` path.
- [ ] Update `detect_project` to return multiple editor candidates and unknown identity when command-line access is denied.
- [ ] Update live mutation readiness to require matching editor identity.
- [ ] Add plugin-side project identity to `get_editor_state` in `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp`.
  - Add required includes: `Interfaces/IPluginManager.h`, `Misc/App.h`, `Misc/FileHelper.h`, `Misc/Paths.h`, `Serialization/JsonReader.h`, `Serialization/JsonSerializer.h`.
  - Include `.uproject` path from `FPaths::GetProjectFilePath()`.
  - Include project root from `FPaths::ProjectDir()`.
  - Include project name from `FApp::GetProjectName()` or the `.uproject` stem.
  - Include `plugin_version` and `plugin_version_name` from the loaded plugin descriptor, or `null` fields plus a warning when descriptor lookup fails.
  - Include `deploy_marker_present`, `deploy_marker_schema_version`, `deploy_marker_manifest_version`, and `deploy_marker_uplugin_version` by reading `<ProjectRoot>/Plugins/UEMCP/.uemcp-deploy-marker.json`; when absent, return `deploy_marker_present: false`.
- [ ] Add server-side TCP handshake parser for `get_editor_state`.
- [ ] Prefer plugin handshake over process inspection when both are available.
- [ ] Block live mutators with the first failing readiness code in this order: `DEPLOY_STALE`, `EDITOR_UNAVAILABLE`, `EDITOR_IDENTITY_UNKNOWN`, `EDITOR_PROJECT_MISMATCH`, `TRANSPORT_OWNER_UNKNOWN`.

Required coverage:

- [ ] No editor returns `EDITOR_UNAVAILABLE`.
- [ ] One editor with matching command line returns verified editor identity.
- [ ] Multiple editors return candidates without first-result selection.
- [ ] Same project name in different paths remains distinct.
- [ ] Command-line denied but process visible returns `EDITOR_IDENTITY_UNKNOWN`.
- [ ] TCP reachable but identity unknown blocks live mutators.
- [ ] Plugin `get_editor_state` project identity wins over process inspection when it returns a non-null canonical `.uproject` path.
- [ ] Deploy `SYNC` without MCP attachment is not treated as live-ready.

Commands:

```powershell
cd server
node test-verify-deploy.mjs
node test-sync-plugin-helper.mjs
node test-project-tools.mjs
node test-tcp-tools.mjs
```

Plugin build and deploy checkpoint when plugin code changes:

```powershell
verify-deploy.bat
$target = Get-Content .\.uemcp-targets.txt | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | Select-Object -First 1
if (-not $target) { throw 'No .uemcp-targets.txt target available for plugin sync' }
.\sync-plugin.bat $target -y
```

Acceptance:

- If no real target project is available, record `SKIPPED-LIVE: no target project available` in `docs/reports/project-attachment-research-2026-06-16.md`.
- Static and unit tests remain mandatory even when live checks are skipped.
- Live mutator readiness is never inferred from raw port reachability alone.

## Phase 10: CLI, Live Smoke, And Fixture Migration

- [ ] Keep `server/test-helpers.mjs resolveProjectRoot()` behavior for CLI/test fixtures.
- [ ] Update `server/run-rotation.mjs` only if new tests need exclusion rules or JSON summary stability.
- [ ] Update `server/live-smoke-harness.mjs` and `server/run-live-smoke.mjs`.
  - CLI live smoke requires explicit `--project`, target alias, `.uemcp-targets.txt` selection, or explicit env mode.
  - Missing attachment, stale deploy, identity unknown, or mismatch returns `BLOCKED_CONFIG`.
  - Scenario failures remain reserved for actual smoke scenario assertions after readiness is green.
- [ ] Update `smoke-live.bat` to pass an explicit project path from `.uemcp-targets.txt`, an explicit CLI argument, or explicit env-mode config; it must not silently infer a project from default env.
- [ ] Preserve `UEMCP_LIVE_SMOKE=1` as mutation opt-in.
- [ ] Preserve fixture default for project-less unit tests.

Required coverage:

- [ ] Live smoke without opt-in skips cleanly.
- [ ] Live smoke opt-in without project returns `BLOCKED_CONFIG`.
- [ ] Live smoke explicit fixture or target resolves deterministically.
- [ ] `run-rotation.mjs --json` still reports aggregate failure counts.

Commands:

```powershell
cd server
node test-live-smoke-harness.mjs
node test-run-live-smoke.mjs
node run-rotation.mjs --json
```

Expected JSON condition:

- `.aggregate.failed` is `0`.
- `importErrorCount`, `assertionFailureCount`, `crashCount`, and `noSummaryCount` are all `0`.

## Phase 11: Config, Installer, And Documentation Migration

- [ ] Update `.mcp.json.example`.
  - Remove default silent `UNREAL_PROJECT_ROOT`.
  - Keep port and timeout env values.
  - Add commented or documented env-mode example outside JSON or in docs, not as default active authority.
- [ ] Update `setup-uemcp.bat`.
  - Default behavior writes `.uemcp-targets.txt` entry for selected project.
  - It does not create env-authoritative config unless the operator explicitly chooses env compatibility mode.
  - When env mode is chosen, it writes `UEMCP_PROJECT_ATTACH_MODE=env`.
  - Regeneration warns when it would create env-authoritative config.
- [ ] Update `verify-deploy.bat` and `server/verify-deploy.mjs`.
  - Preserve deploy freshness.
  - Add or surface MCP readiness/drift as distinct from `SYNC`.
  - Treat active `.mcp.json` root outside targets as explicit drift.
- [ ] Update `README.md`.
- [ ] Update `AGENTS.md`.
- [ ] Update `CLAUDE.md`.
- [ ] Update `docs/specs/configuration.md`.
- [ ] Update `docs/specs/architecture.md`.
- [ ] Update `docs/specs/dynamic-toolsets.md`.

Documentation acceptance:

- Normal MCP session docs say workspace roots and `attach_project` are default.
- Env docs are limited to compatibility, CLI, tests, and explicit env mode.
- Tool availability docs explain unresolved management-only startup.
- Live readiness docs separate attachment, deploy freshness, editor identity, TCP/RC reachability, and transport ownership.
- Public repo hygiene docs explain codename registration on successful attachment only.

Static docs gate:

```powershell
rg -n "UNREAL_PROJECT_ROOT|UNREAL_PROJECT_NAME|UEMCP_PROJECT_ATTACH_MODE" README.md AGENTS.md CLAUDE.md docs .mcp.json.example setup-uemcp.bat server
```

Acceptance:

- Remaining env hits are in compatibility sections, CLI/test fixtures, explicit env-mode tests, migration notes, or code that validates legacy env as metadata.
- No normal-MCP instructions say users must set `UNREAL_PROJECT_ROOT`.

## Phase 12: Public Repo Hygiene

- [ ] Move startup codename registration from `server/server.mjs` to `server/project-hygiene.mjs`.
- [ ] Register codenames only on successful attachment transitions:
  - Manual `attach_project`.
  - Workspace auto-attach.
  - Explicit env-mode startup attach.
- [ ] Do not register codenames when merely listing candidates.
- [ ] Return non-fatal warnings when `.git/info/known-test-targets.txt` cannot be written.
- [ ] Add tests using a temp repo-root and controlled write failure.

Commands:

```powershell
cd server
node test-project-context.mjs
node test-project-tools.mjs
```

Acceptance:

- Candidate listing produces no hygiene writes.
- Successful attach records project stem and parent directory when they pass the existing skip rules.
- Write failure does not fail attachment.

## Phase 13: Full Verification

Run this full suite after all phases are complete.

```powershell
cd server
npm test
node run-rotation.mjs --json
node test-project-identity.mjs
node test-project-targets.mjs
node test-project-context.mjs
node test-project-tools.mjs
node test-project-server-wire.mjs
node test-mcp-wire.mjs
node test-tool-registry-truth.mjs
node test-verify-deploy.mjs
node test-sync-plugin-helper.mjs
node test-live-smoke-harness.mjs
node test-run-live-smoke.mjs
```

Expected:

- Every command exits `0`.
- `node run-rotation.mjs --json` has `.aggregate.failed == 0`, `importErrorCount == 0`, `assertionFailureCount == 0`, `crashCount == 0`, and `noSummaryCount == 0`.

Run these repository-level checks:

```powershell
git diff --check
rg -n "UNREAL_PROJECT_ROOT" README.md AGENTS.md CLAUDE.md docs .mcp.json.example setup-uemcp.bat server
rg -n "PROJECT_NOT_ATTACHED|PROJECT_AMBIGUOUS|PROJECT_PATH_INVALID|PROJECT_OUTSIDE_CLIENT_ROOT|PROJECT_CONTEXT_CHANGED|EDITOR_IDENTITY_UNKNOWN|DEPLOY_STALE|IN_FLIGHT_MUTATION_BLOCKED|TARGET_ALIAS_AMBIGUOUS|TARGET_ENTRY_INVALID" server tools.yaml docs
```

Expected:

- `git diff --check` prints no whitespace errors.
- Env references are limited to allowed compatibility, CLI, test, and migration contexts.
- Every stable project error code is defined, tested, and documented.

Live/editor checks when an editor is available and the user has opted into mutation:

```powershell
verify-deploy.bat
test-uemcp-gate.bat
smoke-live.bat
cd server
node run-rotation.mjs --include-live-gated --json
```

Expected:

- `verify-deploy.bat` reports deploy freshness and MCP readiness separately.
- `test-uemcp-gate.bat` exits `0`.
- `smoke-live.bat` exits `0` or returns `BLOCKED_CONFIG` with a readiness reason.
- Live-gated rotation exits `0` when editor readiness is green, or records explicit live-gate skip when no editor is running.

## Phase 14: Completeness Audit

- [ ] Create `docs/audits/project-attachment-completeness-2026-06-16.md`.
- [ ] Include an evidence table with these columns:
  - Spec section.
  - Implementation file.
  - Test file.
  - Verification command.
  - Result.
  - Residual risk.
- [ ] Include a readiness matrix:
  - Attached.
  - Deploy sync.
  - Editor verified.
  - TCP reachable.
  - RC reachable.
  - Transport verified.
  - Ready for live mutation.
- [ ] Include a dirty-worktree section that separates files changed by this implementation from pre-existing modifications.
- [ ] Include skipped-live rationale when live checks cannot run.
- [ ] Re-run the Research Checkpoints and append a `Final Research Refresh` section to `docs/reports/project-attachment-research-2026-06-16.md`.
- [ ] Re-run the Context Refresh Checkpoints and record any drift.

Acceptance:

- Every spec requirement maps to at least one implementation file and one test or documented live verification.
- Any unverified live behavior is labeled as such and not reported as green.
- The audit says clearly whether final readiness is complete, blocked by live environment, or blocked by a failing test.

## Final Completion Criteria

Implementation is complete only when:

- Default MCP startup does not silently attach from legacy env.
- Unambiguous workspace topology auto-attaches after MCP initialization.
- Ambiguous workspaces remain unresolved.
- Manual attach is session-local.
- Project-scoped tools are hidden or blocked while unresolved.
- `find_tools` cannot auto-enable project-scoped toolsets while unresolved.
- `enable_toolset` cannot enable project-scoped toolsets while unresolved.
- Attach, detach, and root changes reset project-scoped caches and readiness.
- Generation stale results cannot update caches or layer health.
- Live mutators are blocked unless attachment, deploy freshness, editor identity, and transport ownership are green.
- Env compatibility remains available only through explicit env mode or CLI/test paths.
- Public repo hygiene still records successful attachments locally.
- Docs and config templates no longer teach env as the normal MCP setup path.
- Full unit and wire verification passes.
- Live checks are either green or explicitly recorded as skipped due unavailable editor or target project.
