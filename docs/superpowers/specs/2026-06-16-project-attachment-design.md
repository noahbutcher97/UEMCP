# Project Attachment And Readiness Design

## Goal

Make UEMCP attach to the correct Unreal project without relying on ambient global environment variables. Project workspaces must auto-attach only when the workspace topology identifies one project unambiguously. Tooling workspaces, multi-project roots, and stale launcher configurations must stay unresolved until the user explicitly attaches a project for the current MCP session.

The design also makes live editor readiness explicit. A valid attached project, a fresh deployment, a running editor, and an open TCP/RC port are separate facts. UEMCP must not treat one as proof of the others.

## Empirical Current State

The current server reads `UNREAL_PROJECT_ROOT` and `UNREAL_PROJECT_NAME` during startup. `ConnectionManager.resolvedProjectRoot` is initialized from that config and is passed to offline tools. If the configured root has no direct `.uproject`, `checkOfflineAvailable()` scans one immediate child level and auto-resolves only when exactly one child project is found.

The current direct-root check is weaker than the desired design: it returns the first direct file whose name ends with `.uproject`, using a case-sensitive suffix check. That means a directory with multiple direct `.uproject` files can be silently accepted today.

The repo already has better full-path identity logic in deploy tooling. `verify-deploy.mjs` and `sync-plugin-helper.mjs` parse running editor command lines, normalize full `.uproject` paths, and compare by full path rather than stem. That behavior must become the shared identity model.

The current live transport checks are not project-bound. A reachable TCP or RC layer proves that something is listening on the configured port, not that the listener belongs to the attached project. The plugin's current `get_editor_state` result does not include the `.uproject` path, so process inspection is the only editor identity source today.

In the audited local state, this repo had:

- no direct or direct-child `.uproject` near the UEMCP repo root;
- one valid `.uemcp-targets.txt` target;
- `.mcp.json` pointing at a different same-name sibling workspace;
- an `UnrealEditor` process and open ports `55557`, `55558`, and `30010`;
- denied CIM command-line access, so editor identity was unknown;
- `verify-deploy` reporting target files as `SYNC`, while the same report showed `Editor active: NO` and `MCP points to: NO` for that target.

That state is the concrete failure class this design must prevent.

## Design Principles

- Use canonical `.uproject` path identity for project matching.
- Do not use project name, stem, basename, substring, or first-result matching as authority.
- Treat environment variables as compatibility inputs, not default silent authority.
- Use MCP roots when the client supports them; do not assume roots or elicitation support.
- Keep startup non-interactive.
- Keep manual attachment session-local by default.
- Keep tool visibility aligned with project context, not just port reachability.
- Block live mutators when editor identity is missing or mismatched.
- Treat deploy freshness, editor identity, and transport reachability as separate readiness dimensions.
- Preserve CLI/test fixture env behavior where it is intentional, but label it as CLI/test behavior.

## Definitions

### Project Identity

Project identity is the canonical `.uproject` path.

Each project candidate has:

- `projectRoot`: display path to the directory containing the `.uproject`;
- `canonicalProjectRoot`: canonical comparison path;
- `uprojectPath`: display path to the `.uproject`;
- `canonicalUprojectPath`: canonical comparison path;
- `projectName`: `.uproject` filename stem for display only;
- `source`: where the candidate came from;
- `insideClientRoot`: whether the candidate is inside an MCP client root;
- `warnings`: validation warnings.

`projectName` and target aliases are convenience labels only. They must not disambiguate identity unless the alias maps to exactly one canonical `.uproject`.

### Project Context

Project context is the mutable session state owned by the MCP server process.

It exposes:

- `attachmentState`: `attached`, `auto_attached`, or `unresolved`;
- `attachMode`: `workspace` or `env`;
- `generation`: integer incremented on every attach, detach, root change, or explicit re-resolution;
- `identity`: active Project Identity when attached;
- `workspaceRoots`: MCP roots or fallback roots used for discovery;
- `candidates`: validated and invalid project candidates;
- `legacyEnvCandidate`: validated `UNREAL_PROJECT_ROOT` candidate when present;
- `warnings`;
- `lastResolvedAt`.

