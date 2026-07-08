# Tool Surface Contract Hardening Design

## Goal

Prevent the class of UEMCP failures where an editor command, YAML tool entry, discovery result, Node wrapper, transport route, requirement classification, or deployed-plugin signal exists on one surface but is missing or misleading on another.

The immediate driver is the AnimBP troubleshooting session where direct raw TCP, ad hoc Python probes, and sidecar/export fallbacks exposed that the available product surface was not enough to answer "what can I safely call, and what should I use next?" The fix is not to make agents handcraft socket frames. The fix is a reusable tool-surface contract fixture that makes those mismatches fail in the server rotation.

## Recommended Sequence

1. Extract reusable tool-surface collectors from the registry truth gate.
2. Add adjacent static gates for discovery, requirement/cache metadata, exemptions, schema drift, unknown-command diagnostics, and deploy-awareness.
3. Use those gates as the foundation for the future `animation.get_anim_graph` implementation.
4. Keep generic raw dispatch diagnostic-only unless a later design proves a safe, typed need.

This order maximizes impact because it closes the repeated failure surfaces before adding another feature that could drift across the same boundaries.

## Non-Goals

- Do not implement AnimGraph semantic readback in this pass.
- Do not add a generic public command dispatcher for arbitrary TCP command names.
- Do not accept broad camelCase or alternate parameter aliases without an explicit compatibility decision.
- Do not replace live smoke or deploy verification with static source tests.
- Do not claim static registry coverage proves a rebuilt target editor is running the newest plugin.
- Do not change plugin C++ in the contract-hardening pass unless a source verification failure proves a blocker.

## Contract Model

The reusable fixture treats each tool as a record that may appear on several surfaces:

- `YamlToolRecord`: parsed from `tools.yaml`, including toolset, params, aliases, `wire_type`, status, discoverability, and availability metadata.
- `NodeToolRecord`: produced by server definition maps such as `getActorsToolDefs()` and `getM5AnimationToolDefs()`.
- `WireCommandRecord`: registered in plugin C++ through `Registry.Register(TEXT("..."))` or direct default handler registration.
- `RequirementRecord`: produced by `getToolRequirement(toolName, toolsetName, def)`.
- `DiscoveryRecord`: produced by `ToolIndex.search(query, maxResults)`.
- `ExemptionRecord`: a planned, hidden, displaced, replaced, internal, or unsupported surface that must explain why it is not callable or discoverable.

The fixture should not perform network calls, launch the editor, or import `server.mjs`. It must be deterministic under `npm test`.

## Spec Requirements

This section defines what the implementation must satisfy. The separate implementation-plan step should decide exact file boundaries, task granularity, red/green cycles, and commit sequencing.

### Requirement 1: Reusable Tool-Surface Fixture

The registry truth logic must be reusable outside a single test file. The fixture must expose pure collectors and classifiers for YAML tools, Node definition-map tools, plugin-registered wire commands, covered wire commands, and exemption records.

Required behavior:

- The fixture must not import `server.mjs`, start the MCP server, perform network calls, launch Unreal Editor, or require project attachment.
- Plugin source scanning must cover the current command registration shapes: `Registry.Register(TEXT("..."))` and `Handlers.Add(TEXT("..."))`.
- The fixture must accept the plugin private source path and ignored-source rules as inputs instead of hardcoding every test assumption.
- Failure records must include the tool or command name, owning surface, and missing counterpart.

### Requirement 2: Cross-Surface Truth Gate

The source rotation must fail when a shipped tool surface drifts across YAML, Node definitions, plugin registrations, or wire mappings.

Required behavior:

- Every active non-offline YAML tool must have a Node definition or an explicit exemption.
- Every plugin TCP command must have a Node wrapper, `tools.yaml` `wire_type`, `partialRc.tcpWireType`, `ping` ownership, or a named internal ownership exemption.
- Every Node definition-map tool must have a YAML entry unless it is a management-only or test-only seam.
- Internal plugin commands must be allowed only through an explicit allowlist that names owner, public wrapper, and reason.
- Planned and hidden rows must remain out of active discovery.

### Requirement 3: Structured Exemption Metadata

Non-callable or non-discoverable surfaces must explain themselves in structured data. The implementation should not depend on parsing YAML comments for required semantics.

Required behavior:

- Acceptable exemption reasons include `status: planned`, `discoverable: false`, `replaced_by`, `offline_fallback`, and an explicit test-side internal ownership allowlist.
- `displaced_by` should be promoted to structured metadata before it becomes a hard test dependency.
- Exemption failures must report the exact row and which structured explanation is missing.
- A planned row with no replacement, owner, fallback, or reason is allowed only if the test names it as intentional debt.

### Requirement 4: Discovery Intent Coverage

Discovery must be validated through user-intent queries, not only exact tool names.

Required behavior:

- Query `who references this asset` must route to `get_asset_references`.
- Query `PIE actor runtime state` must route to `get_pie_actor_state` or `sample_pie_actor_state`.
- Query `Python command` must route to `run_python_command` and preserve the security warning.
- Query `list exports choose export` must route to `list_asset_exports`.
- Query `AnimGraph state machine slot layered blend` must be recorded as a current known gap until `animation.get_anim_graph` ships; the test must not pretend the existing surface is semantically complete.
- Discovery checks should assert top-N inclusion and useful toolset routing, not exact score or total ordering.

### Requirement 5: Requirement And Cache Classification

Tool safety classification must be checked independently from discovery and registry coverage.

Required behavior:

- `getToolRequirement` remains the canonical risk classifier.
- `run_python_command` is always `PYTHON_EXEC`.
- Offline tools classify as `OFFLINE_READ`.
- Remote Control tools split between `RC_READ` and `RC_MUTATION`.
- Live mutation tools classify as `LIVE_MUTATION`.
- YAML mutation metadata (`mutates_asset`, `mutates_level`, `saves_asset`, `compiles_asset`) must agree with the derived requirement kind.
- `isReadOp` should be treated as cache/transport metadata, not as the authoritative safety classifier.
- The gate must allow intentional fresh reads that skip cache, especially identity and readiness probes.

### Requirement 6: Schema Drift Remediation

Common parameter-name mistakes must fail with actionable remediation rather than pushing agents toward raw protocol workarounds.

Required behavior:

- `assetPath` rejected for `asset_path` must produce a validation error that names `asset_path`.
- `montage_path` rejected for `get_montage_full` must point to `asset_path`.
- `enable_toolset({ name })` rejected must point to `toolsets`.
- Unknown TCP command errors must include `UNKNOWN_COMMAND` and a next-action hint that suggests `find_tools`, `tools.yaml`, or the owning public wrapper.
- Default stance is better error messages, not broad alias acceptance.
- Parameter aliases require a separate compatibility decision and tests for both old and canonical names.

### Requirement 7: Deploy-Awareness, Not Deploy Proof

Static tests must keep deploy diagnostics wired without claiming the target project has actually been synced, rebuilt, relaunched, or smoked.

Required behavior:

- `connection_info({ force_reconnect: true })` must probe `get_editor_state` over `tcp-55558`.
- Plugin handshake fields must feed project identity and deploy-marker diagnostics.
- `connection_info` must surface deploy freshness in readiness output.
- `verify-deploy` marker verdicts must distinguish missing, stale, needs-sync, needs-build, and fresh-enough states.
- Any test or doc text must call this "deploy-awareness" or equivalent, not "deploy proof".

## Quick Wins To Sweep In

- Add one aggregate exemption-quality gate for `status: planned`, `discoverable: false`, `replaced_by`, and `offline_fallback`.
- Add one aggregate discovery-intent gate for the queries listed above.
- Centralize registry source scanning so future tests do not repeat C++ regex collectors.
- Add a single unknown-command remediation test that catches the raw TCP dead-end before agents start handcrafting frames.
- Add a schema-error quality test for the three observed argument-name mistakes.
- Add a deploy-awareness assertion to keep `connection_info(force_reconnect)` coupled to plugin identity and deploy freshness.

These are source-only/test-only changes. They do not require Unreal Editor to be open and do not require a plugin rebuild.

## Future Feature: `animation.get_anim_graph`

After the contract fixture lands, implement a typed live read tool for AnimBlueprint graph semantics:

- Toolset: `animation`.
- Tool name: `get_anim_graph`.
- Wire command: `get_anim_graph`.
- Params: `asset_path`, optional `include_transitions`, optional `include_node_properties`.
- Response: graph names, state machines, states, transitions, slot nodes with slot names, layered blend nodes with blend-pose counts and branch filters when available, and explicit unsupported markers for engine-private details.

This tool should use editor-side C++ APIs, not Python one-liners or raw socket calls. The contract fixture should require YAML, Node definition, plugin registration, discovery, requirement classification, and smoke-gated live validation before the tool is called complete.

## Adversarial Audit

### Finding 1: The implementation can grow into a broad platform refactor.

Severity: High.

Mitigation: Land the helper extraction and static gates first. Do not implement `get_anim_graph`, generic dispatch, Chooser decoding, or deep graph parser work in the same change.

### Finding 2: Regex-based C++ command collection can miss future registration styles.

Severity: Medium.

Mitigation: Scope the parser to the current source style and fail loudly when a new command is not covered. If C++ registration style changes, update the helper and test fixture in the same change. Do not silently treat unknown registration syntax as internal.

### Finding 3: "Covered by Node wrapper" does not prove runtime callability.

Severity: Medium.

Mitigation: Name the test "source contract" or "registry truth", not "live proof". Keep live proof in `smoke-live.bat` and `connection_info(force_reconnect)`.

### Finding 4: `isReadOp` and requirement kind can diverge for legitimate reasons.

Severity: Medium.

