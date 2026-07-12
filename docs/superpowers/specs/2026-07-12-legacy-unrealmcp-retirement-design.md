# Legacy UnrealMCP Retirement Design

## Goal

Retire the legacy `UnrealMCP` plugin and `tcp-55557` compatibility surface from current UEMCP operation while preserving UEMCP installs and historical provenance.

After this cleanup, UEMCP is the only supported editor-side MCP bridge. Current behavior, setup, tests, and docs must point to `tcp-55558`, Remote Control HTTP where applicable, and offline tooling. `UnrealMCP`, `tcp-55557`, and `UNREAL_TCP_PORT_EXISTING` are retired identifiers, not supported runtime paths.

## Approved Cleanup Posture

Use operational retirement:

- Remove live/current `UnrealMCP` and `tcp-55557` support from UEMCP code, tests, setup, current docs, and project payloads.
- Preserve dated historical specs, audits, and session logs only when they are clearly archival and not linked as current instructions.
- Add a search/audit gate so retired identifiers cannot drift back into current-facing surfaces.
- Preserve `UEMCP` everywhere it is installed unless a project is explicitly out of scope for UEMCP itself.

## Non-Goals

- Do not remove `Plugins/UEMCP` from any project.
- Do not change gameplay systems while removing the old tooling.
- Do not add new UEMCP features in this retirement pass.
- Do not recursively auto-attach projects or change project-attachment semantics.
- Do not rewrite every dated historical record solely because it mentions the old plugin.
- Do not treat generated build logs, binary intermediates, or third-party cache output as primary cleanup targets.

## Retired Identifiers

The cleanup targets these current-facing identifiers:

- `UnrealMCP`
- `tcp-55557`
- `55557` when used as the legacy UnrealMCP TCP port
- `UNREAL_TCP_PORT_EXISTING`
- `tcpPortExisting`
- `unreal-mcp-main`

Allowed residual hits must be explicitly classified as archival, generated, or unrelated numeric data. For example, a Wwise GUID-like value containing `55557` is not a legacy tooling reference.

## UEMCP Server Contract

Supported active layers after cleanup:

- `offline`
- `tcp-55558`
- `http-30010`

The Node server must no longer parse, probe, route, or advertise `tcp-55557`. Remove `UNREAL_TCP_PORT_EXISTING` and `tcpPortExisting` from startup config, connection manager state, live smoke harness compatibility, toolset layer validation, and error messages.

Invalid layer diagnostics should point users toward current UEMCP setup, `connection_info`, `verify-deploy`, `sync-plugin`, and Remote Control where relevant. They should not suggest enabling `UnrealMCP`.

## Tests And Fixtures

Tests must stop blessing `tcp-55557` as an active or compatibility layer.

Required changes:

- Remove or rewrite tests that expect a `tcp-55557` layer.
- Remove old oracle framing assumptions unless a neutral fixture still proves current UEMCP behavior.
- Rename any reusable fixture away from UnrealMCP-specific naming.
- Add or preserve a retired-identifier gate that scans current-facing code, tests, setup, and docs.
- Make the retired-identifier gate use an explicit allowlist for archival or generated paths.

The test suite should continue to prove `tcp-55558` framed protocol behavior, Remote Control behavior, offline behavior, dynamic toolset behavior, and project attachment behavior.

## Setup And Current Docs

Current-facing setup, installer, README, architecture, troubleshooting, and handoff docs must not instruct users or agents to install, enable, configure, or diagnose `UnrealMCP`.

Docs may retain historical references when all of these are true:

- the document is dated or clearly archival;
- the reference is provenance, not instruction;
- the document is not the current setup path;
- search-gate allowlist names the path and reason.

Docs that describe active layers should name `tcp-55558` as UEMCP TCP, `http-30010` as Remote Control HTTP, and `tcp-55557` only in archival context.

## Project Discovery Contract

The project cleanup pass considers all Unreal project workspaces under `D:\UnrealProjects`, not only `.uemcp-targets.json`.

Discovery rules:

1. Find every `.uproject` under `D:\UnrealProjects`, excluding generated directories such as `Intermediate`, `Saved`, `DerivedDataCache`, and `Binaries`.
2. For each project root, check for:
   - `Plugins/UEMCP/UEMCP.uplugin`
   - `Plugins/UnrealMCP/UnrealMCP.uplugin`
   - `unreal-mcp-main`
   - `.uproject` declarations for `UEMCP`, `UnrealMCP`, and Remote Control plugins.
3. Classify each project as one of:
   - `cleanup target`: has `UnrealMCP` declarations or physical legacy payloads;
   - `uemcp-preserve verification target`: has UEMCP installed and no legacy residue;
   - `nested legacy sample payload`: exists under `unreal-mcp-main` and is removed with the parent legacy payload;
   - `no-touch verification target`: has neither UEMCP nor legacy residue, unless current-facing setup/docs/code residue is found.
4. Remove only actual legacy residue. Do not touch unrelated project files solely because they are under `D:\UnrealProjects`.

## Current Project Inventory

Verified discovery before spec writing found 13 `.uproject` files under `D:\UnrealProjects`.

Point-in-time classification:

- Seven project roots had `Plugins/UEMCP/UEMCP.uplugin` installed.
- Three project roots had physical `Plugins/UnrealMCP` payloads.
- Three project roots had `unreal-mcp-main` payloads.
- Two primary `.uproject` files declared `UnrealMCP`.
- Three nested sample `.uproject` files existed only under `unreal-mcp-main` payload trees.
- Four UEMCP-installed project roots had no legacy plugin payload or legacy `.uproject` declaration.
- Three discovered project roots had neither UEMCP nor legacy residue.