Editor state is separate:

- `editorIdentityState`: `verified`, `mismatched`, `unavailable`, `identity_unknown`, or `not_checked`;
- `editorCandidates`: running editor processes and identity evidence;
- `transportOwnershipState`: `verified`, `unverified`, `mismatched`, or `not_checked`.

### Readiness Dimensions

Readiness is not one boolean. `connection_info` reports these dimensions separately:

- project attachment;
- workspace/candidate resolution;
- offline project availability;
- deploy freshness;
- editor identity;
- TCP 55558 reachability;
- RC 30010 reachability;
- transport ownership;
- active toolsets.

Live mutation is allowed only when the project is attached, deployment is fresh when required, editor identity is verified, and the live transport is either project-bound by plugin handshake or accepted by the configured process-to-port proof policy.

## MCP Lifecycle And Capability Gates

Project attachment has two phases.

Process start:

- Read environment and cwd as hints only.
- Initialize ProjectContext as unresolved unless explicit env attach mode is configured.
- Register management tools.
- Do not require a project for server startup.
- Do not probe offline availability or auto-enable offline tools from env-derived state in default workspace mode.

After MCP initialization or first project-aware tool call:

- Read client capabilities from the SDK after initialization.
- If the negotiated protocol and client capabilities support roots, request `roots/list` through the SDK server API.
- Validate only `file://` roots for workspace auto-discovery.
- Cache roots with their source and generation.
- If roots change through `notifications/roots/list_changed`, increment generation, clear auto-attached state, and re-resolve.
- If roots are unsupported, fall back to process cwd plus explicit attachment.

Elicitation:

- Use the SDK `elicitInput` path only when the client negotiated elicitation support and the protocol version supports it.
- Prefer form elicitation for project choice/path input.
- Handle `accept`, `decline`, and `cancel`.
- If elicitation is unsupported or declined, return structured `PROJECT_NOT_ATTACHED` guidance.

Current wire tests use protocol `2024-11-05` and empty client capabilities. Tests must cover that roots and elicitation are not assumed in that mode.

Startup sequencing constraint:

- The initial MCP-visible tool list contains management tools only.
- Client roots cannot be requested before the MCP initialize handshake completes.
- Workspace auto-resolution based on client roots runs after initialization and emits one coalesced `notifications/tools/list_changed` only if visible tools change.
- Existing startup calls to `checkOfflineAvailable()`, `ToolsetManager.load()` auto-enable behavior, and background `detectProject()` must move behind ProjectContext resolution or become metadata-only probes.

## Workspace Resolution

Workspace roots are resolved in this order:

1. MCP client roots from `roots/list`, when supported.
2. Explicit workspace root supplied by a CLI/test harness.
3. Process cwd fallback for non-MCP terminal runs.

For each workspace root:

1. Collect all direct `.uproject` files with case-insensitive `.uproject` extension matching.
2. If exactly one direct `.uproject` exists, that root resolves to that project.
3. If more than one direct `.uproject` exists, the root is ambiguous.
4. If no direct `.uproject` exists, inspect immediate child directories only.
5. A child directory is a project candidate only when it contains exactly one direct `.uproject`.
6. If exactly one child project candidate exists, that root resolves to that project.
7. If zero or multiple child project candidates exist, the root remains unresolved.

The scan is intentionally shallow. No recursive project discovery is allowed for auto-attach.

Multi-root behavior:

- If exactly one client root resolves to exactly one project, auto-attach that project.
- If multiple roots resolve to projects, remain unresolved and list candidates.
- If no roots resolve, remain unresolved and list candidates from target files, running editors, and legacy env.
- Never silently prefer the first root.

UEMCP repo guard:

- A root identified as the UEMCP repository must not auto-attach nested fixture projects.
- Repo detection uses sentinel files such as `tools.yaml`, `server/server.mjs`, and `plugin/UEMCP/UEMCP.uplugin`.
- Fixture projects under `server/fixtures/` are test fixtures only and require explicit test harness selection.

## Candidate Sources

Candidate sources are additive and non-authoritative unless the user explicitly attaches one.

Sources:

- workspace topology;
- `.uemcp-targets.txt`;
- running editor process inspection;
- legacy env;
- explicit `attach_project` input.

`.uemcp-targets.txt` location:

- The default targets file is repo-root `.uemcp-targets.txt`, matching `verify-deploy.mjs`.
- CLI tools may keep `--targets <path>` override support.
- MCP management tools read the repo-root targets file unless a future explicit configuration surface is added.
- Client-root `.uemcp-targets.txt` files are not read implicitly, because that would let a workspace-local file outside this repo influence server attachment without an explicit trust decision.

`.uemcp-targets.txt` validation:

- Strip comments and blank lines.
- Validate each non-empty entry exists.
- Validate each entry has case-insensitive `.uproject` extension.
- Validate it is a file, not a directory.
- Validate the parent has expected UE project shape. `Content/` is a useful signal but must be a warning, not the sole authority, because some valid projects can be source/plugin-focused.
- Report invalid entries with structured errors; do not silently drop them.

Aliases:

- Default alias is the `.uproject` stem only when unique across canonical candidates.
- Duplicate stems are disambiguated by parent directory and a stable short hash of the canonical path.
- Alias collisions are reported in `list_project_targets`.

Outside-root candidates:

- Workspace auto-discovery cannot attach outside MCP client roots.
- `.uemcp-targets.txt`, running editors, and env may list outside-root paths as explicit candidates with `outsideClientRoot: true`.
- Attaching outside client roots requires explicit user action. If the client has roots, the response must warn that the path is outside the announced workspace boundary.

## Path Canonicalization

All project identity comparisons use one shared normalizer used by server attachment, deploy verification, sync lock checks, and management tools.

Normalization steps:

1. Convert `file://` roots and inputs to local paths by decoding percent escapes and rejecting non-local authorities.
2. Resolve relative paths against the relevant source root.
3. Convert `.uproject` inputs to their containing project root and project-root inputs to their `.uproject`.
4. Use `fs.realpath.native()` when available to canonicalize symlinks, junctions, and case.
5. Preserve the original display path separately from the canonical comparison path.
6. Normalize slashes for display.
7. Compare Windows paths case-insensitively.
8. Remove trailing separators for comparison.
9. Treat UNC paths as supported only if they can be canonicalized and accessed. If not, return `PROJECT_PATH_UNSUPPORTED` with the original path.

Reparse points:

- Symlinks and junctions are allowed for identity only after `realpath.native()` canonicalization.
- If the display path and real path differ, report a warning.
- Plugin deployment still follows the existing physical-copy policy; project identity canonicalization does not reintroduce junction-based plugin deployment.

Safe path behavior:

- Offline file reads continue to reject traversal outside the attached project root.
- Prefix checks must use path-segment-aware comparisons, not raw string prefix alone, so `C:/Proj` does not match `C:/Project2`.

## Environment Compatibility Policy

Default attach mode is `workspace`.

`UNREAL_PROJECT_ROOT` and `UNREAL_PROJECT_NAME` remain supported as compatibility inputs, but they do not silently attach an ambiguous or unrelated workspace by default.

`UEMCP_PROJECT_ATTACH_MODE` allowed values are:

- `workspace`, the default when unset;
- `env`, the explicit compatibility mode.

Any other value is treated as `workspace`, reported in `connection_info.warnings`, and exposed with `PROJECT_ATTACH_MODE_INVALID`.

Default behavior:

- If workspace topology auto-resolves a project, legacy env is reported only as metadata.
- If legacy env conflicts with the auto-resolved project, `connection_info` reports a warning.
- If workspace topology is unresolved, legacy env appears as `legacyEnvCandidate`.
- Project-scoped tools still return `PROJECT_NOT_ATTACHED` until the user calls `attach_project`.

Explicit env mode:

- Use one opt-in knob: `UEMCP_PROJECT_ATTACH_MODE=env`.
- In env mode, `UNREAL_PROJECT_ROOT` may attach at startup after normal path validation.
- Env mode must still report conflicts with MCP roots, `.uemcp-targets.txt`, running editors, or deploy state.
- Live mutating tools remain blocked unless editor identity and transport ownership are verified.

No global User-level env mutation is part of this design.