Mitigation: Make `getToolRequirement` the canonical risk classifier. Use `isReadOp` only for cache behavior and transport options. Python execution stays special-cased as `PYTHON_EXEC`.

### Finding 5: Discovery tests can become brittle score snapshots.

Severity: Medium.

Mitigation: Assert top-N inclusion and useful toolset routing. Do not assert exact scores or full ordering.

### Finding 6: Exemption metadata can become a rubber stamp.

Severity: Medium.

Mitigation: Require structured exemption fields and a public replacement or owner for non-callable rows. A row that only says "planned" without a replacement, owner, or reason remains reviewable debt.

### Finding 7: Accepting parameter aliases can hide stale docs and handoffs.

Severity: Medium.

Mitigation: Default to clear validation errors that name canonical params. Accept aliases only after a specific compatibility decision, with tests proving both old and canonical names.

### Finding 8: Deploy-awareness tests can overclaim freshness.

Severity: High.

Mitigation: Static tests only prove the diagnostics are wired. They must point to the deploy ritual for plugin C++ changes and never replace live smoke.

## Source Code Verification Audit

Current source already supports most of the proposed contract, but the logic is split across files:

- `server/test-tool-registry-truth.mjs:36-238` already classifies YAML rows, Node definition maps, plugin registrations, and wire coverage. Requirement 1 extracts this into reusable helpers instead of leaving it private to one test.
- `plugin/UEMCP/Source/UEMCP/Private/MCPCommandRegistry.cpp:145-190` registers default command groups, and individual files such as `AnimationHandlers.cpp:643-649`, `EditorUtilityHandlers.cpp:806-814`, and `EdgeCaseHandlers.cpp:1045-1055` register concrete TCP commands. This confirms plugin command registration is statically collectable.
- `server/connection-manager.mjs:50` defines framed TCP port `55558`; `server/connection-manager.mjs:158-161` emits `Content-Length` framing on that port. This confirms raw framing is an implementation detail already owned by `ConnectionManager`.
- `server/connection-manager.mjs:864-939` handles TCP send, wire-error normalization, read cache, and cache set. `server/connection-manager.mjs:1026-1039` clears read cache after successful write-like calls through `skipCache`.
- `server/create-uemcp-server.mjs:187-215` derives tool requirements, wraps dynamic tools with `withProjectContextGuard`, and begins mutation tracking for mutation-risk tools. `server/create-uemcp-server.mjs:938-1026` dynamically registers offline, TCP, RC, and M5 tool groups from definition maps.
- `server/tool-requirements.mjs:1-77` is the canonical requirement classifier, and `server/test-tool-requirements.mjs:25-45` already verifies core examples. Requirement 5 broadens this into an aggregate drift gate.
- `server/tool-index.mjs:105-180` controls discoverability and YAML alias ingestion, while `server/tool-index.mjs:194-268` scores queries. This is the right surface for top-N discovery intent tests.
- `docs/tracking/risks-and-decisions.md:142` records the D44 single-source-of-truth decision for YAML metadata. The new fixture extends that principle beyond offline tools.
- `docs/tracking/limitations-from-project-a-animation-audit-2026-06-18.md:104-108` records the exact schema drift pain: `assetPath`, `montage_path`, and `name` vs `toolsets`.
- `server/project-context.mjs:333-372` consumes plugin handshake identity and deploy-marker fields from `get_editor_state`. `server/create-uemcp-server.mjs:574-628` feeds `connection_info(force_reconnect)` through deploy and editor readiness probes.

Verification conclusion: the recommended sequence matches current code seams. The only existing implementation smell is that source collectors are embedded in `test-tool-registry-truth.mjs` instead of being shared. No source evidence supports public raw TCP as the durable fix.

## Verification Gates

Before completing implementation:

- Run `node test-tool-registry-truth.mjs`.
- Run the new or modified contract test file directly.
- Run `node test-tool-requirements.mjs`.
- Run the discovery-intent test file directly.
- Run `npm test` from `server/`.

If plugin C++ changes are made in a later feature pass:

- Close the editor.
- Run `sync-plugin.bat "<Project.uproject>" -y`.
- Run Unreal `Build.bat`.
- Relaunch the editor.
- Restart the MCP client.
- Run `verify-deploy.bat`.
- Run `smoke-live.bat` with `UEMCP_LIVE_SMOKE=1`.

## Acceptance Criteria

- Registry coverage logic is reusable from at least two test files.
- Active YAML live tools, Node definition maps, plugin registered commands, and wire command mappings cannot drift silently.
- Planned, hidden, displaced, replaced, unsupported, and internal surfaces have structured explanations.
- Common discovery intents route to useful tools without requiring agents to know exact tool names.
- Common schema mistakes produce remediation text that names canonical params.
- Requirement/cache classification mismatches are visible in a focused test.
- Deploy diagnostics remain wired, but static tests do not overclaim live freshness.
- Future `get_anim_graph` work starts from a hardened contract fixture instead of relying on direct socket probes or Python one-liners.