The exact local path inventory is machine-local and may contain private project codenames. The implementation plan must rerun discovery and record exact paths in a local, non-public audit or handoff artifact before editing. This committed spec intentionally stores only count-based categories.

## Project Edit Rules

For each cleanup target:

- Delete `Plugins/UnrealMCP`.
- Delete `unreal-mcp-main`.
- Remove `.uproject` `UnrealMCP` declarations rather than leaving disabled declarations pointing at a deleted plugin.
- Preserve `Plugins/UEMCP`.
- Preserve Remote Control declarations unless separate evidence proves they are obsolete.
- Verify target manifests or project descriptors no longer pull `UnrealMCP`.

Nested `MCPGameProject` copies under `unreal-mcp-main` are legacy payload, not active project targets. They should be removed with the parent legacy bundle.

For each UEMCP-preserve verification target:

- Do not remove `Plugins/UEMCP`.
- Verify no `UnrealMCP`, `tcp-55557`, `UNREAL_TCP_PORT_EXISTING`, or `unreal-mcp-main` current-facing residue remains.
- Run project-appropriate deploy or build verification when a project was touched.

## VCS And Submit Boundaries

UEMCP is a Git repository. Project workspaces under `D:\UnrealProjects` may be Git, Perforce, mixed, broken Git metadata, or parked workspaces. Implementation must verify VCS state per workspace before editing.

Rules:

- Do UEMCP source/doc/test cleanup in an isolated Git worktree for implementation.
- Use Perforce edit/delete/submit flow where the target workspace is Perforce-managed.
- Do not bundle unrelated project submits together when their depot/workspace ownership differs.
- Report dirty or ambiguous workspace state before deleting payloads.
- Do not assume a `.git` directory is valid until `git status` works.
- Do not delete from ambiguous parked workspaces without first recording VCS ownership and cleanup intent in the implementation plan.

## Verification Gates

UEMCP verification:

- Run focused tests covering changed server files.
- Run `npm test` from `server/`.
- Run the retired-identifier grep gate against current-facing UEMCP code, tests, setup, and docs.
- Confirm `tools.yaml` has no active `tcp-55557` layer.

Project verification:

- Rerun all-project discovery under `D:\UnrealProjects`.
- Confirm cleanup targets no longer have `Plugins/UnrealMCP`, `unreal-mcp-main`, or `.uproject` `UnrealMCP` declarations.
- Confirm UEMCP-preserve targets still have `Plugins/UEMCP` where they started with it.
- Run `verify-deploy.bat` for configured UEMCP targets when applicable.
- Run project build checks for edited Unreal projects when practical and when the correct engine version is available.
- Verify generated target manifests no longer include `UnrealMCP` for edited projects after a fresh build.

Search/audit verification:

- `UnrealMCP` current-facing hits are either gone or allowlisted as archival/generated.
- `tcp-55557` current-facing hits are gone.
- `UNREAL_TCP_PORT_EXISTING` current-facing hits are gone.
- `unreal-mcp-main` hits are gone outside archival/generated allowlist.

## Adversarial Audit

### Risk 1: UEMCP gets removed accidentally

Severity: High.

Mitigation: Treat UEMCP install preservation as an explicit acceptance criterion. Verify `Plugins/UEMCP/UEMCP.uplugin` remains present for every project that had it before cleanup.

### Risk 2: The cleanup leaves a hidden reinstall path

Severity: High.

Mitigation: Search setup scripts, examples, docs, tests, local target profiles, MCP config templates, and helper scripts for legacy install instructions and env knobs.

### Risk 3: Historical docs create false-positive gates

Severity: Medium.

Mitigation: Keep a narrow archival allowlist with path and reason. Do not use broad directory exclusions that hide current docs.

### Risk 4: Deleting project payloads crosses VCS boundaries

Severity: High.

Mitigation: Verify VCS ownership for each workspace before deletes. Use Perforce deletes where required. Separate submits by workspace/depot.

### Risk 5: Numeric `55557` false positives waste time

Severity: Low.

Mitigation: Require context-sensitive classification. A number inside unrelated generated data is not a legacy port reference.

### Risk 6: Tests lose useful protocol coverage

Severity: Medium.

Mitigation: Preserve current `tcp-55558` framed protocol tests. Remove only the old layer/oracle contract.

### Risk 7: Cleanup target inventory drifts before implementation

Severity: Medium.

Mitigation: Treat the inventory in this spec as point-in-time. The implementation plan must start with a fresh discovery pass.

## Acceptance Criteria

- UEMCP server has no active `tcp-55557` layer, config knob, probe path, send path, or toolset allowlisting.
- Current-facing setup and docs no longer instruct users to install, enable, configure, or troubleshoot `UnrealMCP`.
- UEMCP tests no longer validate legacy UnrealMCP as a callable compatibility layer.
- Current-facing retired-identifier search gate passes with only explicit archival/generated allowlist hits.
- `Plugins/UnrealMCP` and `unreal-mcp-main` are removed from cleanup targets.
- `.uproject` `UnrealMCP` declarations are removed from cleanup targets.
- `Plugins/UEMCP` remains installed in every project that had it at cleanup start.
- Edited projects pass their agreed verification gates or have documented engine/VCS blockers.
- UEMCP `npm test` passes.
- VCS status is clean or intentionally limited to expected cleanup changes before PR or submit.