## Management Tools

### `connection_info`

Reports:

- ProjectContext;
- readiness dimensions;
- client roots or fallback root source;
- legacy env candidate and warnings;
- running editor candidates;
- deploy freshness summary for the attached project when available;
- layer status;
- active toolsets.

`force_reconnect` must re-run identity checks as well as layer pings. A ping-only reconnect is insufficient.

### `list_project_targets`

Reads `.uemcp-targets.txt`, validates entries, returns candidate identities, aliases, invalid entries, duplicate-stem collisions, and outside-root flags.

It must report whether the default repo-root targets file was absent, empty, valid, or partially invalid.

### `detect_project`

Returns running editor candidates. It must not implicitly attach.

Rules:

- Use full canonical `.uproject` path when command-line identity is available.
- Treat multiple editors as candidates.
- Do not return the first editor as authoritative.
- Do not match by basename, project name, or substring.
- If command-line inspection is denied but an editor process exists, return `EDITOR_IDENTITY_UNKNOWN`.

### `attach_project`

Attaches a project for the current MCP session.

Inputs:

- `project_root`;
- `uproject_path`;
- `target`;
- `from_running_editor`;
- optional `allow_outside_client_roots`;
- optional `force_generation_change` for advanced recovery only.

Validation:

- Exactly one input source must be provided.
- Resolve to exactly one canonical `.uproject`.
- Reject ambiguous target aliases.
- Warn or reject outside-root paths according to the boundary policy.
- Reject invalid paths with stable structured codes.
- Do not require an editor to be running for offline attachment.

Effects:

- Increment ProjectContext generation.
- Update active project identity.
- Run the Project Context Reset Contract.
- Recompute offline availability.
- Refresh toolset visibility.
- Emit a tool-list notification only if visible tools changed.
- Return the final ProjectContext.

### `detach_project`

Clears session attachment and reruns workspace resolution.

Effects:

- Increment generation.
- Clear session attachment.
- Re-run workspace auto-resolution.
- Run the Project Context Reset Contract.
- Refresh toolset visibility.

### `refresh_project_context`

Re-reads MCP roots when supported, revalidates candidates, and refreshes editor identity. It does not change an explicit session attachment unless roots are removed in a way that violates client-root boundary policy.

## Project Context Reset Contract

On attach, detach, or root change:

The ProjectContext generation increments exactly once before reset begins. The reset contract observes that new generation; it does not increment generation itself.

- Clear `ConnectionManager.ResultCache` through a public reset method.
- Clear offline `assetCache.entries`.
- Reset offline `assetCache.lastBulkCheckMs`.
- Reset offline `assetCache.indexDirty`.
- Reset all layer statuses, errors, and last-check timestamps to unknown.
- Clear detected editor state.
- Destroy or recycle RC keep-alive agent state.
- Reset RC per-project counters, recycle counters, rate-limit bucket state, and relaunch-hint state unless metrics are explicitly documented as process-wide.
- Recompute offline availability for the new project.
- Recompute toolset visibility.

This reset is mandatory even when the new project has the same project name.

## In-Flight And Generation Policy

Every tool dispatch captures the ProjectContext generation at dispatch start.

Project-scoped tool callbacks must enter through one execution guard shared by offline, TCP, and RC tools. Individual handlers should not each reimplement attachment checks.

Before a project-scoped tool sends work to offline, TCP, or RC:

- Re-check that the current generation matches the captured generation.
- Re-check that the tool is allowed for the current attachment and readiness state.

Before caching a read result or updating layer health:

- Re-check generation again.
- If the generation changed, discard the result and return `PROJECT_CONTEXT_CHANGED` with `detailCode: "GENERATION_STALE"`.

Attach/detach behavior while commands are in flight:

- Read-only in-flight commands may finish but cannot update caches if stale.
- Live mutating commands already sent to the editor cannot be recalled.
- By default, attach/detach returns `IN_FLIGHT_MUTATION_BLOCKED` while live mutators are in flight.
- A force option may override the block only with an explicit warning that the old project/editor may already have been mutated.

Mutators include asset creation/compile/save/delete/rename/duplicate, PIE start/stop or PIE input, Python execution, RC writes, geometry generation, and sidecar regeneration.

## Tool Visibility Policy

When ProjectContext is unresolved:

- Only management tools are visible.
- `find_tools` may search the full catalog but must not auto-enable project-scoped toolsets.
- `find_tools` returns matching toolsets as blocked with `PROJECT_NOT_ATTACHED` guidance.
- `enable_toolset` cannot enable project-scoped toolsets and returns blocked entries with `PROJECT_NOT_ATTACHED`.
- Direct calls from stale clients to disabled or previously visible project tools return `PROJECT_NOT_ATTACHED` or standard MCP unknown-tool behavior depending on what the client still has cached.

When ProjectContext is attached:

- Offline toolset availability depends on valid project root.
- Live toolsets depend on editor identity and transport readiness, not raw port reachability alone.
- Toolset availability reasons must stop saying "set `UNREAL_PROJECT_ROOT`" except in explicit env compatibility contexts.

Tool-list notification contract:

- Emit exactly one `notifications/tools/list_changed` when attach/detach changes visible tools.
- Emit none when only metadata changes.
- Batch SDK handle enable/disable operations so one project-state transition does not produce one notification per tool.
- Avoid duplicate notifications from both SDK handle changes and manual callbacks.

## Structured Tool Result And Error Contract

Project attachment errors are tool execution results, not JSON-RPC protocol errors.

For project-scoped tools blocked by project context:

- return `isError: true`;
- include human-readable text content for existing clients;
- include `structuredContent` where supported by the tool registration path;
- register `outputSchema` for management tools and structured project-context errors; the installed SDK supports this path;
- use stable error codes.

Stable codes:

- `PROJECT_NOT_ATTACHED`
- `PROJECT_AMBIGUOUS`
- `PROJECT_PATH_INVALID`
- `PROJECT_PATH_UNSUPPORTED`
- `PROJECT_OUTSIDE_CLIENT_ROOT`
- `PROJECT_ATTACH_MODE_INVALID`
- `PROJECT_CONTEXT_CHANGED`
- `GENERATION_STALE`
- `ROOTS_UNSUPPORTED`
- `ELICITATION_UNAVAILABLE`
- `EDITOR_UNAVAILABLE`
- `EDITOR_IDENTITY_UNKNOWN`
- `EDITOR_PROJECT_MISMATCH`
- `TRANSPORT_OWNER_UNKNOWN`
- `DEPLOY_STALE`
- `BLOCKED_CONFIG`
- `IN_FLIGHT_MUTATION_BLOCKED`
- `TARGET_ALIAS_AMBIGUOUS`
- `TARGET_ENTRY_INVALID`

Example unresolved result:

```json
{
  "ok": false,
  "code": "PROJECT_NOT_ATTACHED",
  "message": "No Unreal project is attached for this UEMCP session.",
  "attachmentState": "unresolved",
  "workspaceRoots": [],
  "candidates": [],
  "next": {
    "tool": "attach_project",
    "args": {
      "uproject_path": "D:/Path/Project/Project.uproject"
    }
  }
}
```

## Live Editor Identity And Transport Ownership

Live editor identity must be proven before live mutation.

Identity sources, strongest first:

1. Plugin-side identity handshake returning canonical `.uproject` path, project root, project name, plugin version, manifest version, and deploy marker identity.
2. Process command-line inspection mapping a running editor to a canonical `.uproject`.
3. Explicit user override for read-only diagnostics only.

Process inspection alone is not enough to prove which process owns a TCP/RC port when multiple editors may be running. The robust target state is a plugin-side identity handshake on TCP 55558. Until that exists, live mutators must be conservative:

- If command-line identity is unavailable but an editor process exists, return `EDITOR_IDENTITY_UNKNOWN`.
- If TCP/RC is reachable but identity is unknown, block live mutators.
- If editor identity does not match attached project, return `EDITOR_PROJECT_MISMATCH`.
- If deployment is stale for the attached project, live smoke and mutators return `DEPLOY_STALE` or `BLOCKED_CONFIG`.

`connection_info(force_reconnect=true)` must re-run:

- project context resolution;
- editor process identity;
- deploy freshness for attached project;
- TCP/RC reachability;
- transport ownership proof when available.

## Deploy Freshness And Readiness

Deploy freshness answers "does the target project have current UEMCP files?" It does not answer "is the MCP session attached?" or "does the live port belong to that target?"

Readiness states:

- `ATTACHED`: project identity is resolved.
- `DEPLOY_SYNC`: target plugin files match repo source and marker expectations.
- `EDITOR_VERIFIED`: running editor identity matches attached `.uproject`.
- `TRANSPORT_VERIFIED`: TCP/RC listener is proven to belong to the verified editor.
- `READY_FOR_LIVE_MUTATION`: all required dimensions are green.

`verify-deploy` can continue to report deploy freshness, but project attachment work must add or surface a separate MCP readiness verdict. A target can be `SYNC` and still not be ready for live mutation.

## Public Repo Hygiene

The current server records project and parent-directory codenames from `UNREAL_PROJECT_ROOT` into `.git/info/known-test-targets.txt` for the local forbidden-token workflow. Removing env-authoritative startup must not remove that protection.

New behavior:

- `attach_project` and explicit env-mode startup register the attached project stem and parent directory through the same local-only hygiene path.
- Workspace auto-attach registers the auto-attached project the same way.
- Merely listing candidates from `.uemcp-targets.txt`, roots, env, or running editors does not register names, because candidates are not authority.
- Failures to write `.git/info/known-test-targets.txt` remain non-fatal and are reported as warnings, not MCP protocol errors.

## CLI And MCP Split

MCP sessions:

- Use MCP roots when supported.
- Use workspace auto-resolution only inside roots or cwd fallback.
- Use `attach_project` for manual session-local attachment.
- Use elicitation only when negotiated.

CLI scripts:

- Use explicit args, target aliases, `.uemcp-targets.txt`, or legacy env.
- Do not assume MCP roots.
- `node server.mjs` from a terminal may use cwd fallback for shallow auto-resolution, but must not treat `.uemcp-targets.txt` or env as silent authority unless `UEMCP_PROJECT_ATTACH_MODE=env` is set.

Tests:

- `server/test-helpers.mjs` may keep the current `UNREAL_PROJECT_ROOT` or fixture fallback pattern.
- `run-rotation.mjs` may continue to print whether tests used env or fixture.
- This fixture behavior is CLI/test-only and must not define MCP session attachment semantics.

Live smoke:

- `UEMCP_LIVE_SMOKE=1` remains the mutation opt-in.
- MCP-driven live smoke uses ProjectContext.
- CLI live smoke requires explicit `--project`, target alias, `.uemcp-targets.txt` selection, or env compatibility mode.
- Missing attachment, mismatch, stale deploy, or identity unknown is `BLOCKED_CONFIG`, not scenario `FAIL`.

## Migration Scope

Server and registry:

- Add ProjectContext module.
- Add management tools to `tools.yaml`: `list_project_targets`, `attach_project`, `detach_project`, and `refresh_project_context`.
- Update `connection_info` and `detect_project` descriptions in `tools.yaml`.
- Replace env-only `ConnectionManager` project ownership with ProjectContext-driven identity.
- Add shared path/project normalizer used by server, deploy, and sync paths.
- Add a public `ConnectionManager` reset method for `ResultCache`, layer health, detected editor state, and RC per-project state.
- Move `ToolsetManager.load()` startup auto-enable behavior behind ProjectContext so offline tools cannot become visible from default env hints.
- Route every project-scoped tool callback through a shared ProjectContext execution guard.
- Use the SDK `getClientCapabilities()`, `listRoots()`, and `elicitInput()` APIs instead of raw JSON-RPC plumbing unless tests prove a lower-level path is required.
- Add notification batching around SDK handle visibility changes.
- Move project-codename registration from env-only startup to successful attachment transitions.

Docs:

- Update `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/specs/configuration.md`, `docs/specs/architecture.md`, and `docs/specs/dynamic-toolsets.md`.
- Remove language that says `UNREAL_PROJECT_ROOT` is required for normal MCP sessions.
- Keep env language only in compatibility, CLI, test, and explicit env-mode sections.

Installer/config:

- Update `.mcp.json.example` so `UNREAL_PROJECT_ROOT` is not silent authority in the default template.
- If setup chooses fixed env mode, it must write `UEMCP_PROJECT_ATTACH_MODE=env`.
- Otherwise setup must record selected projects as `.uemcp-targets.txt` candidates and rely on workspace topology or manual attach.
- Existing `.mcp.json` regeneration must warn when it would create env-authoritative config.

Deploy tooling:

- Keep deploy freshness checks.
- Add or surface MCP readiness/drift checks separately from `SYNC`.
- Treat active `.mcp.json` root outside targets as explicit drift warning.
- Preserve full-path editor matching.

Static acceptance gate:

- Run `rg UNREAL_PROJECT_ROOT` across tracked docs/tests.
- Allowed hits: compatibility docs, CLI examples, fixture tests, env-mode tests, and migration notes.
- Any remaining "required" or authoritative language outside those contexts blocks completion.

## Testing Strategy

Unit tests:

- direct workspace with exactly one direct `.uproject`;
- direct workspace with multiple direct `.uproject` files;
- direct-child project auto-attach;
- multiple child projects ambiguity;
- no project with valid targets;
- no project with invalid target entries;
- duplicate target stems;
- legacy env candidate without auto-attach;
- explicit `UEMCP_PROJECT_ATTACH_MODE=env`;
- invalid `UEMCP_PROJECT_ATTACH_MODE` warns and falls back to workspace mode;
- env conflict with workspace project;
- root path outside MCP roots;
- `file://` root decoding and non-local authority rejection;
- symlink/junction canonicalization;
- UNC path support or structured unsupported result;
- case-insensitive `.uproject` extension matching;
- UEMCP repo fixture non-auto-attach guard.

MCP wire tests:

- protocol `2024-11-05` with no roots or elicitation support;
- protocol/client with roots support;
- roots list success;
- roots list unsupported fallback;
- roots changed notification;
- elicitation accept;
- elicitation decline;
- elicitation cancel;
- `PROJECT_NOT_ATTACHED` returns `isError: true`;
- `structuredContent` plus `outputSchema` path for management tools;
- exact `tools/list_changed` count after attach/detach.

Tool visibility tests:

- unresolved startup exposes management tools only;
- startup does not auto-enable offline tools from default env hints;
- `find_tools` returns blocked project tools without enabling them;
- `enable_toolset` returns blocked project toolsets without enabling them;
- attach enables appropriate project-scoped toolsets;
- detach disables project-scoped toolsets;
- stale direct calls fail with project-context errors.

State invalidation tests:

- `ConnectionManager.ResultCache` clears on attach/detach;
- offline `assetCache` clears on attach/detach;
- layer health resets;
- detected editor state clears;
- RC keep-alive agent and per-project RC counters reset;
- generation changes discard stale read results;
- attach/detach blocks or warns while live mutators are in flight.

Public-repo hygiene tests:

- env-mode startup registers attached project codenames;
- manual `attach_project` registers attached project codenames;
- workspace auto-attach registers attached project codenames;
- candidate listing does not register codenames;
- `.git/info` write failure returns a warning and does not fail attachment.

Live/editor tests:

- no editor;
- editor identity verified by process command line;
- editor identity unavailable due denied command-line access;
- multiple editors;
- same project name in different paths;
- TCP port reachable but wrong editor;
- RC reachable but wrong editor;
- stale deploy;
- target deploy `SYNC` but MCP not attached to target;
- plugin identity handshake once implemented.

CLI/test migration:

- live smoke no opt-in skips;
- live smoke opt-in without project returns `BLOCKED_CONFIG`;
- live smoke explicit target works;
- run rotation fixture path remains explicit and honest;
- env-mode tests cover compatibility without redefining default MCP behavior.

## Non-Goals

- No recursive project auto-discovery.
- No automatic persistence of manual attachment.
- No global User-level env mutation.
- No silent target selection from `.uemcp-targets.txt`.
- No stem-based project identity.
- No live mutation when editor identity is unknown.
- No replacement of deploy freshness checks with attachment checks; both are required.
