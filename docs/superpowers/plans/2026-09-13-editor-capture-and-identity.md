# Asset-editor and PIE capture, and editor identity on the wire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five TCP:55558 tools that capture an open asset editor (or one of its tabs), page a Details panel, and capture the PIE viewport, and make `wait_for_editor` / `connection_info` refuse to call a listener "ready" when its project identity does not match the attached project.

**Architecture:** `get_viewport_screenshot` reads `GEditor->GetActiveViewport()`, which the engine resolves to the level-editor viewport, so nothing in UEMCP can see an asset editor. The new path addresses editors explicitly: `UAssetEditorSubsystem::FindEditorForAsset(Asset, false)` returns an `IAssetEditorInstance*`, whose `GetAssociatedTabManager()` gives the toolkit's `FTabManager`; `CollectSpawners()` + `FindExistingLiveTab(FTabId)` enumerate the live tabs; `FSlateApplication::Get().TakeScreenshot(Widget, OutColorData, OutSize)` turns a tab's content widget into pixels, and the existing `FImageUtils::CompressImage(..., TEXT("png"), ...)` path turns those into a PNG on disk. Details paging goes through the public `IDetailsView` interface only. Node side, the five tools join `MENHANCE_SCHEMAS` (the module that already owns `get_viewport_screenshot`) so the generic `registerToolGroup` wiring picks them up with no new registration code, and the identity rule is a change to `server/editor-readiness.mjs` plus two fields on `connection_info`.

**Tech Stack:** UE 5.6 C++ editor module (`UnrealEd`, `Slate`, `SlateCore`, new `PropertyEditor` dependency); `IMPLEMENT_SIMPLE_AUTOMATION_TEST` with `EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter` behind `#if WITH_DEV_AUTOMATION_TESTS`; Node ES modules with Zod 3; `run-native-tests.bat` (headless `UnrealEditor-Cmd`, `-nullrhi`) and `node run-rotation.mjs` for proof; `sync-plugin.bat` + `Build.bat` + `verify-deploy.mjs` for the deploy cycle.

**Spec:** `docs/superpowers/specs/2026-09-13-editor-capture-and-identity-design.md`

## Deviations from the spec

Recorded here so a reviewer does not read them as drift. Every engine symbol below was checked against the 5.6 headers under `<UE_ENGINE_ROOT>/Engine/Source` before this plan was written.

1. **`IDetailsView::SetRootExpansionStates` does not exist on 5.6.** The spec's §4 names it as the expand-all call. On 5.6 the only declaration is `SDetailsViewBase::SetRootExpansionStates(const bool bExpand, const bool bRecurse)` in `Editor/PropertyEditor/**Private**/SDetailsViewBase.h:181` — a private header, unreachable from a plugin module. The public `IDetailsView` (`Editor/PropertyEditor/Public/IDetailsView.h`) has no expand-all at all. Task 3 uses the public interface instead: `ShowAllAdvancedProperties()` (`:238`) clears the advanced filter, and `ScrollPropertyIntoView(const FPropertyPath&, bool bExpandProperty)` (`:233`) expands the target node **and every ancestor** — `SDetailsViewBase.cpp:335-349` walks `GetParentNode()` calling `SetItemExpansion(..., true)` before the `bExpandProperty` branch — so iterating `GetPropertiesInOrderDisplayed()` (`:196`) reaches the same end state through public API.
2. **`STableViewBase::SetScrollOffset` is not reachable from a details view on 5.6.** `SDetailsViewBase::GetScrollWidget()` returns `SharedThis(this)` (`SDetailsViewBase.cpp:1975-1978`), i.e. the details view, not the `SDetailTree`, exactly as the requester observed; and `SDetailTree` is a private type, so there is no safe cast to the `STableViewBase` that owns the offset. Task 3 therefore scrolls **by row**, using the public `GetPropertyRowNumbers()` (`IDetailsView.h:203`, `TArray<TPair<int32, FPropertyPath>>`) and `CountRows()` (`:223`) plus one `ScrollPropertyIntoView`. This also makes `row_offset` stable across DPI and panel size, which a pixel offset would not be.
3. **Handlers do not marshal to the game thread individually.** The spec's §4 last bullet asks for `MCPThreadMarshal` in each handler. `FMCPCommandRegistry::Dispatch` already wraps **every** handler in `RunOnGameThread(..., 30.0, &WallClockSeconds)` (`MCPCommandRegistry.cpp`, the "Audit F-1 fix" block), so a per-handler marshal would be a nested no-op at best and a self-deadlock hazard at worst. The new handlers are written as plain synchronous functions, like every other handler in the plugin.
4. **The identity error code is `EDITOR_PROJECT_MISMATCH`, not a new `EDITOR_IDENTITY_MISMATCH`.** `server/project-errors.mjs` already defines `EDITOR_PROJECT_MISMATCH` and `ProjectContext` already returns it from both `refreshEditorProcesses()` and `refreshEditorHandshake()` for exactly this condition ("the editor's project is not the attached project"). Adding a second code with the same meaning would be drift. The spec's intent is honoured; the string differs.
5. **`connection_info` already detects the mismatch; Task 4 surfaces it explicitly.** With `force_reconnect: true`, `refreshEditorReadinessForConnectionInfo` calls `get_editor_state` and feeds it to `refreshEditorHandshake`, which sets `editorIdentityState = 'mismatch'`. The payload already carries that in `readiness.editorIdentity`. Task 4 adds the boolean and the two paths the spec asks for rather than re-implementing the detection. The real gap is `wait_for_editor`, whose probe reports `ready` for **any** listener that answers `get_editor_state`.
6. **Param names `out_png` / `inline` diverge from the toolset's existing `output_path` / `return_base64`.** The spec is binding and names `out_png` and `inline`, so those are what ship. Flagged because a reviewer comparing them to `get_viewport_screenshot` will notice; the two tools also differ in behaviour (see 7), so a shared name would be misleading anyway.
7. **`capture_asset_editor` and `capture_pie_viewport` always write a file.** `get_viewport_screenshot` writes only when `output_path` is given and defaults to inline base64. The spec's §3 inverts that: `out_png` *defaults* to `Saved/UEMCP/Captures/<stem>_<timestamp>.png` and `inline` defaults to false. This is deliberate — a 4K editor window is a large base64 payload — and it is what makes the 8 MiB cap safe, because the path is always available to fall back on.
8. **`HandleGetViewportScreenshot` is not refactored.** Its PNG encode/write tail is duplicated in the new helpers rather than extracted. Two reasons: `server/test-visual-capture-source.mjs` pins that tail by source substring (`OutputFilePath += TEXT(".png")`, `FImageUtils::ImageResize`, `Viewport->ReadPixels`, `FPaths::ProjectSavedDir()`), and the new tail has different semantics (default path, always-write, inline cap). The spec's §4 explicitly permits leaving `VisualCaptureHandler.cpp` untouched.
9. **Tab enumeration is spawner-driven, so it lists the tabs the editor advertises.** `FTabManager::CollectSpawners()` is documented as "all tab spawners that should have menu items in the main menu", so a toolkit that hides a spawner from its Window menu will not have that tab listed. There is no public API that enumerates live tabs directly. The tool description says so, and `capture_asset_editor` still accepts any `tab_id` the caller knows, because it resolves through `FindExistingLiveTab` rather than through the listing.

## Global Constraints

- **Placeholder vocabulary only.** This is a public repo and the target projects are private. Write `path/to/YourProject.uproject`, `<YourProject>Editor`, `<UE_ENGINE_ROOT>`, "the sample 5.6 target". Never a project codename, never an absolute machine path, and never the bare word for a scratch directory — the per-checkout token list blocks it as a standalone token, so write "scratch" instead. Applies to source comments, test fixtures, commit messages, the D-log row, CLAUDE.md and the backlog.
- **No AI attribution** in commits — no `Co-Authored-By`, no "generated with".
- **One commit per task**, five commits total. Commit from the repo root.
- **Never edit `.uemcp-targets.json`.** It is per-machine and untracked-by-intent. The commands below assume a `smoke` profile exists; if it does not, substitute `--target <alias>` or `--uproject path/to/YourProject.uproject` and say which you used in the task report.
- **Shared C++ helpers live in `Public/` headers, never in per-file anonymous namespaces** (`UEMCP.Build.cs` sets `bUseUnity = true`; D133/D135/D137). `node server/test-anon-namespace-audit.mjs` must stay clean; it scans `Private/*.cpp` non-recursively, so `Private/AssetEditorCapture.cpp` and `Private/AssetEditorCaptureHandler.cpp` are both in scope. The second reason the helpers are in `Public/` here is that `Private/Tests/*.cpp` can only include `Public/` headers — the WS5a lesson.
- **Functions under 50 lines.** Every function written by this plan is under 50 lines of body. Where a handler approaches it, the resolution or the response tail is already factored into a named helper.
- **Addressing is resolved before the renderer gate.** In `capture_asset_editor`, asset resolution, editor lookup and tab lookup all run **before** `CanCaptureSlate()`. If the gate came first, `ASSET_NOT_FOUND`, `EDITOR_NOT_OPEN` and `TAB_NOT_FOUND` would all collapse into `CAPTURE_UNSUPPORTED` under `-nullrhi` and the native suite could only test one path. This ordering is load-bearing and is pinned by a source assertion and by the `AssetNotFound` native test.
- **Every native test creates its assets in a transient package** the way the WS5a fixture does: a unique leaf (`FGuid::NewGuid().ToString(EGuidFormats::Short)`), object name equal to the package leaf, `FAssetRegistryModule::AssetCreated`, teardown at the end of the test. Nothing is ever saved.
- **Opening an editor headless may be refused.** Every test that needs an open asset editor calls `UAssetEditorSubsystem::OpenEditorForAsset` and then `FindEditorForAsset`; if the latter returns null it records `AddInfo(...)` and `return true` — a labelled skip, never a failure. Only two of the seven new native tests depend on that; the rest assert unconditionally.
- **Proof is the count, not the exit code.** `reportExitCode` in `server/native-test-report.mjs` returns 0 whenever `failed === 0 && notRun === 0`, so a test that fails to register leaves the total unchanged and still exits 0. Every plugin task's proof line is the runner's `Native tests: <N> passed, 0 failed, 0 not run` with N stated: **22 (baseline) / 26 / 29 / 29 / 29**.
- **The Node rotation moves, and every task states its number.** Baseline **7580 passed / 0 failed across 79 files** (measured on this HEAD with `node run-rotation.mjs`). After each task: **7629 / 7639 / 7647 / 7664 / 7664**.
- **Deploy cycle, run from the repo root, after every plugin change** (about 25 s for `Build.bat` on this module, about 30 s for the native run):

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
node server/verify-deploy.mjs --quiet --no-color --profile smoke
```

  **Close the editor before `Build.bat`** — a running editor locks the module DLL and the build is a silent no-op (D135); `verify-deploy` reports that as `[EDITOR-LOCKED]`. `verify-deploy.mjs` must print `SYNC` for the target afterwards. The pre-push compile gate refuses to publish plugin source while a built target reads NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY.
- **The live smoke is run by the orchestrator, not by the task implementer.** Task 5 writes `server/live-smoke-asset-editor-capture.mjs` and states exactly what a successful run prints; it does not run it. The native suite proves addressing and error handling, the smoke is the only proof of pixels.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools.yaml` | Modify (Task 1) | Five new `visual-capture` entries; `capture_active_editor_tab` removed. |
| `server/menhance-tcp-tools.mjs` | Modify (Task 1) | Five `MENHANCE_SCHEMAS` entries — description, Zod shape, `isReadOp: false`. |
| `server/test-tcp-tools.mjs` | Modify (Task 1) | 40 assertions: registration, routing, params, inline cap, error codes. |
| `server/test-visual-capture-source.mjs` | Modify (Tasks 1, 2, 3) | Task 1 adds 9 `tools.yaml` registry assertions; Tasks 2 and 3 add 10 and 8 plugin-source assertions. |
| `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h` | Create (Task 2), Modify (Task 3) | Shared types and helpers: target resolution, tab enumeration, widget walk, capture, PNG tail. Task 3 adds the details-view helpers. |
| `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp` | Create (Task 2), Modify (Task 3) | Helper bodies, `namespace UEMCP`, no anonymous namespace. |
| `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp` | Create (Task 2), Modify (Task 3) | The five handlers and `RegisterAssetEditorCaptureHandlers`. |
| `plugin/UEMCP/Source/UEMCP/Private/MCPCommandRegistry.cpp` | Modify (Task 2) | One include, one `Register…` call. |
| `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs` | Modify (Task 3) | `PropertyEditor` private dependency for `IDetailsView`. |
| `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp` | Create (Task 2), Modify (Task 3) | 4 then 7 automation tests, `UEMCP.AssetEditorCapture.*`, helpers in `namespace UEMCP::AssetEditorCapture::Tests`. |
| `server/editor-readiness.mjs` | Modify (Task 4) | Identity comparison in the probe; futile-phase exit; the new hint. |
| `server/create-uemcp-server.mjs` | Modify (Task 4) | Pass the attached path to the probe; `identityMismatch` on `connection_info`. |
| `server/project-tools.mjs` | Modify (Task 4) | `identityMismatch` on `MANAGEMENT_OUTPUT_SHAPE`. |
| `server/test-editor-readiness.mjs` | Modify (Task 4) | 13 assertions for the probe, the wait and the hint. |
| `server/test-project-server-wire.mjs` | Modify (Task 4) | 4 assertions for `connection_info`. |
| `server/live-smoke-asset-editor-capture.mjs` | Create (Task 5) | Opt-in live smoke; not in the rotation. |
| `manifest.json`, `plugin/UEMCP/UEMCP.uplugin`, `server/test-plugin-manifest.mjs` | Modify (Task 5) | Version lockstep bump 1.0.17 → 1.0.18 / 18 → 19. |
| `CLAUDE.md`, `docs/tracking/backlog.md`, `docs/tracking/risks-and-decisions.md` | Modify (Task 5) | Tool counts, EN-24/EN-25 closure, D198. |

The test helper namespace `UEMCP::AssetEditorCapture::Tests` is deliberately distinct from WS5a's `UEMCP::Blueprint::Tests`: under Unity the two test files may land in the same translation unit, and two same-named helpers in the same namespace would be a redefinition error.

---

### Task 1: `tools.yaml`, server wiring, and the Node rotation

**Files:**
- Modify: `tools.yaml` (the `visual-capture` toolset, currently lines 1565-1627)
- Modify: `server/menhance-tcp-tools.mjs` (the `MENHANCE_SCHEMAS` block, after `get_viewport_screenshot`)
- Modify: `server/test-tcp-tools.mjs` (append a block before the final `process.exit(t.summary())`)
- Modify: `server/test-visual-capture-source.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Tasks 2-5:
  - Five callable tool names on `tcp-55558` with identity wire types (no `wire_type:` overrides): `list_asset_editor_tabs`, `capture_asset_editor`, `details_panel_expand_all`, `details_panel_scroll`, `capture_pie_viewport`.
  - The wire request/response contract the plugin must satisfy, fixed here: request params exactly as declared below; success results `{asset_path, editor_class, tabs[]}`, `{asset_path, tab_id, width, height, byte_length, mime, png_path, png_base64?, inline_omitted?}`, `{expanded, rows_before, rows_after}`, `{row_offset, requested_row_offset, max_row_offset}`, `{width, height, byte_length, mime, png_path, png_base64?, inline_omitted?}`; error codes `MISSING_PARAMS`, `ASSET_NOT_FOUND`, `EDITOR_NOT_OPEN`, `TAB_NOT_FOUND`, `NOT_A_DETAILS_PANEL`, `CAPTURE_FAILED`, `CAPTURE_UNSUPPORTED`, `PIE_NOT_RUNNING`, `FILE_WRITE_FAILED`.

- [ ] **Step 1: Pre-start check — is the working tree clean?**

```bash
git status --short
git log --oneline -3
```

Expected: no output from the first command. **Stop and report** if `tools.yaml`, `server/menhance-tcp-tools.mjs` or anything under `plugin/UEMCP/Source/` has uncommitted changes — this plan assumes the HEAD measured in Global Constraints (rotation 7580/79 files, native 22).

- [ ] **Step 2: Record the baseline**

```bash
cd server && node run-rotation.mjs
```

Expected: `Aggregate: 7580 passed / 0 failed / 7580 total`, `Files run: 79`. If it differs, **use the number you measured as the baseline** and add the per-task deltas (+49, +10, +8, +16, +0) to it; report the discrepancy in the task report rather than editing the plan's arithmetic silently.

- [ ] **Step 3: Replace the `capture_active_editor_tab` entry in `tools.yaml`**

In `tools.yaml`, inside `toolsets: visual-capture: tools:`, delete this entry entirely:

```yaml
      capture_active_editor_tab:
        status: planned
        discoverable: false
        note: Planned editor-widget capture; excluded until FWidgetRenderer path ships.
        description: Active editor panel (BP graph, material editor, etc.) via FWidgetRenderer. Asset must be open.
        params: {}
```

and put these five in its place (same indentation — six spaces for the tool name, eight for its fields):

```yaml
      list_asset_editor_tabs:
        status: shipped
        availability_layer: tcp-55558
        transport_layer: tcp-55558
        requires_editor: true
        requires_pie: false
        mutates_asset: false
        mutates_level: false
        saves_asset: false
        compiles_asset: false
        offline_fallback: false
        description: List the live tabs of an already-open asset editor, with the tab ids capture_asset_editor addresses. Lists the tabs the editor advertises in its Window menu; never opens an editor or a tab.
        params:
          asset_path: { type: string, required: true, description: "/Game/... path to an asset whose editor is already open" }
      capture_asset_editor:
        status: shipped
        availability_layer: tcp-55558
        transport_layer: tcp-55558
        requires_editor: true
        requires_pie: false
        mutates_asset: false
        mutates_level: false
        saves_asset: false
        compiles_asset: false
        offline_fallback: false
        description: Capture an open asset editor, or one of its tabs, as a PNG on disk. Addressed by asset path; call list_asset_editor_tabs first for tab ids. Does not open an editor.
        params:
          asset_path: { type: string, required: true, description: "/Game/... path to an asset whose editor is already open" }
          tab_id:     { type: string, required: false, description: "Tab id from list_asset_editor_tabs; default is the editor's active tab" }
          out_png:    { type: string, required: false, description: "Output path; absolute or relative to Saved/. Default Saved/UEMCP/Captures/<asset>_<tab>_<timestamp>.png" }
          inline:     { type: boolean, required: false, default: false, description: "Also return base64 PNG; replaced by inline_omitted=too_large above 8 MiB of base64" }
      details_panel_expand_all:
        status: shipped
        availability_layer: tcp-55558
        transport_layer: tcp-55558
        requires_editor: true
        requires_pie: false
        mutates_asset: false
        mutates_level: false
        saves_asset: false
        compiles_asset: false
        offline_fallback: false
        description: Expand every row of an open editor's Details tab so a following capture_asset_editor shows the whole property grid. Advanced rows appear after the next editor tick.
        params:
          asset_path: { type: string, required: true, description: "/Game/... path to an asset whose editor is already open" }
          tab_id:     { type: string, required: true, description: "Tab id of a Details tab, from list_asset_editor_tabs" }
      details_panel_scroll:
        status: shipped
        availability_layer: tcp-55558
        transport_layer: tcp-55558
        requires_editor: true
        requires_pie: false
        mutates_asset: false
        mutates_level: false
        saves_asset: false
        compiles_asset: false
        offline_fallback: false
        description: Scroll an open editor's Details tab to a row offset for paged review captures. Row offsets are stable across DPI and panel size; the response reports the row actually reached.
        params:
          asset_path: { type: string, required: true, description: "/Game/... path to an asset whose editor is already open" }
          tab_id:     { type: string, required: true, description: "Tab id of a Details tab, from list_asset_editor_tabs" }
          row_offset: { type: number, required: true, description: "0-based row to scroll to; clamped to max_row_offset" }
      capture_pie_viewport:
        status: shipped
        availability_layer: tcp-55558
        transport_layer: tcp-55558
        requires_editor: true
        requires_pie: true
        mutates_asset: false
        mutates_level: false
        saves_asset: false
        compiles_asset: false
        offline_fallback: false
        description: Capture the running PIE game viewport as a PNG on disk, including when PIE runs in its own window (where get_viewport_screenshot still returns the level editor).
        params:
          out_png: { type: string, required: false, description: "Output path; absolute or relative to Saved/. Default Saved/UEMCP/Captures/PIE_<timestamp>.png" }
          inline:  { type: boolean, required: false, default: false, description: "Also return base64 PNG; replaced by inline_omitted=too_large above 8 MiB of base64" }
```

- [ ] **Step 4: Add the five schemas to `server/menhance-tcp-tools.mjs`**

In `MENHANCE_SCHEMAS`, immediately after the `get_viewport_screenshot` entry and before the closing `};`:

```js
  // ── EN-24/EN-25: asset-editor, details-panel and PIE capture ──
  // All five skip the cache: editor UI state (open tabs, expansion, scroll,
  // PIE frame) changes under the caller between identical requests, which is
  // the same reason get_viewport_screenshot is not a read-op.
  list_asset_editor_tabs: {
    description: 'List the live tabs of an already-open asset editor, with the tab ids capture_asset_editor addresses. Never opens an editor.',
    schema: {
      asset_path: z.string().describe('/Game/... path to an asset whose editor is already open'),
    },
    isReadOp: false,
  },

  capture_asset_editor: {
    description: 'Capture an open asset editor, or one of its tabs, as a PNG on disk. Call list_asset_editor_tabs first for tab ids.',
    schema: {
      asset_path: z.string().describe('/Game/... path to an asset whose editor is already open'),
      tab_id: z.string().optional()
        .describe('Tab id from list_asset_editor_tabs; default is the editor\'s active tab'),
      out_png: z.string().optional()
        .describe('Output path; absolute or relative to Saved/. Default Saved/UEMCP/Captures/<asset>_<tab>_<timestamp>.png'),
      // Left .optional() rather than .default(false) so an omitted flag stays
      // off the wire and the plugin owns the default — the same shape as
      // get_viewport_screenshot's return_base64.
      inline: z.boolean().optional()
        .describe('Also return base64 PNG; replaced by inline_omitted=too_large above 8 MiB of base64'),
    },
    isReadOp: false,
  },

  details_panel_expand_all: {
    description: 'Expand every row of an open editor\'s Details tab so a following capture shows the whole property grid.',
    schema: {
      asset_path: z.string().describe('/Game/... path to an asset whose editor is already open'),
      tab_id: z.string().describe('Tab id of a Details tab, from list_asset_editor_tabs'),
    },
    isReadOp: false,
  },

  details_panel_scroll: {
    description: 'Scroll an open editor\'s Details tab to a row offset for paged review captures.',
    schema: {
      asset_path: z.string().describe('/Game/... path to an asset whose editor is already open'),
      tab_id: z.string().describe('Tab id of a Details tab, from list_asset_editor_tabs'),
      row_offset: z.number().int().min(0)
        .describe('0-based row to scroll to; clamped to max_row_offset'),
    },
    isReadOp: false,
  },

  capture_pie_viewport: {
    description: 'Capture the running PIE game viewport as a PNG on disk, including when PIE runs in its own window.',
    schema: {
      out_png: z.string().optional()
        .describe('Output path; absolute or relative to Saved/. Default Saved/UEMCP/Captures/PIE_<timestamp>.png'),
      inline: z.boolean().optional()
        .describe('Also return base64 PNG; replaced by inline_omitted=too_large above 8 MiB of base64'),
    },
    isReadOp: false,
  },
```

No `initMenhanceTools` change is needed: the wire types are identity, and the function already scans the `visual-capture` toolset for `wire_type:` overrides.

- [ ] **Step 5: Write the failing rotation block**

Append to `server/test-tcp-tools.mjs`, immediately before the final `process.exit(t.summary())`:

```js
// ═══════════════════════════════════════════════════════════════
// EN-24/EN-25: asset-editor, details-panel and PIE capture tools.
//
// The wire contract fixed here is what the plugin handlers must satisfy:
// param names on the request, field names on the result, and the error codes.
// Every tool skips the cache, so each sub-case can re-register a responder
// for the same command and get the new answer.
// ═══════════════════════════════════════════════════════════════
{
  // The M-enhance bindings are block-scoped in the get_viewport_screenshot
  // block above, so this block does its own setup: the real tools.yaml, so
  // wire_type translation is the shipped one rather than the fake structure
  // the blueprints-write tests use.
  const { readFileSync } = await import('node:fs');
  const yaml = (await import('js-yaml')).default;
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const toolsData = yaml.load(readFileSync(join(__dirname, '..', 'tools.yaml'), 'utf-8'));
  const { initMenhanceTools, executeMenhanceTool, getMenhanceToolDefs } =
    await import('./menhance-tcp-tools.mjs');
  initMenhanceTools(toolsData);

  const captureTools = [
    'list_asset_editor_tabs',
    'capture_asset_editor',
    'details_panel_expand_all',
    'details_panel_scroll',
    'capture_pie_viewport',
  ];
  const defs = getMenhanceToolDefs();
  for (const name of captureTools) {
    t.assert(defs[name] !== undefined, `${name} is registered in M-enhance defs`);
    t.assert(defs[name]?.isReadOp === false,
      `${name} bypasses cache because editor UI state is volatile`);
  }

  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('list_asset_editor_tabs', {
    status: 'success',
    result: {
      asset_path: '/Game/Probe/BP_Probe.BP_Probe',
      editor_class: 'BlueprintEditor',
      tabs: [
        { tab_id: 'Details', display_name: 'Details', is_active: true, has_viewport: false },
        { tab_id: 'GraphEditor', display_name: 'Event Graph', is_active: false, has_viewport: false },
      ],
    },
  });
  fake.on('capture_asset_editor', (port, type, params) => ({
    status: 'success',
    result: {
      asset_path: params.asset_path,
      tab_id: params.tab_id || 'Details',
      width: 1280,
      height: 720,
      byte_length: 4096,
      mime: 'image/png',
      png_path: 'Saved/UEMCP/Captures/BP_Probe_Details_20260913-120000-001.png',
      ...(params.inline === true ? { png_base64: 'iVBORw0KGgo=' } : {}),
    },
  }));
  fake.on('details_panel_expand_all', {
    status: 'success',
    result: { expanded: true, rows_before: 12, rows_after: 48 },
  });
  fake.on('details_panel_scroll', (port, type, params) => ({
    status: 'success',
    result: { row_offset: params.row_offset, requested_row_offset: params.row_offset, max_row_offset: 47 },
  }));
  fake.on('capture_pie_viewport', {
    status: 'success',
    result: {
      width: 1920,
      height: 1080,
      byte_length: 8192,
      mime: 'image/png',
      png_path: 'Saved/UEMCP/Captures/PIE_20260913-120001-002.png',
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // ---- list_asset_editor_tabs ----
  const tabs = await executeMenhanceTool('list_asset_editor_tabs',
    { asset_path: '/Game/Probe/BP_Probe' }, cm);
  t.assert(tabs.result.tabs.length === 2, 'list_asset_editor_tabs returns the tab array');
  t.assert(tabs.result.tabs[0].tab_id === 'Details',
    'list_asset_editor_tabs surfaces tab_id for addressing');
  t.assert(tabs.result.editor_class === 'BlueprintEditor',
    'list_asset_editor_tabs names the toolkit class');
  const tabsCall = fake.lastCall('list_asset_editor_tabs');
  t.assert(tabsCall.port === 55558, 'list_asset_editor_tabs routed to tcp-55558');
  t.assert(tabsCall.params.asset_path === '/Game/Probe/BP_Probe',
    'list_asset_editor_tabs forwards asset_path unchanged');

  // ---- capture_asset_editor: default (file only) ----
  const capture = await executeMenhanceTool('capture_asset_editor',
    { asset_path: '/Game/Probe/BP_Probe', tab_id: 'Details' }, cm);
  t.assert(typeof capture.result.png_path === 'string' && capture.result.png_path.endsWith('.png'),
    'capture_asset_editor always reports a written PNG path');
  t.assert(capture.result.png_base64 === undefined,
    'capture_asset_editor omits base64 unless inline was requested');
  t.assert(capture.result.width === 1280 && capture.result.height === 720,
    'capture_asset_editor reports captured pixel dimensions');
  const defaultCall = fake.lastCall('capture_asset_editor');
  t.assert(defaultCall.port === 55558, 'capture_asset_editor routed to tcp-55558');
  t.assert(defaultCall.params.tab_id === 'Details', 'capture_asset_editor forwards tab_id');
  t.assert(!('inline' in defaultCall.params),
    'omitted inline stays off the wire so the plugin owns the default');
  t.assert(!('out_png' in defaultCall.params),
    'omitted out_png stays off the wire so the plugin picks the default path');

  // ---- capture_asset_editor: inline ----
  const inlineCapture = await executeMenhanceTool('capture_asset_editor',
    { asset_path: '/Game/Probe/BP_Probe', inline: true }, cm);
  t.assert(typeof inlineCapture.result.png_base64 === 'string',
    'capture_asset_editor returns base64 when inline is requested');
  t.assert(fake.lastCall('capture_asset_editor').params.inline === true,
    'inline flag forwarded to the wire');
  t.assert(inlineCapture.result.tab_id === 'Details',
    'capture_asset_editor reports the tab it actually captured');

  // ---- capture_asset_editor: inline above the 8 MiB cap ----
  // The plugin drops the payload and says so; the path is the fallback, which
  // is why the file is always written rather than written on request.
  fake.on('capture_asset_editor', {
    status: 'success',
    result: {
      asset_path: '/Game/Probe/BP_Probe',
      tab_id: 'Viewport',
      width: 3840,
      height: 2160,
      byte_length: 9_000_000,
      mime: 'image/png',
      png_path: 'Saved/UEMCP/Captures/BP_Probe_Viewport_20260913-120002-003.png',
      inline_omitted: 'too_large',
    },
  });
  const oversized = await executeMenhanceTool('capture_asset_editor',
    { asset_path: '/Game/Probe/BP_Probe', inline: true }, cm);
  t.assert(oversized.result.inline_omitted === 'too_large',
    'oversized inline capture reports inline_omitted');
  t.assert(oversized.result.png_base64 === undefined,
    'oversized inline capture carries no base64');
  t.assert(typeof oversized.result.png_path === 'string',
    'oversized inline capture still reports the written path');

  // ---- details panel ----
  const expanded = await executeMenhanceTool('details_panel_expand_all',
    { asset_path: '/Game/Probe/BP_Probe', tab_id: 'Details' }, cm);
  t.assert(expanded.result.expanded === true, 'details_panel_expand_all reports expanded');
  t.assert(expanded.result.rows_after > expanded.result.rows_before,
    'details_panel_expand_all reports the row count it changed');
  const scrolled = await executeMenhanceTool('details_panel_scroll',
    { asset_path: '/Game/Probe/BP_Probe', tab_id: 'Details', row_offset: 24 }, cm);
  t.assert(scrolled.result.row_offset === 24, 'details_panel_scroll reports the row reached');
  t.assert(scrolled.result.max_row_offset === 47,
    'details_panel_scroll reports the paging ceiling');
  t.assert(fake.lastCall('details_panel_scroll').params.row_offset === 24,
    'row_offset forwarded to the wire');

  // ---- PIE viewport ----
  const pie = await executeMenhanceTool('capture_pie_viewport', {}, cm);
  t.assert(pie.result.width === 1920 && pie.result.height === 1080,
    'capture_pie_viewport reports the PIE viewport dimensions');
  t.assert(typeof pie.result.png_path === 'string',
    'capture_pie_viewport always reports a written PNG path');
  t.assert(fake.lastCall('capture_pie_viewport').port === 55558,
    'capture_pie_viewport routed to tcp-55558');

  // ---- Zod rejects malformed calls before any wire dispatch ----
  await t.assertRejects(
    () => executeMenhanceTool('capture_asset_editor', {}, cm),
    /asset_path/,
    'capture_asset_editor rejects missing asset_path'
  );
  await t.assertRejects(
    () => executeMenhanceTool('list_asset_editor_tabs', {}, cm),
    /asset_path/,
    'list_asset_editor_tabs rejects missing asset_path'
  );
  await t.assertRejects(
    () => executeMenhanceTool('details_panel_expand_all', { asset_path: '/Game/X' }, cm),
    /tab_id/,
    'details_panel_expand_all rejects missing tab_id'
  );
  await t.assertRejects(
    () => executeMenhanceTool('details_panel_scroll', { asset_path: '/Game/X', tab_id: 'Details' }, cm),
    /row_offset/,
    'details_panel_scroll rejects missing row_offset'
  );
  await t.assertRejects(
    () => executeMenhanceTool('details_panel_scroll',
      { asset_path: '/Game/X', tab_id: 'Details', row_offset: -1 }, cm),
    /row_offset/,
    'details_panel_scroll rejects a negative row_offset'
  );

  // ---- typed plugin error codes survive the transport ----
  // ConnectionManager.makeLayerWireError copies the envelope's `code` onto the
  // thrown Error, so a caller can branch on the code rather than on prose.
  async function capturedCode(toolName, args, manager) {
    try {
      await executeMenhanceTool(toolName, args, manager);
      return null;
    } catch (err) {
      return err.code || null;
    }
  }

  const errFake = new FakeTcpResponder();
  errFake.on('ping', { status: 'success' });
  errFake.on('capture_asset_editor',
    { status: 'error', error: 'No asset editor is open for /Game/X', code: 'EDITOR_NOT_OPEN' });
  errFake.on('list_asset_editor_tabs',
    { status: 'error', error: 'Could not load asset at /Game/X', code: 'ASSET_NOT_FOUND' });
  errFake.on('details_panel_expand_all',
    { status: 'error', error: "Tab 'Viewport' contains no SDetailsView", code: 'NOT_A_DETAILS_PANEL' });
  errFake.on('details_panel_scroll',
    { status: 'error', error: "No live tab 'Nope'", code: 'TAB_NOT_FOUND' });
  errFake.on('capture_pie_viewport',
    { status: 'error', error: 'No PIE session is running', code: 'PIE_NOT_RUNNING' });
  const { config: errConfig } = createTestConfig('D:/FakeProject', errFake);
  const errCm = new ConnectionManager(errConfig);

  t.assert(await capturedCode('capture_asset_editor', { asset_path: '/Game/X' }, errCm) === 'EDITOR_NOT_OPEN',
    'capture_asset_editor surfaces EDITOR_NOT_OPEN');
  t.assert(await capturedCode('list_asset_editor_tabs', { asset_path: '/Game/X' }, errCm) === 'ASSET_NOT_FOUND',
    'list_asset_editor_tabs surfaces ASSET_NOT_FOUND');
  t.assert(await capturedCode('details_panel_expand_all', { asset_path: '/Game/X', tab_id: 'Viewport' }, errCm) === 'NOT_A_DETAILS_PANEL',
    'details_panel_expand_all surfaces NOT_A_DETAILS_PANEL');
  t.assert(await capturedCode('details_panel_scroll', { asset_path: '/Game/X', tab_id: 'Nope', row_offset: 0 }, errCm) === 'TAB_NOT_FOUND',
    'details_panel_scroll surfaces TAB_NOT_FOUND');
  t.assert(await capturedCode('capture_pie_viewport', {}, errCm) === 'PIE_NOT_RUNNING',
    'capture_pie_viewport surfaces PIE_NOT_RUNNING');

  errFake.on('capture_asset_editor',
    { status: 'error', error: 'No Slate renderer is available', code: 'CAPTURE_UNSUPPORTED' });
  t.assert(await capturedCode('capture_asset_editor', { asset_path: '/Game/X' }, errCm) === 'CAPTURE_UNSUPPORTED',
    'capture_asset_editor surfaces CAPTURE_UNSUPPORTED when there is no renderer');
}
```

**The block imports the M-enhance module itself, on purpose.** The existing `get_viewport_screenshot` tests live inside a `{ … }` block that dynamically imports `menhance-tcp-tools.mjs` and calls `initMenhanceTools(toolsData)` with the real `tools.yaml`; those bindings are block-scoped and not visible at the end of the file. The block above repeats that setup rather than being nested inside the existing one, which is also why it can be appended at the end without hunting for a closing brace. `FakeTcpResponder`, `TestRunner`, `createTestConfig` and `ConnectionManager` are top-level imports already — do not re-import those.

- [ ] **Step 6: Run it and watch it fail**

```bash
cd server && node test-tcp-tools.mjs
```

Expected: **FAIL** on the first ten assertions with `list_asset_editor_tabs is registered in M-enhance defs` before Step 4 is applied. If you applied Steps 3-5 together, it passes; in that case revert Step 4 in your working copy, re-run to see the failure, and re-apply. The point is to see the registration assertions bind to something that can be absent.

- [ ] **Step 7: Add the `tools.yaml` registry assertions**

In `server/test-visual-capture-source.mjs`, change the header comment's first line to:

```js
// Static source and registry checks for visual-capture plugin handlers.
```

add these imports next to the existing ones:

```js
import { load } from 'js-yaml';
```

and append before the final `process.exit(t.summary())`:

```js
// ── tools.yaml registry: the EN-24/EN-25 entries ──────────────
// The removed capture_active_editor_tab was status: planned and never
// registered; capture_asset_editor supersedes it. Pinning its absence keeps a
// future editor from reviving a tool with no handler behind it.
const toolsYaml = load(readFileSync(join(REPO_ROOT, 'tools.yaml'), 'utf8'));
const visualCapture = toolsYaml.toolsets['visual-capture'].tools;

t.assert(visualCapture.capture_active_editor_tab === undefined,
  'capture_active_editor_tab is removed from the visual-capture toolset');
for (const name of [
  'list_asset_editor_tabs',
  'capture_asset_editor',
  'details_panel_expand_all',
  'details_panel_scroll',
  'capture_pie_viewport',
]) {
  t.assert(visualCapture[name]?.status === 'shipped',
    `${name} is declared shipped in the visual-capture toolset`);
}
t.assert(visualCapture.capture_asset_editor.params.out_png !== undefined &&
  visualCapture.capture_asset_editor.params.inline !== undefined,
  'capture_asset_editor declares the spec param names out_png and inline');
t.assert(visualCapture.details_panel_scroll.params.row_offset?.required === true,
  'details_panel_scroll requires row_offset');
t.assert(visualCapture.capture_pie_viewport.requires_pie === true,
  'capture_pie_viewport declares requires_pie');
```

- [ ] **Step 8: Run the affected suites, then the whole rotation**

```bash
cd server
node test-tcp-tools.mjs
node test-visual-capture-source.mjs
node test-tool-registry-truth.mjs
node test-tool-metadata.mjs
node test-tool-requirements.mjs
node test-tool-discovery-intents.mjs
node test-phase1.mjs
node run-rotation.mjs
```

Expected: every suite green, and `Aggregate: 7629 passed / 0 failed / 7629 total` across 79 files (+49 = 40 in `test-tcp-tools.mjs` + 9 in `test-visual-capture-source.mjs`).

Two of these deserve attention rather than a glance. `test-tool-registry-truth.mjs` is the gate that makes this task-ordering correct: it asserts every *active* live YAML tool has a callable Node definition map (satisfied by Step 4) **and** that every plugin-registered TCP command is covered by a Node wrapper (still satisfied, because no plugin command exists yet). `test-tool-discovery-intents.mjs` ranks `find_tools` intents in a top-5 window; if `capture_pie_viewport` displaces `get_pie_actor_state` or `sample_pie_actor_state` from `"PIE actor runtime state"`, **do not loosen the assertion** — shorten `capture_pie_viewport`'s description instead, since the displacement would mean the description over-claims on "actor" and "state".

- [ ] **Step 9: Commit**

```bash
git add tools.yaml server/menhance-tcp-tools.mjs server/test-tcp-tools.mjs server/test-visual-capture-source.mjs
git commit -F - <<'MSG'
Declare the asset-editor and PIE capture tools and wire them server-side

Five visual-capture tools on tcp-55558: list_asset_editor_tabs,
capture_asset_editor, details_panel_expand_all, details_panel_scroll and
capture_pie_viewport. capture_active_editor_tab is removed — it was
status: planned behind an FWidgetRenderer path that never shipped, and
capture_asset_editor supersedes it with explicit addressing.

This commit fixes the wire contract the plugin handlers must satisfy:
param names, result fields and the nine error codes, all asserted through
the mock seam. The handlers land next; the registry truthfulness gate stays
green in between because it requires a Node wrapper for every plugin
command, not a plugin command for every Node wrapper.

Rotation 7580 -> 7629 across 79 files.
MSG
```

---

### Task 2: Plugin — `list_asset_editor_tabs` and `capture_asset_editor`

**Files:**
- Create: `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h`
- Create: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp`
- Create: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp`
- Create: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/MCPCommandRegistry.cpp` (include block and `RegisterDefaultHandlers`)
- Modify: `server/test-visual-capture-source.mjs`

**Interfaces:**
- Consumes from Task 1: the wire contract — command names `list_asset_editor_tabs` and `capture_asset_editor`, request params `asset_path` / `tab_id` / `out_png` / `inline`, result fields and error codes as listed in Task 1's Produces block.
- Produces, all in `namespace UEMCP`, declared in `Public/AssetEditorCapture.h`, consumed by Task 3 and by the native tests:
  - `constexpr int64 InlineBase64MaxBytes`
  - `struct FAssetEditorTabInfo { FString TabId; FString DisplayName; bool bIsActive; bool bHasViewport; }`
  - `struct FAssetEditorTarget { UObject* Asset; IAssetEditorInstance* Editor; TSharedPtr<FTabManager> TabManager; FString ErrorCode; FString ErrorMessage; }`
  - `FAssetEditorTarget ResolveAssetEditorTarget(const FString& AssetPath)`
  - `void CollectAssetEditorTabs(const TSharedPtr<FTabManager>& TabManager, TArray<FAssetEditorTabInfo>& OutTabs)`
  - `TSharedPtr<SDockTab> ResolveCaptureTab(const FAssetEditorTarget& Target, const FString& TabId)`
  - `TSharedPtr<SWidget> FindDescendantByType(const TSharedPtr<SWidget>& Root, FName TypeName)`
  - `bool CanCaptureSlate()`
  - `FString DefaultCapturePath(const FString& Stem)`
  - `bool CaptureWidgetToPng(const TSharedRef<SWidget>& Widget, TArray64<uint8>& OutPng, FIntPoint& OutSize, FString& OutErrorCode, FString& OutErrorMessage)`
  - `bool FinishCapture(const TArray64<uint8>& Png, const FIntPoint& Size, const FString& RequestedPath, const FString& DefaultStem, bool bInline, const TSharedPtr<FJsonObject>& Result, FString& OutErrorMessage)`
  - `void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry)`

- [ ] **Step 0: Re-verify the 5.6 signatures**

The spec's §7 makes this the first plugin step. The signatures below were read from the 5.6 headers while this plan was written; re-run them so a different engine build cannot silently invalidate the code you are about to write.

```bash
cd "<UE_ENGINE_ROOT>/Engine/Source"
grep -n "FindEditorForAsset\|OpenEditorForAsset(UObject" Editor/UnrealEd/Public/Subsystems/AssetEditorSubsystem.h
grep -n "GetAssociatedTabManager\|GetEditorName" Editor/UnrealEd/Public/Subsystems/AssetEditorSubsystem.h
grep -n "TakeScreenshot" Runtime/Slate/Public/Framework/Application/SlateApplication.h
grep -n "FindExistingLiveTab\|CollectSpawners\|GetActiveTab" Runtime/Slate/Public/Framework/Docking/TabManager.h
grep -n "GetTabLabel\|GetLayoutIdentifier\|GetContent" Runtime/Slate/Public/Widgets/Docking/SDockTab.h
grep -n "CanEverRender" Runtime/Core/Public/Misc/App.h
grep -n "static bool CompressImage" Runtime/Engine/Public/ImageUtils.h
```

Expected, all present and public: `IAssetEditorInstance* FindEditorForAsset(UObject* Asset, bool bFocusIfOpen)`; `virtual TSharedPtr<class FTabManager> GetAssociatedTabManager()` and `virtual FName GetEditorName() const` on `IAssetEditorInstance`; `bool TakeScreenshot(const TSharedRef<SWidget>& Widget, TArray<FColor>& OutColorData, FIntVector& OutSize)`; `TSharedPtr<SDockTab> FindExistingLiveTab(const FTabId& TabId) const` and `TArray<TWeakPtr<FTabSpawnerEntry>> CollectSpawners()` on `FTabManager`, with `GetActiveTab()` on `FGlobalTabmanager`; `GetTabLabel`, `GetLayoutIdentifier` and `GetContent` on `SDockTab`; `FApp::CanEverRender()`; `FImageUtils::CompressImage(TArray64<uint8>&, const TCHAR*, const FImageView&, int32)`.

**Stop and report** if any differ. Use the 5.6 name and say so in the task report rather than working around a missing symbol — a mismatch here means the plan's Deviations section needs a fourth entry.

- [ ] **Step 1: Write the header**

Create `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Framework/Docking/TabManager.h"
#include "Widgets/Docking/SDockTab.h"

class IAssetEditorInstance;

/**
 * EN-24/EN-25: capture an open asset editor, page its Details panel, and
 * capture the PIE viewport.
 *
 * get_viewport_screenshot reads GEditor->GetActiveViewport(), which the engine
 * resolves to the level-editor viewport, so no asset editor is reachable
 * through it. These handlers address an editor explicitly by asset path.
 *
 * Nothing here opens anything. FindEditorForAsset is called with
 * bFocusIfOpen = false and tabs are resolved with FindExistingLiveTab, never
 * TryInvokeTab: a capture that reorders the user's tabs or steals focus is a
 * side effect a read-shaped tool must not have.
 *
 * These helpers live in a Public/ header for two reasons. Unity bundling makes
 * a duplicated anonymous-namespace symbol a link error (D133/D137), and
 * Private/Tests/*.cpp can only include Public/ headers, so anything a native
 * test needs to reach has to be declared here.
 *
 * Response shapes:
 *   list_asset_editor_tabs
 *     { asset_path, editor_class, tabs: [{ tab_id, display_name, is_active, has_viewport }] }
 *   capture_asset_editor / capture_pie_viewport
 *     { [asset_path, tab_id,] width, height, byte_length, mime, png_path,
 *       png_base64?, inline_omitted? }
 *   details_panel_expand_all   { expanded, rows_before, rows_after }
 *   details_panel_scroll       { row_offset, requested_row_offset, max_row_offset }
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/**
	 * Ceiling on the inline base64 payload, measured on the encoded string
	 * because that is what actually travels. Above it the capture still writes
	 * its file and the response says inline_omitted = "too_large" — a caller
	 * that asked for inline needs to be told it did not get it.
	 */
	constexpr int64 InlineBase64MaxBytes = 8 * 1024 * 1024;

	/** One live tab of an open asset editor. */
	struct FAssetEditorTabInfo
	{
		FString TabId;
		FString DisplayName;
		bool bIsActive = false;
		bool bHasViewport = false;
	};

	/**
	 * Resolution result shared by every handler here. A non-empty ErrorCode
	 * means the other fields are meaningless; the handler builds the error
	 * envelope from ErrorCode + ErrorMessage and returns.
	 */
	struct FAssetEditorTarget
	{
		UObject* Asset = nullptr;
		IAssetEditorInstance* Editor = nullptr;
		TSharedPtr<FTabManager> TabManager;
		FString ErrorCode;
		FString ErrorMessage;
	};

	/**
	 * Asset path -> already-open editor. Returns ASSET_NOT_FOUND when the path
	 * does not load and EDITOR_NOT_OPEN when no editor is open for it.
	 * Never opens an editor.
	 */
	FAssetEditorTarget ResolveAssetEditorTarget(const FString& AssetPath);

	/**
	 * Live tabs of the toolkit, from its registered spawners.
	 *
	 * FTabManager exposes no "enumerate live tabs" call, so this walks
	 * CollectSpawners() and keeps the ids FindExistingLiveTab answers for.
	 * CollectSpawners is documented as the spawners that get Window-menu
	 * entries, so a toolkit that hides a spawner will not have that tab listed
	 * — capture_asset_editor still accepts such an id, because it resolves
	 * through FindExistingLiveTab rather than through this list.
	 */
	void CollectAssetEditorTabs(const TSharedPtr<FTabManager>& TabManager, TArray<FAssetEditorTabInfo>& OutTabs);

	/**
	 * The tab to capture. A non-empty TabId is looked up directly; an empty one
	 * prefers the globally active tab when it belongs to this editor and
	 * otherwise takes the editor's first live tab. Returns null when nothing
	 * matches, which the caller reports as TAB_NOT_FOUND.
	 */
	TSharedPtr<SDockTab> ResolveCaptureTab(const FAssetEditorTarget& Target, const FString& TabId);

	/**
	 * Breadth-first search of a Slate subtree for an exact widget type name.
	 * SNew stamps the stringized type onto SWidget::TypeOfWidget, so the match
	 * is on the concrete class and nothing else. Bounded so a pathological
	 * layout cannot spin the game thread.
	 */
	TSharedPtr<SWidget> FindDescendantByType(const TSharedPtr<SWidget>& Root, FName TypeName);

	/**
	 * Whether Slate can produce pixels at all. False under -nullrhi, where
	 * TakeScreenshot returns an empty buffer rather than failing — so headless
	 * automation must be told CAPTURE_UNSUPPORTED, not handed a blank PNG.
	 */
	bool CanCaptureSlate();

	/** Saved/UEMCP/Captures/<Stem>_<YYYYMMDD-HHMMSS>-<ms>.png, absolute. */
	FString DefaultCapturePath(const FString& Stem);

	/** Widget -> PNG bytes. Sets CAPTURE_UNSUPPORTED or CAPTURE_FAILED on failure. */
	bool CaptureWidgetToPng(
		const TSharedRef<SWidget>& Widget,
		TArray64<uint8>& OutPng,
		FIntPoint& OutSize,
		FString& OutErrorCode,
		FString& OutErrorMessage);

	/**
	 * Writes the PNG and fills the shared result fields (width, height,
	 * byte_length, mime, png_path, and png_base64 or inline_omitted). The file
	 * is always written: the path is the fallback the inline cap relies on.
	 */
	bool FinishCapture(
		const TArray64<uint8>& Png,
		const FIntPoint& Size,
		const FString& RequestedPath,
		const FString& DefaultStem,
		bool bInline,
		const TSharedPtr<FJsonObject>& Result,
		FString& OutErrorMessage);

	void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry);
}
```

- [ ] **Step 2: Write the helper bodies**

Create `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
#include "AssetEditorCapture.h"

#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "Layout/Children.h"
#include "Misc/App.h"
#include "Misc/Base64.h"
#include "Misc/DateTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Toolkits/IToolkit.h"
#include "UObject/Object.h"
#include "UObject/SoftObjectPath.h"
#include "Widgets/SWidget.h"

namespace UEMCP
{
	FAssetEditorTarget ResolveAssetEditorTarget(const FString& AssetPath)
	{
		FAssetEditorTarget Target;
		if (AssetPath.IsEmpty())
		{
			Target.ErrorCode = TEXT("MISSING_PARAMS");
			Target.ErrorMessage = TEXT("asset_path is required");
			return Target;
		}

		// Same two-step resolution the other visual-capture handler uses: the
		// soft path handles the doubled object-path form, LoadObject the
		// package-only form.
		const FSoftObjectPath Soft(AssetPath);
		Target.Asset = Soft.TryLoad();
		if (!Target.Asset)
		{
			Target.Asset = LoadObject<UObject>(nullptr, *AssetPath);
		}
		if (!Target.Asset)
		{
			Target.ErrorCode = TEXT("ASSET_NOT_FOUND");
			Target.ErrorMessage = FString::Printf(TEXT("Could not load asset at '%s'"), *AssetPath);
			return Target;
		}

		UAssetEditorSubsystem* Subsystem = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
		if (!Subsystem)
		{
			Target.ErrorCode = TEXT("EDITOR_NOT_OPEN");
			Target.ErrorMessage = TEXT("The asset editor subsystem is unavailable");
			return Target;
		}

		// bFocusIfOpen = false: a capture must not steal focus or reorder tabs.
		Target.Editor = Subsystem->FindEditorForAsset(Target.Asset, /*bFocusIfOpen*/ false);
		if (!Target.Editor)
		{
			Target.ErrorCode = TEXT("EDITOR_NOT_OPEN");
			Target.ErrorMessage = FString::Printf(TEXT("No asset editor is open for '%s'"), *AssetPath);
			return Target;
		}

		Target.TabManager = Target.Editor->GetAssociatedTabManager();
		return Target;
	}

	TSharedPtr<SWidget> FindDescendantByType(const TSharedPtr<SWidget>& Root, FName TypeName)
	{
		if (!Root.IsValid())
		{
			return nullptr;
		}
		TArray<TSharedRef<SWidget>> Queue;
		Queue.Add(Root.ToSharedRef());
		const int32 MaxVisited = 8192;
		for (int32 Index = 0; Index < Queue.Num() && Index < MaxVisited; ++Index)
		{
			const TSharedRef<SWidget> Widget = Queue[Index];
			if (Widget->GetType() == TypeName)
			{
				return Widget;
			}
			FChildren* Children = Widget->GetChildren();
			const int32 Count = Children ? Children->Num() : 0;
			for (int32 Child = 0; Child < Count; ++Child)
			{
				Queue.Add(Children->GetChildAt(Child));
			}
		}
		return nullptr;
	}

	void CollectAssetEditorTabs(const TSharedPtr<FTabManager>& TabManager, TArray<FAssetEditorTabInfo>& OutTabs)
	{
		OutTabs.Reset();
		if (!TabManager.IsValid())
		{
			return;
		}
		const TSharedPtr<SDockTab> ActiveTab = FGlobalTabmanager::Get()->GetActiveTab();
		for (const TWeakPtr<FTabSpawnerEntry>& WeakSpawner : TabManager->CollectSpawners())
		{
			const TSharedPtr<FTabSpawnerEntry> Spawner = WeakSpawner.Pin();
			if (!Spawner.IsValid())
			{
				continue;
			}
			// A registered spawner with no live tab is not addressable.
			const TSharedPtr<SDockTab> Tab = TabManager->FindExistingLiveTab(FTabId(Spawner->GetTabType()));
			if (!Tab.IsValid())
			{
				continue;
			}
			FAssetEditorTabInfo Info;
			Info.TabId = Spawner->GetTabType().ToString();
			Info.DisplayName = Tab->GetTabLabel().ToString();
			Info.bIsActive = ActiveTab.IsValid() && ActiveTab == Tab;
			// Every rendered viewport composites through an SViewport, whatever
			// SEditorViewport subclass wraps it, so one core type name answers
			// this for all of them.
			Info.bHasViewport = FindDescendantByType(Tab->GetContent(), TEXT("SViewport")).IsValid();
			OutTabs.Add(Info);
		}
	}

	TSharedPtr<SDockTab> ResolveCaptureTab(const FAssetEditorTarget& Target, const FString& TabId)
	{
		if (!Target.TabManager.IsValid())
		{
			return nullptr;
		}
		if (!TabId.IsEmpty())
		{
			return Target.TabManager->FindExistingLiveTab(FTabId(FName(*TabId)));
		}
		TArray<FAssetEditorTabInfo> Tabs;
		CollectAssetEditorTabs(Target.TabManager, Tabs);
		for (const FAssetEditorTabInfo& Info : Tabs)
		{
			if (Info.bIsActive)
			{
				return Target.TabManager->FindExistingLiveTab(FTabId(FName(*Info.TabId)));
			}
		}
		return Tabs.Num() > 0
			? Target.TabManager->FindExistingLiveTab(FTabId(FName(*Tabs[0].TabId)))
			: nullptr;
	}

	bool CanCaptureSlate()
	{
		return FApp::CanEverRender() && FSlateApplication::IsInitialized();
	}

	FString DefaultCapturePath(const FString& Stem)
	{
		const FDateTime Now = FDateTime::Now();
		const FString FileName = FPaths::MakeValidFileName(FString::Printf(
			TEXT("%s_%s-%03d.png"),
			*Stem,
			*Now.ToString(TEXT("%Y%m%d-%H%M%S")),
			Now.GetMillisecond()));
		return FPaths::ConvertRelativePathToFull(
			FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEMCP"), TEXT("Captures"), FileName));
	}

	bool CaptureWidgetToPng(
		const TSharedRef<SWidget>& Widget,
		TArray64<uint8>& OutPng,
		FIntPoint& OutSize,
		FString& OutErrorCode,
		FString& OutErrorMessage)
	{
		if (!CanCaptureSlate())
		{
			OutErrorCode = TEXT("CAPTURE_UNSUPPORTED");
			OutErrorMessage = TEXT("No Slate renderer is available (headless or -nullrhi)");
			return false;
		}
		TArray<FColor> Pixels;
		FIntVector Size(0, 0, 0);
		if (!FSlateApplication::Get().TakeScreenshot(Widget, Pixels, Size) || Size.X <= 0 || Size.Y <= 0)
		{
			OutErrorCode = TEXT("CAPTURE_FAILED");
			OutErrorMessage = TEXT("FSlateApplication::TakeScreenshot produced no pixels for this widget");
			return false;
		}
		if (Pixels.Num() < Size.X * Size.Y)
		{
			OutErrorCode = TEXT("CAPTURE_FAILED");
			OutErrorMessage = FString::Printf(
				TEXT("TakeScreenshot returned %d pixels for a %dx%d widget"), Pixels.Num(), Size.X, Size.Y);
			return false;
		}
		OutSize = FIntPoint(Size.X, Size.Y);
		const FImageView View(Pixels.GetData(), OutSize.X, OutSize.Y);
		FImageUtils::CompressImage(OutPng, TEXT("png"), View, 0);
		if (OutPng.Num() == 0)
		{
			OutErrorCode = TEXT("CAPTURE_FAILED");
			OutErrorMessage = TEXT("PNG compression produced an empty buffer");
			return false;
		}
		return true;
	}

	bool FinishCapture(
		const TArray64<uint8>& Png,
		const FIntPoint& Size,
		const FString& RequestedPath,
		const FString& DefaultStem,
		bool bInline,
		const TSharedPtr<FJsonObject>& Result,
		FString& OutErrorMessage)
	{
		FString OutputPath = RequestedPath;
		if (OutputPath.IsEmpty())
		{
			OutputPath = DefaultCapturePath(DefaultStem);
		}
		else
		{
			if (!OutputPath.EndsWith(TEXT(".png")))
			{
				OutputPath += TEXT(".png");
			}
			if (FPaths::IsRelative(OutputPath))
			{
				OutputPath = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir(), OutputPath);
			}
		}
		const FString OutputDir = FPaths::GetPath(OutputPath);
		if (!OutputDir.IsEmpty())
		{
			IFileManager::Get().MakeDirectory(*OutputDir, true);
		}
		if (!FFileHelper::SaveArrayToFile(Png, *OutputPath))
		{
			OutErrorMessage = FString::Printf(TEXT("Failed to write PNG to '%s'"), *OutputPath);
			return false;
		}

		Result->SetNumberField(TEXT("width"), Size.X);
		Result->SetNumberField(TEXT("height"), Size.Y);
		Result->SetNumberField(TEXT("byte_length"), Png.Num());
		Result->SetStringField(TEXT("mime"), TEXT("image/png"));
		Result->SetStringField(TEXT("png_path"), OutputPath);
		if (bInline)
		{
			const int64 Base64Length = ((static_cast<int64>(Png.Num()) + 2) / 3) * 4;
			if (Base64Length > InlineBase64MaxBytes)
			{
				Result->SetStringField(TEXT("inline_omitted"), TEXT("too_large"));
			}
			else
			{
				Result->SetStringField(TEXT("png_base64"),
					FBase64::Encode(Png.GetData(), static_cast<uint32>(Png.Num())));
			}
		}
		return true;
	}
}
```

- [ ] **Step 3: Write the two handlers**

Create `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
#include "AssetEditorCapture.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/Paths.h"
#include "Toolkits/IToolkit.h"
#include "UObject/Object.h"

// No per-handler game-thread marshal: FMCPCommandRegistry::Dispatch already
// wraps every handler in RunOnGameThread (the Audit F-1 fix), so these run on
// the game thread by construction.
namespace UEMCP
{
	namespace
	{
		void HandleListAssetEditorTabs(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!Params.IsValid() || !Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					TEXT("list_asset_editor_tabs requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FAssetEditorTarget Target = ResolveAssetEditorTarget(AssetPath);
			if (!Target.ErrorCode.IsEmpty())
			{
				BuildErrorResponse(OutResponse, Target.ErrorMessage, Target.ErrorCode);
				return;
			}

			TArray<FAssetEditorTabInfo> Tabs;
			CollectAssetEditorTabs(Target.TabManager, Tabs);

			TArray<TSharedPtr<FJsonValue>> TabValues;
			for (const FAssetEditorTabInfo& Tab : Tabs)
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("tab_id"), Tab.TabId);
				Entry->SetStringField(TEXT("display_name"), Tab.DisplayName);
				Entry->SetBoolField(TEXT("is_active"), Tab.bIsActive);
				Entry->SetBoolField(TEXT("has_viewport"), Tab.bHasViewport);
				TabValues.Add(MakeShared<FJsonValueObject>(Entry));
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Target.Asset->GetPathName());
			Result->SetStringField(TEXT("editor_class"), Target.Editor->GetEditorName().ToString());
			Result->SetArrayField(TEXT("tabs"), TabValues);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleCaptureAssetEditor(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!Params.IsValid() || !Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					TEXT("capture_asset_editor requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FAssetEditorTarget Target = ResolveAssetEditorTarget(AssetPath);
			if (!Target.ErrorCode.IsEmpty())
			{
				BuildErrorResponse(OutResponse, Target.ErrorMessage, Target.ErrorCode);
				return;
			}

			FString TabId;
			Params->TryGetStringField(TEXT("tab_id"), TabId);

			// Addressing is resolved BEFORE the renderer gate. Under -nullrhi
			// every capture is CAPTURE_UNSUPPORTED, so gating first would make
			// ASSET_NOT_FOUND, EDITOR_NOT_OPEN and TAB_NOT_FOUND unreachable
			// headless — and those are exactly the paths the native suite can
			// test. The source assertion in test-visual-capture-source.mjs
			// compares the position of the two calls below, so keep the gate's
			// name out of this comment.
			const TSharedPtr<SDockTab> Tab = ResolveCaptureTab(Target, TabId);
			if (!Tab.IsValid())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("No live tab '%s' in the editor for '%s'"), *TabId, *AssetPath),
					TEXT("TAB_NOT_FOUND"));
				return;
			}

			TArray64<uint8> Png;
			FIntPoint Size(0, 0);
			FString ErrorCode;
			FString ErrorMessage;
			if (!CaptureWidgetToPng(Tab->GetContent(), Png, Size, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode);
				return;
			}

			bool bInline = false;
			Params->TryGetBoolField(TEXT("inline"), bInline);
			FString RequestedPath;
			Params->TryGetStringField(TEXT("out_png"), RequestedPath);

			const FString ResolvedTabId = Tab->GetLayoutIdentifier().TabType.ToString();
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Target.Asset->GetPathName());
			Result->SetStringField(TEXT("tab_id"), ResolvedTabId);

			const FString Stem = FString::Printf(TEXT("%s_%s"),
				*FPaths::GetBaseFilename(AssetPath), *ResolvedTabId);
			if (!FinishCapture(Png, Size, RequestedPath, Stem, bInline, Result, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, TEXT("FILE_WRITE_FAILED"));
				return;
			}
			BuildSuccessResponse(OutResponse, Result);
		}
	}

	void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("list_asset_editor_tabs"), &HandleListAssetEditorTabs);
		Registry.Register(TEXT("capture_asset_editor"), &HandleCaptureAssetEditor);
	}
}
```

- [ ] **Step 4: Register the family**

In `plugin/UEMCP/Source/UEMCP/Private/MCPCommandRegistry.cpp`, add to the "M-enhance CP3 handler registration" include block, in alphabetical position before `#include "CompileDiagnosticHandler.h"`:

```cpp
#include "AssetEditorCapture.h"
```

and in `RegisterDefaultHandlers()`, immediately after `RegisterVisualCaptureHandler(*this);`:

```cpp
		// EN-24/EN-25: asset-editor, details-panel and PIE capture. Kept out of
		// VisualCaptureHandler.cpp so get_viewport_screenshot's shipped
		// behaviour — and the source assertions that pin it — are untouched.
		RegisterAssetEditorCaptureHandlers(*this);
```

- [ ] **Step 5: Write the four native tests**

Create `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp`:

```cpp
// Copyright Noah Butcher. All Rights Reserved.
//
// EN-24/EN-25 native tests. Each test dispatches a real command through
// FMCPCommandRegistry — RegisterAssetEditorCaptureHandlers runs at module
// startup from MCPCommandRegistry.cpp, so the registry reaches the handlers in
// any editor with the plugin loaded.
//
// These prove addressing and error handling, not pixels. The runner passes
// -nullrhi, so FApp::CanEverRender() is false and any capture that gets as far
// as the renderer returns CAPTURE_UNSUPPORTED. That is asserted rather than
// worked around; the live smoke is the only proof of pixels.
//
// Two tests need an open asset editor. UAssetEditorSubsystem::OpenEditorForAsset
// may refuse under -nullrhi -unattended; those tests record AddInfo and return
// true rather than failing, and the four unconditional ones carry the coverage
// that must not depend on it.
//
// The fixture Blueprint lives in an unsaved in-memory package under
// /Game/__UEMCPTests/. Its object name MUST equal its package leaf: LoadObject
// resolves a dot-less path by retrying it as "<path>.<short name>" (engine
// StaticLoadObjectInternal), and that retry is the only reason
// ResolveAssetEditorTarget finds an unsaved object. Nothing is ever saved.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Toolkits/AssetEditorToolkit.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

#include "AssetEditorCapture.h"
#include "MCPCommandRegistry.h"

namespace UEMCP::AssetEditorCapture::Tests
{
	/** Package root for fixture Blueprints. Never saved; unique leaf per call. */
	static const TCHAR* FixtureRoot = TEXT("/Game/__UEMCPTests");

	struct FFixtureAsset
	{
		UBlueprint* Blueprint = nullptr;
		UPackage* Package = nullptr;
		/** What asset_path receives. */
		FString PackagePath;
	};

	/**
	 * Actor-parented Blueprint in a fresh in-memory package. The object name
	 * equals the package leaf — see the file header for why that is
	 * load-bearing.
	 */
	FFixtureAsset CreateFixtureAsset()
	{
		FFixtureAsset Fixture;
		const FString Leaf = FString::Printf(TEXT("BP_UEMCPCapture_%s"),
			*FGuid::NewGuid().ToString(EGuidFormats::Short));
		Fixture.PackagePath = FString::Printf(TEXT("%s/%s"), FixtureRoot, *Leaf);
		Fixture.Package = CreatePackage(*Fixture.PackagePath);
		if (!Fixture.Package)
		{
			return Fixture;
		}
		Fixture.Blueprint = FKismetEditorUtilities::CreateBlueprint(
			AActor::StaticClass(),
			Fixture.Package,
			FName(*Leaf),
			BPTYPE_Normal,
			UBlueprint::StaticClass(),
			UBlueprintGeneratedClass::StaticClass());
		if (Fixture.Blueprint)
		{
			FAssetRegistryModule::AssetCreated(Fixture.Blueprint);
		}
		return Fixture;
	}

	/**
	 * Best-effort teardown. Isolation comes from the unique package leaf, not
	 * from collection, so no test asserts the object is gone.
	 */
	void DestroyFixtureAsset(FFixtureAsset& Fixture)
	{
		if (Fixture.Blueprint)
		{
			if (GEditor)
			{
				if (UAssetEditorSubsystem* Subsystem = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
				{
					Subsystem->CloseAllEditorsForAsset(Fixture.Blueprint);
				}
			}
			FAssetRegistryModule::AssetDeleted(Fixture.Blueprint);
			Fixture.Blueprint->ClearFlags(RF_Public | RF_Standalone);
			Fixture.Blueprint->MarkAsGarbage();
			Fixture.Blueprint = nullptr;
		}
		if (Fixture.Package)
		{
			Fixture.Package->SetDirtyFlag(false);
			Fixture.Package->ClearFlags(RF_Public | RF_Standalone);
			Fixture.Package->MarkAsGarbage();
			Fixture.Package = nullptr;
		}
		CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
	}

	/** One command through the registry the plugin populates at startup. */
	TSharedPtr<FJsonObject> Dispatch(const FString& Command, const TSharedPtr<FJsonObject>& Params)
	{
		TSharedPtr<FJsonObject> Response;
		FMCPCommandRegistry::Get().Dispatch(Command, Params, Response);
		return Response;
	}

	/** Error code from a response, or "SUCCESS", or "NO_RESPONSE". */
	FString CodeOf(const TSharedPtr<FJsonObject>& Response)
	{
		if (!Response.IsValid())
		{
			return TEXT("NO_RESPONSE");
		}
		FString Status;
		Response->TryGetStringField(TEXT("status"), Status);
		if (Status == TEXT("success"))
		{
			return TEXT("SUCCESS");
		}
		FString Code;
		Response->TryGetStringField(TEXT("code"), Code);
		return Code.IsEmpty() ? TEXT("ERROR") : Code;
	}

	/**
	 * Log-silent string read. FJsonObject::GetStringField logs a LogJson Error
	 * on an absent field and the automation framework counts an Error-level log
	 * as a failure, so a missing optional field would be reported as a JSON
	 * type error rather than as the assertion that actually failed.
	 */
	FString StringFieldOr(const TSharedPtr<FJsonObject>& Obj, const FString& Field)
	{
		FString Value;
		if (Obj.IsValid())
		{
			Obj->TryGetStringField(Field, Value);
		}
		return Value;
	}

	TSharedPtr<FJsonObject> ResultOf(const TSharedPtr<FJsonObject>& Response)
	{
		const TSharedPtr<FJsonObject>* Result = nullptr;
		if (Response.IsValid() && Response->TryGetObjectField(TEXT("result"), Result) && Result)
		{
			return *Result;
		}
		return MakeShared<FJsonObject>();
	}

	TSharedPtr<FJsonObject> AssetParams(const FString& AssetPath)
	{
		TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
		Params->SetStringField(TEXT("asset_path"), AssetPath);
		return Params;
	}

	/**
	 * Opens the fixture's editor. Returns null when the subsystem refuses
	 * (headless -nullrhi is allowed to), which callers report as a skip.
	 */
	IAssetEditorInstance* OpenFixtureEditor(const FFixtureAsset& Fixture)
	{
		if (!GEditor || !Fixture.Blueprint)
		{
			return nullptr;
		}
		UAssetEditorSubsystem* Subsystem = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
		if (!Subsystem)
		{
			return nullptr;
		}
		Subsystem->OpenEditorForAsset(Fixture.Blueprint);
		return Subsystem->FindEditorForAsset(Fixture.Blueprint, /*bFocusIfOpen*/ false);
	}
}

// =====================================================================================
// Unconditional: an unresolvable asset path, and a missing one, never reach the
// renderer gate. This is the test that pins the validation order — if the gate
// moved first, both of these would come back CAPTURE_UNSUPPORTED under -nullrhi.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureAssetNotFoundTest,
	"UEMCP.AssetEditorCapture.AssetNotFound",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureAssetNotFoundTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	const FString Missing = TEXT("/Game/__UEMCPTests/BP_DoesNotExist");
	TestEqual(TEXT("capture_asset_editor on an unloadable path"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Missing))), FString(TEXT("ASSET_NOT_FOUND")));
	TestEqual(TEXT("list_asset_editor_tabs on an unloadable path"),
		CodeOf(Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Missing))), FString(TEXT("ASSET_NOT_FOUND")));

	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	TestEqual(TEXT("capture_asset_editor with no asset_path"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), Empty)), FString(TEXT("MISSING_PARAMS")));
	TestEqual(TEXT("list_asset_editor_tabs with no asset_path"),
		CodeOf(Dispatch(TEXT("list_asset_editor_tabs"), Empty)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> BlankPath = AssetParams(TEXT(""));
	TestEqual(TEXT("capture_asset_editor with an empty asset_path"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), BlankPath)), FString(TEXT("MISSING_PARAMS")));
	return true;
}

// =====================================================================================
// Unconditional: a real, loadable asset with no editor open. Separates
// "cannot find the asset" from "found it, nobody is editing it".
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureEditorNotOpenTest,
	"UEMCP.AssetEditorCapture.EditorNotOpen",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureEditorNotOpenTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}

	TestEqual(TEXT("list_asset_editor_tabs with no editor open"),
		CodeOf(Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("EDITOR_NOT_OPEN")));
	TestEqual(TEXT("capture_asset_editor with no editor open"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("EDITOR_NOT_OPEN")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Editor-dependent: tab listing and an unknown tab id.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureOpenEditorTabsTest,
	"UEMCP.AssetEditorCapture.OpenEditorTabs",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureOpenEditorTabsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	if (!OpenFixtureEditor(Fixture))
	{
		AddInfo(TEXT("skipped: UAssetEditorSubsystem declined to open an asset editor in this configuration"));
		DestroyFixtureAsset(Fixture);
		return true;
	}

	const TSharedPtr<FJsonObject> Listed = Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Fixture.PackagePath));
	TestEqual(TEXT("list_asset_editor_tabs succeeds for an open editor"),
		CodeOf(Listed), FString(TEXT("SUCCESS")));
	const TSharedPtr<FJsonObject> Result = ResultOf(Listed);
	TestTrue(TEXT("editor_class is reported"), !StringFieldOr(Result, TEXT("editor_class")).IsEmpty());
	const TArray<TSharedPtr<FJsonValue>>* Tabs = nullptr;
	TestTrue(TEXT("tabs array is present"), Result->TryGetArrayField(TEXT("tabs"), Tabs));

	TSharedPtr<FJsonObject> BadTab = AssetParams(Fixture.PackagePath);
	BadTab->SetStringField(TEXT("tab_id"), TEXT("NoSuchTabId"));
	TestEqual(TEXT("capture_asset_editor with an unknown tab_id"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), BadTab)), FString(TEXT("TAB_NOT_FOUND")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Editor-dependent: the renderer gate. Under -nullrhi TakeScreenshot returns an
// empty buffer instead of failing, so the handler must refuse rather than write
// a blank PNG. With a renderer this assertion does not apply and is skipped.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureUnsupportedTest,
	"UEMCP.AssetEditorCapture.CaptureUnsupportedHeadless",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureUnsupportedTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	if (FApp::CanEverRender())
	{
		AddInfo(TEXT("skipped: a renderer is present, so CAPTURE_UNSUPPORTED is not the expected outcome"));
		return true;
	}
	TestFalse(TEXT("CanCaptureSlate is false without a renderer"), UEMCP::CanCaptureSlate());

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	if (!OpenFixtureEditor(Fixture))
	{
		AddInfo(TEXT("skipped: UAssetEditorSubsystem declined to open an asset editor in this configuration"));
		DestroyFixtureAsset(Fixture);
		return true;
	}

	TestEqual(TEXT("capture_asset_editor refuses without a renderer"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("CAPTURE_UNSUPPORTED")));

	DestroyFixtureAsset(Fixture);
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
```

- [ ] **Step 6: Deploy and run the native suite**

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `Native tests: 26 passed, 0 failed, 0 not run`, with `PASS UEMCP.AssetEditorCapture.AssetNotFound`, `.EditorNotOpen`, `.OpenEditorTabs` and `.CaptureUnsupportedHeadless`. The count is the proof the tests registered; a name typo leaves it at 22 and still exits 0.

Read the log for the two `AddInfo` lines. If `OpenEditorTabs` skipped, say so in the task report — it means `UAssetEditorSubsystem` declined headless and the live smoke in Task 5 carries that coverage instead.

If `AssetNotFound` reports `CAPTURE_UNSUPPORTED` instead of `ASSET_NOT_FOUND`, the validation order has been inverted somewhere in `HandleCaptureAssetEditor`; fix the handler, not the test.

- [ ] **Step 7: Prove the assertions bind (deliberate falsification)**

Temporarily change one assertion in `FUEMCPAssetEditorCaptureEditorNotOpenTest` to a value that must be wrong:

```cpp
	TestEqual(TEXT("capture_asset_editor with no editor open"),
		CodeOf(Dispatch(TEXT("capture_asset_editor"), AssetParams(Fixture.PackagePath))),
		FString(TEXT("ASSET_NOT_FOUND")));
```

Then rebuild and re-run:

```bash
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `FAIL UEMCP.AssetEditorCapture.EditorNotOpen` with an `Expected 'EDITOR_NOT_OPEN' to equal 'ASSET_NOT_FOUND'`-shaped message, and `Native tests: 25 passed, 1 failed, 0 not run`. **Restore `EDITOR_NOT_OPEN`**, rebuild, and confirm `26 passed, 0 failed, 0 not run` before committing. This also confirms the fixture really does resolve — a fixture that failed to register would give `ASSET_NOT_FOUND` and make the broken version pass.

- [ ] **Step 8: Add the plugin-source assertions**

Append to `server/test-visual-capture-source.mjs`, before the final `process.exit(t.summary())`:

```js
// ── EN-24: asset-editor capture handler source ────────────────
const captureHeader = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Public', 'AssetEditorCapture.h'), 'utf8');
const captureHelpers = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'AssetEditorCapture.cpp'), 'utf8');
const captureHandlers = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'AssetEditorCaptureHandler.cpp'), 'utf8');
const commandRegistry = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'MCPCommandRegistry.cpp'), 'utf8');

t.assert(captureHeader.includes('void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry);'),
  'AssetEditorCapture.h declares the registration entry point');
t.assert(captureHandlers.includes('Registry.Register(TEXT("list_asset_editor_tabs")'),
  'asset-editor capture registers list_asset_editor_tabs');
t.assert(captureHandlers.includes('Registry.Register(TEXT("capture_asset_editor")'),
  'asset-editor capture registers capture_asset_editor');
t.assert(commandRegistry.includes('#include "AssetEditorCapture.h"') &&
  commandRegistry.includes('RegisterAssetEditorCaptureHandlers(*this);'),
  'the command registry wires the asset-editor capture family');
t.assert(captureHelpers.includes('FindEditorForAsset(Target.Asset, /*bFocusIfOpen*/ false)'),
  'editor lookup never steals focus');
t.assert(captureHelpers.includes('FindExistingLiveTab') && !captureHelpers.includes('TryInvokeTab'),
  'tabs are resolved, never opened');

// Validation order is load-bearing: under -nullrhi every capture ends in
// CAPTURE_UNSUPPORTED, so gating on the renderer before addressing would make
// ASSET_NOT_FOUND / EDITOR_NOT_OPEN / TAB_NOT_FOUND unreachable headless.
const captureBody = captureHandlers.slice(captureHandlers.indexOf('void HandleCaptureAssetEditor'));
t.assert(captureBody.indexOf('ResolveCaptureTab') < captureBody.indexOf('CaptureWidgetToPng'),
  'capture_asset_editor resolves the tab before it reaches the renderer gate');

t.assert(captureHelpers.includes('FSlateApplication::Get().TakeScreenshot('),
  'asset-editor capture reads pixels through FSlateApplication::TakeScreenshot');
t.assert(captureHelpers.includes('FApp::CanEverRender()'),
  'the renderer gate is FApp::CanEverRender, which is false under -nullrhi');
t.assert(captureHeader.includes('InlineBase64MaxBytes = 8 * 1024 * 1024') &&
  captureHelpers.includes('inline_omitted'),
  'the 8 MiB inline cap is declared and enforced');
```

Note the ninth and tenth assertions are one `t.assert` each; the block adds **10**.

- [ ] **Step 9: Guards and rotation**

```bash
cd server
node test-anon-namespace-audit.mjs
node test-visual-capture-source.mjs
node test-tool-registry-truth.mjs
node run-rotation.mjs
node verify-deploy.mjs --quiet --no-color --profile smoke
```

Expected: 0 anonymous-namespace collisions; `Aggregate: 7639 passed / 0 failed / 7639 total` across 79 files; `SYNC`. `test-tool-registry-truth.mjs` matters here for the other direction — both new plugin commands must now be covered by the Node wrappers Task 1 added.

- [ ] **Step 10: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp plugin/UEMCP/Source/UEMCP/Private/MCPCommandRegistry.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp server/test-visual-capture-source.mjs
git commit -F - <<'MSG'
Capture an open asset editor by asset path, and list its tabs

list_asset_editor_tabs and capture_asset_editor on tcp-55558. The toolkit is
resolved with UAssetEditorSubsystem::FindEditorForAsset(asset, false) and its
tabs through FTabManager::CollectSpawners + FindExistingLiveTab, so nothing is
opened, focused or reordered. Pixels come from
FSlateApplication::TakeScreenshot on the tab's content widget and go through
the same FImageUtils PNG path the viewport screenshot uses. The file is always
written under Saved/UEMCP/Captures; inline base64 is opt-in and drops to
inline_omitted="too_large" above 8 MiB.

Validation order is deliberate: asset, editor and tab are resolved before the
renderer gate, so ASSET_NOT_FOUND, EDITOR_NOT_OPEN and TAB_NOT_FOUND stay
reachable under -nullrhi instead of all collapsing into CAPTURE_UNSUPPORTED.
Four native tests cover them; two need an open editor and record a labelled
skip if the subsystem declines headless.

get_viewport_screenshot is untouched.

Native tests 22 -> 26. Rotation 7629 -> 7639.
MSG
```

---

### Task 3: Plugin — details paging and PIE capture

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h` (append two declarations)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp` (append two bodies, one include)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp` (append four functions, three `Register` calls)
- Modify: `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs` (`PropertyEditor` private dependency)
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp` (append three tests)
- Modify: `server/test-visual-capture-source.mjs`

**Interfaces:**
- Consumes from Task 2, all in `namespace UEMCP`, declared in `Public/AssetEditorCapture.h`: `FAssetEditorTarget`, `ResolveAssetEditorTarget(const FString&)`, `FindDescendantByType(const TSharedPtr<SWidget>&, FName)`, `CanCaptureSlate()`, `FinishCapture(const TArray64<uint8>&, const FIntPoint&, const FString&, const FString&, bool, const TSharedPtr<FJsonObject>&, FString&)`, `InlineBase64MaxBytes`. From the test file, in `namespace UEMCP::AssetEditorCapture::Tests`: `FFixtureAsset`, `CreateFixtureAsset()`, `DestroyFixtureAsset(FFixtureAsset&)`, `Dispatch(const FString&, const TSharedPtr<FJsonObject>&)`, `CodeOf(const TSharedPtr<FJsonObject>&)`, `ResultOf(const TSharedPtr<FJsonObject>&)`, `StringFieldOr(const TSharedPtr<FJsonObject>&, const FString&)`, `AssetParams(const FString&)`, `OpenFixtureEditor(const FFixtureAsset&)`.
- Produces, in `namespace UEMCP`:
  - `IDetailsView* FindDetailsViewInTab(const TSharedPtr<SDockTab>& Tab)`
  - `bool ResolveDetailsView(const FString& AssetPath, const FString& TabId, IDetailsView*& OutView, FString& OutErrorCode, FString& OutErrorMessage)`

- [ ] **Step 1: Add the `PropertyEditor` module dependency**

In `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`, inside `PrivateDependencyModuleNames.AddRange`, after the `"LevelEditor",` line:

```csharp
			"PropertyEditor", // IDetailsView for the details_panel_* handlers (EN-24). Engine module, not a plugin — no UEMCP.uplugin Plugins[] entry (D110).
```

- [ ] **Step 2: Declare the two details helpers**

In `plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h`, add to the forward declarations near the top, next to `class IAssetEditorInstance;`:

```cpp
class IDetailsView;
```

and append inside `namespace UEMCP`, after the `FinishCapture` declaration and before `RegisterAssetEditorCaptureHandlers`:

```cpp
	/**
	 * The IDetailsView inside a tab, or null.
	 *
	 * Matched by EXACT widget type name. FPropertyEditorModule::CreateDetailView
	 * builds the widget with SNew(SDetailsView, Args) and SNew stamps the
	 * stringized type onto SWidget::TypeOfWidget, so "SDetailsView" identifies
	 * precisely the class that derives from SDetailsViewBase : IDetailsView and
	 * the downcast is sound. A substring match would also hit SActorDetails,
	 * SStructureDetailsView and SSingleProperty, none of which is an
	 * IDetailsView — the cast would then be undefined. A miss returns null,
	 * which the caller reports as NOT_A_DETAILS_PANEL.
	 */
	IDetailsView* FindDetailsViewInTab(const TSharedPtr<SDockTab>& Tab);

	/**
	 * asset_path + tab_id -> IDetailsView, with the error code the handler
	 * should emit: ASSET_NOT_FOUND, EDITOR_NOT_OPEN, TAB_NOT_FOUND or
	 * NOT_A_DETAILS_PANEL.
	 */
	bool ResolveDetailsView(
		const FString& AssetPath,
		const FString& TabId,
		IDetailsView*& OutView,
		FString& OutErrorCode,
		FString& OutErrorMessage);
```

- [ ] **Step 3: Write the two helper bodies**

In `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp`, add to the include block:

```cpp
#include "IDetailsView.h"
```

and append inside `namespace UEMCP`, at the end of the file before the namespace's closing brace:

```cpp
	IDetailsView* FindDetailsViewInTab(const TSharedPtr<SDockTab>& Tab)
	{
		if (!Tab.IsValid())
		{
			return nullptr;
		}
		const TSharedPtr<SWidget> Found = FindDescendantByType(Tab->GetContent(), TEXT("SDetailsView"));
		return Found.IsValid() ? static_cast<IDetailsView*>(Found.Get()) : nullptr;
	}

	bool ResolveDetailsView(
		const FString& AssetPath,
		const FString& TabId,
		IDetailsView*& OutView,
		FString& OutErrorCode,
		FString& OutErrorMessage)
	{
		OutView = nullptr;
		const FAssetEditorTarget Target = ResolveAssetEditorTarget(AssetPath);
		if (!Target.ErrorCode.IsEmpty())
		{
			OutErrorCode = Target.ErrorCode;
			OutErrorMessage = Target.ErrorMessage;
			return false;
		}
		const TSharedPtr<SDockTab> Tab = Target.TabManager.IsValid()
			? Target.TabManager->FindExistingLiveTab(FTabId(FName(*TabId)))
			: nullptr;
		if (!Tab.IsValid())
		{
			OutErrorCode = TEXT("TAB_NOT_FOUND");
			OutErrorMessage = FString::Printf(
				TEXT("No live tab '%s' in the editor for '%s'"), *TabId, *AssetPath);
			return false;
		}
		OutView = FindDetailsViewInTab(Tab);
		if (!OutView)
		{
			OutErrorCode = TEXT("NOT_A_DETAILS_PANEL");
			OutErrorMessage = FString::Printf(TEXT("Tab '%s' contains no SDetailsView"), *TabId);
			return false;
		}
		return true;
	}
```

- [ ] **Step 4: Write the three handlers**

In `plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp`, add to the include block:

```cpp
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "IDetailsView.h"
#include "ImageUtils.h"
#include "Misc/App.h"
#include "PropertyPath.h"
#include "UnrealClient.h"
```

and append inside the anonymous namespace, after `HandleCaptureAssetEditor`:

```cpp
		/** Reads asset_path + tab_id, or emits MISSING_PARAMS. */
		bool ReadDetailsParams(
			const TCHAR* ToolName,
			const TSharedPtr<FJsonObject>& Params,
			FString& OutAssetPath,
			FString& OutTabId,
			TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid()
				|| !Params->TryGetStringField(TEXT("asset_path"), OutAssetPath) || OutAssetPath.IsEmpty()
				|| !Params->TryGetStringField(TEXT("tab_id"), OutTabId) || OutTabId.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("%s requires non-empty asset_path and tab_id"), ToolName),
					TEXT("MISSING_PARAMS"));
				return false;
			}
			return true;
		}

		void HandleDetailsPanelExpandAll(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			FString TabId;
			if (!ReadDetailsParams(TEXT("details_panel_expand_all"), Params, AssetPath, TabId, OutResponse))
			{
				return;
			}
			IDetailsView* View = nullptr;
			FString ErrorCode;
			FString ErrorMessage;
			if (!ResolveDetailsView(AssetPath, TabId, View, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode);
				return;
			}

			const int32 RowsBefore = View->CountRows();
			// UE 5.6 exposes no public expand-all: SetRootExpansionStates is
			// declared in Editor/PropertyEditor/Private/SDetailsViewBase.h and
			// is not on IDetailsView. ShowAllAdvancedProperties clears the
			// advanced filter, and ScrollPropertyIntoView(Path, true) expands
			// the node and every ancestor (SDetailsViewBase.cpp), so walking
			// the displayed paths reaches the same end state publicly.
			// Advanced rows land on the next editor tick, which the caller's
			// next command is already past.
			View->ShowAllAdvancedProperties();
			View->ForceRefresh();
			for (const FPropertyPath& Path : View->GetPropertiesInOrderDisplayed())
			{
				View->ScrollPropertyIntoView(Path, /*bExpandProperty*/ true);
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("expanded"), true);
			Result->SetNumberField(TEXT("rows_before"), RowsBefore);
			Result->SetNumberField(TEXT("rows_after"), View->CountRows());
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleDetailsPanelScroll(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			FString TabId;
			if (!ReadDetailsParams(TEXT("details_panel_scroll"), Params, AssetPath, TabId, OutResponse))
			{
				return;
			}
			int32 RowOffset = 0;
			if (!Params->TryGetNumberField(TEXT("row_offset"), RowOffset) || RowOffset < 0)
			{
				BuildErrorResponse(OutResponse,
					TEXT("details_panel_scroll requires a non-negative row_offset"), TEXT("MISSING_PARAMS"));
				return;
			}
			IDetailsView* View = nullptr;
			FString ErrorCode;
			FString ErrorMessage;
			if (!ResolveDetailsView(AssetPath, TabId, View, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode);
				return;
			}

			// IDetailsView has no pixel scroll on 5.6: GetScrollWidget returns
			// the details view itself, not the row tree, and SDetailTree is a
			// private type. Rows are addressed instead — GetPropertyRowNumbers
			// maps row number to property path, and one ScrollPropertyIntoView
			// brings the first row at or after the offset into view. That also
			// makes row_offset stable across DPI and panel size.
			const int32 MaxRowOffset = FMath::Max(0, View->CountRows() - 1);
			const int32 Clamped = FMath::Clamp(RowOffset, 0, MaxRowOffset);
			int32 Landed = INDEX_NONE;
			const FPropertyPath* LandedPath = nullptr;
			for (const TPair<int32, FPropertyPath>& Row : View->GetPropertyRowNumbers())
			{
				if (Row.Key >= Clamped && (Landed == INDEX_NONE || Row.Key < Landed))
				{
					Landed = Row.Key;
					LandedPath = &Row.Value;
				}
			}
			if (LandedPath)
			{
				View->ScrollPropertyIntoView(*LandedPath, /*bExpandProperty*/ false);
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetNumberField(TEXT("row_offset"), Landed == INDEX_NONE ? Clamped : Landed);
			Result->SetNumberField(TEXT("requested_row_offset"), RowOffset);
			Result->SetNumberField(TEXT("max_row_offset"), MaxRowOffset);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleCapturePieViewport(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			// PIE state is checked before the renderer gate for the same reason
			// the asset-editor path resolves addressing first: PIE_NOT_RUNNING
			// must stay reachable under -nullrhi.
			if (!GEditor || !GEditor->PlayWorld)
			{
				BuildErrorResponse(OutResponse, TEXT("No PIE session is running"), TEXT("PIE_NOT_RUNNING"));
				return;
			}
			FViewport* Viewport = (GEngine && GEngine->GameViewport) ? GEngine->GameViewport->Viewport : nullptr;
			if (!Viewport)
			{
				BuildErrorResponse(OutResponse,
					TEXT("PIE is running but has no game viewport"), TEXT("PIE_NOT_RUNNING"));
				return;
			}
			if (!FApp::CanEverRender())
			{
				BuildErrorResponse(OutResponse,
					TEXT("No renderer is available (headless or -nullrhi)"), TEXT("CAPTURE_UNSUPPORTED"));
				return;
			}

			const FIntPoint Size = Viewport->GetSizeXY();
			TArray<FColor> Bitmap;
			if (Size.X <= 0 || Size.Y <= 0
				|| !Viewport->ReadPixels(Bitmap, FReadSurfaceDataFlags(), FIntRect(0, 0, Size.X, Size.Y))
				|| Bitmap.Num() < Size.X * Size.Y)
			{
				BuildErrorResponse(OutResponse, TEXT("PIE viewport ReadPixels failed"), TEXT("CAPTURE_FAILED"));
				return;
			}
			TArray64<uint8> Png;
			const FImageView View(Bitmap.GetData(), Size.X, Size.Y);
			FImageUtils::CompressImage(Png, TEXT("png"), View, 0);
			if (Png.Num() == 0)
			{
				BuildErrorResponse(OutResponse,
					TEXT("PNG compression produced an empty buffer"), TEXT("CAPTURE_FAILED"));
				return;
			}

			bool bInline = false;
			FString RequestedPath;
			if (Params.IsValid())
			{
				Params->TryGetBoolField(TEXT("inline"), bInline);
				Params->TryGetStringField(TEXT("out_png"), RequestedPath);
			}
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			FString ErrorMessage;
			if (!FinishCapture(Png, Size, RequestedPath, TEXT("PIE"), bInline, Result, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, TEXT("FILE_WRITE_FAILED"));
				return;
			}
			BuildSuccessResponse(OutResponse, Result);
		}
```

Then extend `RegisterAssetEditorCaptureHandlers` so it reads:

```cpp
	void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("list_asset_editor_tabs"), &HandleListAssetEditorTabs);
		Registry.Register(TEXT("capture_asset_editor"), &HandleCaptureAssetEditor);
		Registry.Register(TEXT("details_panel_expand_all"), &HandleDetailsPanelExpandAll);
		Registry.Register(TEXT("details_panel_scroll"), &HandleDetailsPanelScroll);
		Registry.Register(TEXT("capture_pie_viewport"), &HandleCapturePieViewport);
	}
```

- [ ] **Step 5: Write the three native tests**

Append to `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp`, after `FUEMCPAssetEditorCaptureUnsupportedTest::RunTest` and before `#endif // WITH_DEV_AUTOMATION_TESTS`:

```cpp
// =====================================================================================
// Unconditional: PIE is not running in a headless automation pass, so the
// refusal is the assertion. GEditor->PlayWorld is checked before the renderer
// gate, which is why this reports PIE_NOT_RUNNING rather than
// CAPTURE_UNSUPPORTED under -nullrhi.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCapturePieNotRunningTest,
	"UEMCP.AssetEditorCapture.PieNotRunning",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCapturePieNotRunningTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	if (GEditor && GEditor->PlayWorld)
	{
		AddInfo(TEXT("skipped: a PIE session is active, so PIE_NOT_RUNNING is not the expected outcome"));
		return true;
	}
	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	TestEqual(TEXT("capture_pie_viewport with no PIE session"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), Empty)), FString(TEXT("PIE_NOT_RUNNING")));
	// Null params is a legal wire shape for a parameter-less command; the
	// handler must reach the same refusal rather than dereferencing them.
	TestEqual(TEXT("capture_pie_viewport tolerates null params"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), nullptr)), FString(TEXT("PIE_NOT_RUNNING")));
	return true;
}

// =====================================================================================
// Unconditional: the details handlers' parameter and resolution errors, none of
// which needs an open editor.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureDetailsParamsTest,
	"UEMCP.AssetEditorCapture.DetailsPanelParams",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureDetailsParamsTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
	TestEqual(TEXT("details_panel_expand_all with no params"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), Empty)), FString(TEXT("MISSING_PARAMS")));
	TestEqual(TEXT("details_panel_scroll with no params"),
		CodeOf(Dispatch(TEXT("details_panel_scroll"), Empty)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> NoTab = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	TestEqual(TEXT("details_panel_expand_all with no tab_id"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), NoTab)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> NegativeOffset = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	NegativeOffset->SetStringField(TEXT("tab_id"), TEXT("Details"));
	NegativeOffset->SetNumberField(TEXT("row_offset"), -1);
	TestEqual(TEXT("details_panel_scroll with a negative row_offset"),
		CodeOf(Dispatch(TEXT("details_panel_scroll"), NegativeOffset)), FString(TEXT("MISSING_PARAMS")));

	TSharedPtr<FJsonObject> MissingAsset = AssetParams(TEXT("/Game/__UEMCPTests/BP_DoesNotExist"));
	MissingAsset->SetStringField(TEXT("tab_id"), TEXT("Details"));
	TestEqual(TEXT("details_panel_expand_all on an unloadable path"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), MissingAsset)), FString(TEXT("ASSET_NOT_FOUND")));

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	TSharedPtr<FJsonObject> ClosedEditor = AssetParams(Fixture.PackagePath);
	ClosedEditor->SetStringField(TEXT("tab_id"), TEXT("Details"));
	TestEqual(TEXT("details_panel_expand_all with no editor open"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), ClosedEditor)), FString(TEXT("EDITOR_NOT_OPEN")));

	DestroyFixtureAsset(Fixture);
	return true;
}

// =====================================================================================
// Editor-dependent: an unknown tab id, and a live tab that holds no details view.
// =====================================================================================
IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPAssetEditorCaptureDetailsTabTest,
	"UEMCP.AssetEditorCapture.DetailsPanelTab",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPAssetEditorCaptureDetailsTabTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::AssetEditorCapture::Tests;

	FFixtureAsset Fixture = CreateFixtureAsset();
	if (!Fixture.Blueprint)
	{
		AddError(TEXT("could not create the fixture Blueprint"));
		return false;
	}
	if (!OpenFixtureEditor(Fixture))
	{
		AddInfo(TEXT("skipped: UAssetEditorSubsystem declined to open an asset editor in this configuration"));
		DestroyFixtureAsset(Fixture);
		return true;
	}

	TSharedPtr<FJsonObject> BadTab = AssetParams(Fixture.PackagePath);
	BadTab->SetStringField(TEXT("tab_id"), TEXT("NoSuchTabId"));
	TestEqual(TEXT("details_panel_expand_all with an unknown tab_id"),
		CodeOf(Dispatch(TEXT("details_panel_expand_all"), BadTab)), FString(TEXT("TAB_NOT_FOUND")));

	// A tab that exists but holds no SDetailsView must say so rather than
	// reporting success on nothing. Which tabs a Blueprint editor exposes is
	// not guaranteed, so a tab without a details view is searched for and its
	// absence is a skip, not a failure.
	const TSharedPtr<FJsonObject> Listed = ResultOf(
		Dispatch(TEXT("list_asset_editor_tabs"), AssetParams(Fixture.PackagePath)));
	const TArray<TSharedPtr<FJsonValue>>* Tabs = nullptr;
	FString NonDetailsTabId;
	if (Listed->TryGetArrayField(TEXT("tabs"), Tabs) && Tabs)
	{
		for (const TSharedPtr<FJsonValue>& Entry : *Tabs)
		{
			const TSharedPtr<FJsonObject>* Obj = nullptr;
			if (!Entry.IsValid() || !Entry->TryGetObject(Obj) || !Obj)
			{
				continue;
			}
			const FString CandidateId = StringFieldOr(*Obj, TEXT("tab_id"));
			TSharedPtr<FJsonObject> Probe = AssetParams(Fixture.PackagePath);
			Probe->SetStringField(TEXT("tab_id"), CandidateId);
			if (CodeOf(Dispatch(TEXT("details_panel_expand_all"), Probe)) == TEXT("NOT_A_DETAILS_PANEL"))
			{
				NonDetailsTabId = CandidateId;
				break;
			}
		}
	}
	if (NonDetailsTabId.IsEmpty())
	{
		AddInfo(TEXT("skipped: this editor exposes no live tab without a details view"));
	}
	else
	{
		TSharedPtr<FJsonObject> Scroll = AssetParams(Fixture.PackagePath);
		Scroll->SetStringField(TEXT("tab_id"), NonDetailsTabId);
		Scroll->SetNumberField(TEXT("row_offset"), 0);
		TestEqual(TEXT("details_panel_scroll on a tab with no details view"),
			CodeOf(Dispatch(TEXT("details_panel_scroll"), Scroll)), FString(TEXT("NOT_A_DETAILS_PANEL")));
	}

	DestroyFixtureAsset(Fixture);
	return true;
}
```

- [ ] **Step 6: Deploy and run the native suite**

```bash
sync-plugin.bat path/to/YourProject.uproject -y
"<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat" <YourProject>Editor Win64 Development -project=path/to/YourProject.uproject -WaitMutex -FromMsBuild
run-native-tests.bat --profile smoke
```

Expected: `Native tests: 29 passed, 0 failed, 0 not run`, with `PASS UEMCP.AssetEditorCapture.PieNotRunning`, `.DetailsPanelParams` and `.DetailsPanelTab`.

If the build fails on `IDetailsView.h`, the `PropertyEditor` dependency in Step 1 did not take — check it landed inside `PrivateDependencyModuleNames.AddRange` and not in a comment.

- [ ] **Step 7: Prove the assertions bind (deliberate falsification)**

Temporarily change one assertion in `FUEMCPAssetEditorCapturePieNotRunningTest`:

```cpp
	TestEqual(TEXT("capture_pie_viewport with no PIE session"),
		CodeOf(Dispatch(TEXT("capture_pie_viewport"), Empty)), FString(TEXT("CAPTURE_UNSUPPORTED")));
```

Rebuild and re-run. Expected: `FAIL UEMCP.AssetEditorCapture.PieNotRunning` and `Native tests: 28 passed, 1 failed, 0 not run`. **Restore `PIE_NOT_RUNNING`**, rebuild, and confirm `29 passed, 0 failed, 0 not run` before committing. This one is worth doing specifically: it proves the PIE check precedes the renderer gate, which is the ordering the test exists to protect.

- [ ] **Step 8: Add the plugin-source assertions**

Append to `server/test-visual-capture-source.mjs`, before the final `process.exit(t.summary())`. It reuses the `captureHelpers` and `captureHandlers` constants declared by Task 2's block:

```js
// ── EN-24/EN-25: details paging and PIE capture source ────────
const buildCs = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'UEMCP.Build.cs'), 'utf8');

t.assert(captureHandlers.includes('Registry.Register(TEXT("details_panel_expand_all")'),
  'asset-editor capture registers details_panel_expand_all');
t.assert(captureHandlers.includes('Registry.Register(TEXT("details_panel_scroll")'),
  'asset-editor capture registers details_panel_scroll');
t.assert(captureHandlers.includes('Registry.Register(TEXT("capture_pie_viewport")'),
  'asset-editor capture registers capture_pie_viewport');

// Exact type-name match only: SActorDetails, SStructureDetailsView and
// SSingleProperty all read as details-ish and none is an IDetailsView, so a
// substring match would make the downcast undefined.
t.assert(captureHelpers.includes('FindDescendantByType(Tab->GetContent(), TEXT("SDetailsView"))'),
  'the details view is found by exact widget type name');

// SetRootExpansionStates is private on 5.6 (Editor/PropertyEditor/Private).
t.assert(captureHandlers.includes('ShowAllAdvancedProperties()') &&
  captureHandlers.includes('ScrollPropertyIntoView(Path, /*bExpandProperty*/ true)'),
  'expand-all goes through the public IDetailsView interface');
// Matched as a call through the view pointer, not as a bare name: the handler's
// comment explains why the private API is avoided and names it to do so.
t.assert(!captureHandlers.includes('View->SetRootExpansionStates'),
  'no call into the private SDetailsViewBase expansion API');
t.assert(captureHandlers.includes('GetPropertyRowNumbers()') &&
  !captureHandlers.includes('SetScrollOffset'),
  'details paging scrolls by row, not by pixel offset');

const pieBody = captureHandlers.slice(captureHandlers.indexOf('void HandleCapturePieViewport'));
t.assert(pieBody.indexOf('GEditor->PlayWorld') < pieBody.indexOf('FApp::CanEverRender()') &&
  buildCs.includes('"PropertyEditor"'),
  'PIE state is checked before the renderer gate, and PropertyEditor is a module dependency');
```

The block adds **8** assertions.

- [ ] **Step 9: Guards and rotation**

```bash
cd server
node test-anon-namespace-audit.mjs
node test-visual-capture-source.mjs
node test-plugin-manifest.mjs
node run-rotation.mjs
node verify-deploy.mjs --quiet --no-color --profile smoke
```

Expected: 0 collisions; `Aggregate: 7647 passed / 0 failed / 7647 total` across 79 files; `SYNC`.

- [ ] **Step 10: Commit**

```bash
git add plugin/UEMCP/Source/UEMCP/Public/AssetEditorCapture.h plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp plugin/UEMCP/Source/UEMCP/Private/AssetEditorCaptureHandler.cpp plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp server/test-visual-capture-source.mjs
git commit -F - <<'MSG'
Page a Details panel and capture the PIE viewport

details_panel_expand_all, details_panel_scroll and capture_pie_viewport
complete the EN-24/EN-25 set.

The details handlers use the public IDetailsView interface only. UE 5.6
declares SetRootExpansionStates in Editor/PropertyEditor/Private, not on
IDetailsView, so expand-all is ShowAllAdvancedProperties plus
ScrollPropertyIntoView(path, bExpandProperty=true) over the displayed paths —
that call expands every ancestor as well, which is the same end state.
Scrolling is by row rather than pixel: GetScrollWidget returns the details
view itself, not the row tree, so GetPropertyRowNumbers and CountRows address
rows directly, and row_offset stays stable across DPI and panel size.

capture_pie_viewport reads GEngine->GameViewport->Viewport when
GEditor->PlayWorld is set, which covers PIE in its own window where
get_viewport_screenshot still returns the level editor. PIE state is checked
before the renderer gate so PIE_NOT_RUNNING stays reachable headless.

Adds the PropertyEditor engine module to the private dependencies; it is a
module, not a plugin, so the .uplugin needs no new entry.

Native tests 26 -> 29. Rotation 7639 -> 7647.
MSG
```

---

### Task 4: The editor-identity rule on `wait_for_editor` and `connection_info`

**Files:**
- Modify: `server/editor-readiness.mjs` (`FUTILE_PHASES`, `waitForEditorReady`, `createEditorProbe`, `readinessHint`)
- Modify: `server/create-uemcp-server.mjs` (the `wait_for_editor` and `connection_info` handlers)
- Modify: `server/project-tools.mjs` (`MANAGEMENT_OUTPUT_SHAPE`)
- Modify: `server/test-editor-readiness.mjs`
- Modify: `server/test-project-server-wire.mjs`

**Interfaces:**
- Consumes: nothing from Tasks 1-3. This task is independent of the plugin and could be done first; it is fourth so the capture work ships as one reviewable unit.
- Produces:
  - `createEditorProbe({ tcpFn, port, attachedUproject?, timeoutMs? })` — one new optional dependency; omitting it disables the check.
  - Probe result on a mismatch: `{ ok: false, phase: 'identity_mismatch', code: 'EDITOR_PROJECT_MISMATCH', editor: {project_name, world_path}, mismatch: {attached_uproject, editor_uproject}, error: null }`.
  - `waitForEditorReady` result gains `code` and `mismatch` on that path.
  - `connection_info` payload gains `identityMismatch: boolean` and, when true, `identityMismatchPaths: {attached, editor}`.

**Why this is the real gap.** `connection_info` with `force_reconnect: true` already catches the wrong editor: `refreshEditorReadinessForConnectionInfo` sends `get_editor_state` and feeds it to `ProjectContext.refreshEditorHandshake`, which compares `uproject_path` against the attached project and sets `editorIdentityState = 'mismatch'` with `EDITOR_PROJECT_MISMATCH`. `wait_for_editor` does not: `createEditorProbe` returns `ok: true` for **any** listener that answers `get_editor_state`. The plugin binds with `SetReuseAddr(true)` before `Listen()`, so a second editor shares port 55558 and the OS picks who replies — which means `wait_for_editor` can report `ready` for an editor that is not the attached project, and the next live tool mutates the wrong one.

- [ ] **Step 1: Write the failing probe and wait tests**

Append to `server/test-editor-readiness.mjs`, before the final `process.exit(t.summary())`:

```js
// ── EN-25: the listener is not necessarily OUR editor ────────────
// The plugin binds with SetReuseAddr(true), so a second editor shares port
// 55558 and the OS decides which one answers. A probe that treats "something
// replied" as readiness is how an agent ends up mutating the wrong project.
{
  const probe = createEditorProbe({
    tcpFn: async () => ({
      status: 'success',
      result: { project_name: 'Other', uproject_path: 'D:/Other/Other.uproject', world_path: '/Game/Maps/M' },
    }),
    port: 55558,
    attachedUproject: 'D:/Proj/Proj.uproject',
  });
  const res = await probe();
  t.assert(res.ok === false, 'a listener answering for another project is not ready');
  t.assert(res.phase === 'identity_mismatch', `names the phase (got ${res.phase})`);
  t.assert(res.code === 'EDITOR_PROJECT_MISMATCH',
    `reuses the existing mismatch code rather than minting a new one (got ${res.code})`);
  t.assert(res.mismatch?.attached_uproject === 'D:/Proj/Proj.uproject' &&
    res.mismatch?.editor_uproject === 'D:/Other/Other.uproject',
    'carries both paths so the caller can see which editor answered');
}

// Path comparison goes through normalizeComparisonPath, the same rule
// ProjectContext uses, so separators and case cannot manufacture a mismatch.
{
  const probe = createEditorProbe({
    tcpFn: async () => ({ status: 'success', result: { project_name: 'Proj', uproject_path: 'D:\\Proj\\Proj.uproject' } }),
    port: 55558,
    attachedUproject: 'D:/Proj/Proj.uproject',
  });
  const res = await probe();
  t.assert(res.ok === true, `the same project written with other separators is still ours (got phase ${res.phase})`);
}

// wait_for_editor runs before anything is attached, so a missing attached path
// disables the check instead of failing construction — unlike tcpFn and port,
// whose absence is a wiring bug.
{
  const probe = createEditorProbe({
    tcpFn: async () => ({ status: 'success', result: { project_name: 'Any', uproject_path: 'D:/Any/Any.uproject' } }),
    port: 55558,
  });
  const res = await probe();
  t.assert(res.ok === true, 'with no project attached there is no identity to contradict');
}

// Unknown identity is not wrong identity: an editor whose get_editor_state
// omits uproject_path is treated the way ProjectContext treats it, as
// EDITOR_IDENTITY_UNKNOWN rather than as a mismatch.
{
  const probe = createEditorProbe({
    tcpFn: async () => ({ status: 'success', result: { project_name: 'Proj' } }),
    port: 55558,
    attachedUproject: 'D:/Proj/Proj.uproject',
  });
  const res = await probe();
  t.assert(res.ok === true, 'an editor that reports no uproject_path is unknown, not wrong');
}

// A mismatch cannot resolve itself, so the wait must end on the first probe
// rather than spending the caller's budget discovering the same fact 15 times.
{
  const processes = [{ pid: 7, cmdLine: 'x', commandLineAvailable: true, uprojectPath: 'D:/Proj/Proj.uproject' }];
  let probes = 0;
  let slept = 0;
  const res = await waitForEditorReady({
    listProcesses: () => processes,
    attachedUproject: 'D:/Proj/Proj.uproject',
    probe: async () => {
      probes++;
      return {
        ok: false,
        phase: 'identity_mismatch',
        code: 'EDITOR_PROJECT_MISMATCH',
        mismatch: { attached_uproject: 'D:/Proj/Proj.uproject', editor_uproject: 'D:/Other/Other.uproject' },
      };
    },
    timeoutMs: 30000,
    sleep: async (ms) => { slept += ms; },
  });
  t.assert(res.ready === false, 'identity mismatch is not ready');
  t.assert(res.attempts === 1, `stops after the first probe (got ${res.attempts})`);
  t.assert(slept === 0, `spends no budget on a wait that cannot converge (slept ${slept})`);
  t.assert(res.mismatch?.editor_uproject === 'D:/Other/Other.uproject',
    'surfaces the foreign path through the wait, not just through the probe');
}

// The hint is what stops a caller re-polling a futile phase forever.
{
  const hint = readinessHint({ ready: false, phase: 'identity_mismatch' });
  t.assert(/different project|another project/i.test(hint),
    `identity_mismatch names the wrong editor (got: ${hint})`);
  t.assert(!/call .*again/i.test(hint),
    'identity_mismatch does NOT invite re-polling a futile wait');
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd server && node test-editor-readiness.mjs
```

Expected: FAIL on `a listener answering for another project is not ready` — the current probe returns `ok: true` for any answering listener.

- [ ] **Step 3: Implement the probe and wait changes**

In `server/editor-readiness.mjs`, add the error-code import next to the existing ones:

```js
import { PROJECT_ERROR_CODES } from './project-errors.mjs';
```

Extend the futile set (the comment above it already explains the concept; add the new member and one sentence):

```js
// Phases where waiting can never succeed. Returning immediately is the point:
// spending the budget to report "you never launched it" is the obvious
// failure of a naive implementation. identity_mismatch is futile for the same
// reason — a listener that belongs to another project will not become ours.
const FUTILE_PHASES = new Set(['no_editor_process', 'wrong_project', 'identity_mismatch']);
```

In `waitForEditorReady`, replace the body of the polling loop's not-ready tail so a futile probe result ends the wait:

```js
    phase = result?.phase || 'initializing';
    lastError = result?.error ?? null;
    // A futile phase reported by the probe (as opposed to by the process
    // scan) ends the wait now. Polling a listener that belongs to another
    // project cannot converge, and burning the budget on it buries the one
    // fact the caller needs.
    if (FUTILE_PHASES.has(phase)) {
      return {
        ready: false,
        phase,
        elapsed_ms: now() - started,
        attempts,
        editor: null,
        last_error: lastError,
        code: result?.code ?? null,
        mismatch: result?.mismatch ?? null,
      };
    }
    if (now() - started >= timeoutMs) break;
```

Change `createEditorProbe`'s signature and its success branch:

```js
export function createEditorProbe({ tcpFn, port, attachedUproject = null, timeoutMs = 3000 }) {
  // Fail loudly at construction. A missing transport otherwise throws inside
  // the probe, gets absorbed by the not-ready path, and reports "initializing"
  // indefinitely — a wiring bug wearing the costume of a slow editor.
  if (typeof tcpFn !== 'function') {
    throw new Error('createEditorProbe requires a tcpFn transport function');
  }
  if (!Number.isFinite(Number(port))) {
    throw new Error(`createEditorProbe requires a numeric port (got ${port})`);
  }
  // attachedUproject is deliberately NOT validated. wait_for_editor runs before
  // anything is attached, and an unattached session has no identity to compare
  // against, so a missing path means "do not check" rather than "misconfigured".
  const attachedTarget = attachedUproject ? normalizeComparisonPath(attachedUproject) : null;
  return async function probeEditor() {
    try {
      const state = await tcpFn(port, 'get_editor_state', {}, timeoutMs);
      const result = state?.result ?? null;
      if (result) {
        const editor = { project_name: result.project_name ?? null, world_path: result.world_path ?? null };
        const editorUproject = result.uproject_path || result.uprojectPath || null;
        // The plugin binds with SetReuseAddr, so a second editor can share the
        // port and the OS picks who replies. An answer is not proof it is ours.
        // A listener that reports no path is unknown, not wrong — the same
        // distinction ProjectContext.refreshEditorHandshake draws.
        if (attachedTarget && editorUproject && normalizeComparisonPath(editorUproject) !== attachedTarget) {
          return {
            ok: false,
            phase: 'identity_mismatch',
            code: PROJECT_ERROR_CODES.EDITOR_PROJECT_MISMATCH,
            editor,
            mismatch: { attached_uproject: attachedUproject, editor_uproject: editorUproject },
            error: null,
          };
        }
        return { ok: true, phase: 'ready', editor };
      }
      return { ok: false, phase: 'transport_ready', error: null };
    } catch (stateError) {
      // get_editor_state failed. Ping separates "listener not up yet" from
      // "listener up, world still resolving" so the caller can see progress.
      try {
        await tcpFn(port, 'ping', {}, timeoutMs);
        return { ok: false, phase: 'transport_ready', error: errorShape(stateError) };
      } catch (pingError) {
        return { ok: false, phase: 'initializing', error: errorShape(pingError) };
      }
    }
  };
}
```

Add the hint case in `readinessHint`, after the `wrong_project` case:

```js
    case 'identity_mismatch':
      return 'A listener answered on the UEMCP port, but it reports a different project than the attached one. Waiting cannot succeed — close that editor, or attach the project it already has open.';
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd server && node test-editor-readiness.mjs
```

Expected: PASS, 13 more assertions than before. The pre-existing assertions must all still pass — in particular `an editor with no map loaded is still ready`, which shares the success branch you just edited.

- [ ] **Step 5: Wire the attached path into `wait_for_editor` and add the `connection_info` fields**

In `server/create-uemcp-server.mjs`, in the `wait_for_editor` handler, hoist the attached path and pass it to the probe:

```js
    async ({ timeout_ms }) => {
      const timeoutMs = clampWaitTimeout(timeout_ms);
      const attachedUproject = projectContext.snapshot()?.identity?.uprojectPath || null;
      // tcpFn directly, never connectionManager.send(): send() serializes
      // through the per-layer queue, so waiting inside it would block every
      // other call on this layer for the whole budget.
      const probe = createEditorProbe({
        tcpFn: connectionManager.getTcpTransport(),
        port: connectionManager.config.tcpPortCustom,
        // EN-25: a listener that answers for another project is not readiness.
        attachedUproject,
      });
      const outcome = await waitForEditorReady({
        listProcesses: () => listEditorProcesses(),
        attachedUproject,
        probe,
        timeoutMs,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      return managementResult({
        ok: true,
        effective_timeout_ms: timeoutMs,
        ...outcome,
        hint: readinessHint(outcome),
      });
    }
```

In the `connection_info` handler, derive the flag from the state `refreshEditorHandshake` already sets and add the two fields:

```js
    async ({ force_reconnect }) => {
      const editor = await refreshEditorReadinessForConnectionInfo(force_reconnect);
      const deploy = await refreshDeployReadinessForConnectionInfo(force_reconnect);
      const projectSnapshot = projectContext.snapshot();
      // EN-25: the mismatch was already detected — refreshEditorHandshake sets
      // editorIdentityState when get_editor_state reports a foreign project.
      // It was only reachable by reading a nested readiness dimension; these
      // two fields put it where a caller will actually look.
      const identityMismatch = projectSnapshot.editorIdentityState === 'mismatch';
      return managementResult({
        ok: true,
        project: projectSnapshot.identity?.projectName || config.projectName || connectionManager.detectedProject || '(not detected)',
        projectRoot: connectionManager.resolvedProjectRoot || '(not set)',
        projectContext: projectSnapshot,
        targetAttachment: projectSnapshot.identity?.targetAttachment || null,
        identityMismatch,
        ...(identityMismatch ? {
          identityMismatchPaths: {
            attached: projectSnapshot.identity?.uprojectPath || null,
            editor: projectSnapshot.editorCandidates?.[0]?.uprojectPath || null,
          },
        } : {}),
        readiness: {
          attachment: projectSnapshot.attachmentState,
          editorIdentity: projectSnapshot.editorIdentityState,
          transportOwnership: projectSnapshot.transportOwnershipState,
          deployFreshness: projectSnapshot.deployFreshnessState,
        },
        editor,
        deploy,
        layers: connectionManager.getActiveStatus(),
        enabledToolsets: toolsetManager.getEnabledNames(),
        toolCount: toolIndex.size,
      });
    }
```

In `server/project-tools.mjs`, add the two keys to `MANAGEMENT_OUTPUT_SHAPE` so the declared output schema names them (the SDK tolerates extra keys today — `editor` and `deploy` are already undeclared — but a field the spec asks for should be declared):

```js
export const MANAGEMENT_OUTPUT_SHAPE = {
  ...PROJECT_CONTEXT_OUTPUT_SHAPE,
  ...PROJECT_ERROR_OUTPUT_SHAPE,
  ...TOOLSET_RESULT_OUTPUT_SHAPE,
  targets: z.any().optional(),
  query: z.string().optional(),
  resultCount: z.number().optional(),
  results: z.any().optional(),
  autoEnabled: z.array(z.string()).optional(),
  targetAttachment: z.any().optional(),
  // EN-25: connection_info's answer to "is the listener on 55558 actually the
  // project I am attached to?"
  identityMismatch: z.boolean().optional(),
  identityMismatchPaths: z.any().optional(),
};
```

- [ ] **Step 6: Write the wire test**

Append to `server/test-project-server-wire.mjs`, before the final `process.exit(t.summary())`:

```js
await runCase('connection_info reports an identity mismatch on the listener', async () => {
  const root = makeTempRoot();
  const projectRoot = makeTempRoot();
  const foreignRoot = makeTempRoot();
  try {
    const project = writeProject(join(projectRoot, 'AttachedProject'), 'AttachedProject');
    const foreign = writeProject(join(foreignRoot, 'ForeignProject'), 'ForeignProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      processInspector: () => [
        { pid: 4444, cmdLine: `UnrealEditor.exe "${project.uprojectPath}"`, commandLineAvailable: true, uprojectPath: project.uprojectPath },
      ],
      // The listener answers for a DIFFERENT project than the attached one —
      // the SetReuseAddr case where two editors share port 55558 and the OS
      // decides which one replies.
      tcpCommandFn: async () => ({
        status: 'success',
        result: { uproject_path: foreign.uprojectPath, project_name: 'ForeignProject' },
      }),
      httpCommandFn: async () => ({ status: 'success', result: {} }),
    });
    await initialize(transport, {});
    await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });

    const info = parseTextResult(await callTool(transport, 'connection_info', { force_reconnect: true }));
    t.assert(info.identityMismatch === true,
      `connection_info flags the mismatch (got ${info.identityMismatch})`);
    t.assert(info.readiness.editorIdentity === 'mismatch',
      `readiness reports mismatch (got ${info.readiness.editorIdentity})`);
    t.assert(String(info.identityMismatchPaths?.attached).includes('AttachedProject'),
      `reports the attached project path (got ${info.identityMismatchPaths?.attached})`);
    t.assert(String(info.identityMismatchPaths?.editor).includes('ForeignProject'),
      `reports the path the listener claimed (got ${info.identityMismatchPaths?.editor})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(projectRoot);
    cleanup(foreignRoot);
  }
});
```

- [ ] **Step 7: Run the affected suites, then the whole rotation**

```bash
cd server
node test-editor-readiness.mjs
node test-project-server-wire.mjs
node test-project-guard.mjs
node test-project-context.mjs
node test-tool-metadata.mjs
node run-rotation.mjs
```

Expected: every suite green, and `Aggregate: 7664 passed / 0 failed / 7664 total` across 79 files (+17 = 13 in `test-editor-readiness.mjs` + 4 in `test-project-server-wire.mjs`).

`test-project-guard.mjs` is listed because it asserts `EDITOR_IDENTITY_UNKNOWN` on the live-read guard path; a mistaken change to `refreshEditorHandshake` would surface there rather than in the two files you edited. If it fails, you changed `ProjectContext` — this task should not.

- [ ] **Step 8: Commit**

```bash
git add server/editor-readiness.mjs server/create-uemcp-server.mjs server/project-tools.mjs server/test-editor-readiness.mjs server/test-project-server-wire.mjs
git commit -F - <<'MSG'
Refuse to call a foreign editor ready on wait_for_editor

The plugin binds port 55558 with SetReuseAddr(true), so a second editor on the
same machine shares the port and the OS decides which one answers. The
readiness probe treated any answer to get_editor_state as readiness, so
wait_for_editor could report ready for an editor that is not the attached
project — and the next live tool would mutate the wrong one.

The probe now compares the listener's reported uproject_path against the
attached project through the same normalizeComparisonPath rule ProjectContext
uses, and returns phase=identity_mismatch with EDITOR_PROJECT_MISMATCH and both
paths. That phase is futile, so the wait ends on the first probe instead of
spending the caller's budget. An editor that reports no path stays unknown
rather than wrong, and an unattached session skips the check entirely.

connection_info already detected this through refreshEditorHandshake; it now
says so directly with identityMismatch and identityMismatchPaths instead of
only through a nested readiness dimension.

No new error code: EDITOR_PROJECT_MISMATCH already means exactly this.
No plugin change. The per-project port stays deferred.

Rotation 7647 -> 7664.
MSG
```

---

### Task 5: Live smoke, version lockstep, and the docs

**Files:**
- Create: `server/live-smoke-asset-editor-capture.mjs`
- Modify: `manifest.json`, `plugin/UEMCP/UEMCP.uplugin`, `server/test-plugin-manifest.mjs`
- Modify: `CLAUDE.md`
- Modify: `docs/tracking/backlog.md`
- Modify: `docs/tracking/risks-and-decisions.md`

**Interfaces:**
- Consumes: the five tools from Tasks 1-3 and the identity fields from Task 4. From `server/live-smoke-harness.mjs`: `prepareLiveSmoke({name})`, `createLiveSmokeCall({...})`, `unwrapLiveSmokeResponse(label, response)`, `stopPIEAndWaitForStopped({...})`, `sleep(ms)`. From `server/menhance-tcp-tools.mjs`: `executeMenhanceTool(name, args, connectionManager)`.
- Produces: nothing later depends on this task.

**The orchestrator runs the smoke, not the implementer.** Write the script, verify it parses and refuses cleanly with no opt-in, and commit. The plan states exactly what a successful GUI run prints so the orchestrator can tell success from a silent no-op.

- [ ] **Step 1: Write the live smoke script**

Create `server/live-smoke-asset-editor-capture.mjs`:

```js
// Opt-in live smoke for EN-24/EN-25 asset-editor, details-panel and PIE capture.
//
// This is the only proof of pixels. The native suite proves addressing and
// error handling; it runs under -nullrhi, where every capture is correctly
// refused as CAPTURE_UNSUPPORTED.
//
// Preconditions:
//   - Unreal Editor is open on the sample 5.6 target with UEMCP loaded.
//   - ONE asset editor is already open for the asset named below. These tools
//     never open an editor, by design — a capture must not reorder the user's
//     tabs or steal focus.
//   - This script runs on the same machine as the editor: it stats the PNG
//     files the plugin writes.
//   - UEMCP_LIVE_SMOKE=1, and an explicit project (smoke-live.bat --project,
//     or UEMCP_LIVE_PROJECT_ROOT).
//   - UEMCP_SMOKE_ASSET_PATH=/Game/... naming the open asset.
//
// Run:
//   $env:UEMCP_LIVE_SMOKE='1'
//   $env:UEMCP_SMOKE_ASSET_PATH='/Game/Some/Open/Asset'
//   ..\smoke-live.bat --project "path\to\YourProject.uproject"

import { statSync } from 'node:fs';

import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import {
  createLiveSmokeCall,
  prepareLiveSmoke,
  sleep,
  stopPIEAndWaitForStopped,
  unwrapLiveSmokeResponse,
} from './live-smoke-harness.mjs';

const assetPath = (process.env.UEMCP_SMOKE_ASSET_PATH || '').trim();
if (!assetPath) {
  console.error('[live-smoke-asset-editor-capture] BLOCKED_CONFIG: set UEMCP_SMOKE_ASSET_PATH to the /Game/... path of an asset whose editor is already open.');
  process.exit(2);
}

const smoke = await prepareLiveSmoke({ name: 'live-smoke-asset-editor-capture' });
if (!smoke.ready) process.exit(smoke.exitCode);
const { cm } = smoke;

const call = createLiveSmokeCall({
  execute: (name, args) => executeMenhanceTool(name, args, cm),
  unwrap: unwrapLiveSmokeResponse,
});

/** Size on disk, or -1 when the file is not there. A path with no bytes behind
 *  it is the failure this smoke exists to catch. */
function pngBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function reportCapture(label, result) {
  const bytes = pngBytes(result.png_path);
  console.log(`[${label}] ${result.width}x${result.height} -> ${result.png_path} (${bytes} bytes on disk, ${result.byte_length} reported)`);
  if (bytes <= 0) {
    throw new Error(`${label}: ${result.png_path} is missing or empty on disk`);
  }
  return bytes;
}

const failures = [];

try {
  // ── 1. tabs ────────────────────────────────────────────────
  const tabs = await call('list_asset_editor_tabs', { asset_path: assetPath });
  console.log(`[tabs] ${tabs.editor_class} for ${tabs.asset_path}`);
  for (const tab of tabs.tabs) {
    console.log(`[tabs]   ${tab.tab_id} — "${tab.display_name}" active=${tab.is_active} viewport=${tab.has_viewport}`);
  }
  if (!Array.isArray(tabs.tabs) || tabs.tabs.length === 0) {
    throw new Error('list_asset_editor_tabs returned no tabs for an open editor');
  }

  // ── 2. capture the active tab ──────────────────────────────
  const activeCapture = await call('capture_asset_editor', { asset_path: assetPath });
  reportCapture('capture-active', activeCapture);

  // ── 3. details paging, then a capture of the paged panel ───
  // The Details tab is found by trying each tab: a tab with no details view
  // answers NOT_A_DETAILS_PANEL, which is information, not a failure.
  let detailsTabId = null;
  for (const tab of tabs.tabs) {
    try {
      const expanded = await call('details_panel_expand_all', { asset_path: assetPath, tab_id: tab.tab_id });
      detailsTabId = tab.tab_id;
      console.log(`[details] ${tab.tab_id} expanded rows ${expanded.rows_before} -> ${expanded.rows_after}`);
      break;
    } catch (err) {
      if (err.code !== 'NOT_A_DETAILS_PANEL') throw err;
    }
  }
  if (!detailsTabId) {
    failures.push('no tab in this editor holds a details view — open an asset whose editor has a Details tab');
  } else {
    const scrolled = await call('details_panel_scroll',
      { asset_path: assetPath, tab_id: detailsTabId, row_offset: 20 });
    console.log(`[details] scrolled to row ${scrolled.row_offset} of ${scrolled.max_row_offset} (requested ${scrolled.requested_row_offset})`);
    const detailsCapture = await call('capture_asset_editor',
      { asset_path: assetPath, tab_id: detailsTabId });
    reportCapture('capture-details', detailsCapture);
  }

  // ── 4. PIE in its own window ───────────────────────────────
  // new_window is the case get_viewport_screenshot cannot see: it keeps
  // returning the level-editor viewport while the game runs elsewhere.
  await call('start_pie', { mode: 'new_window' });
  console.log('[pie] started in a new window; waiting for the first frames');
  await sleep(5000);
  try {
    const pieCapture = await call('capture_pie_viewport', {});
    reportCapture('capture-pie', pieCapture);
  } finally {
    await stopPIEAndWaitForStopped({
      execute: (name, args) => executeMenhanceTool(name, args, cm),
      unwrap: unwrapLiveSmokeResponse,
    });
    console.log('[pie] stopped');
  }
} catch (err) {
  failures.push(`${err.code || 'ERROR'}: ${err.message}`);
}

if (failures.length > 0) {
  console.error('\n[live-smoke-asset-editor-capture] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\n[live-smoke-asset-editor-capture] PASS — 3 PNGs written with non-zero size');
process.exit(0);
```

Check `stopPIEAndWaitForStopped`'s parameter names against `server/live-smoke-harness.mjs` before running: the harness is shared and its signature is the contract, not this plan. If it takes different keys, pass those — the intent is "stop PIE and wait until it reports stopped", and it must run in a `finally` so a failed capture still leaves the editor out of PIE.

- [ ] **Step 2: Verify the script refuses cleanly without the opt-in**

```bash
cd server && node live-smoke-asset-editor-capture.mjs
```

Expected: exits 2 with `BLOCKED_CONFIG: set UEMCP_SMOKE_ASSET_PATH…`. Then:

```bash
cd server && UEMCP_SMOKE_ASSET_PATH=/Game/Nothing node live-smoke-asset-editor-capture.mjs
```

Expected: a clean skip from `prepareLiveSmoke` (no `UEMCP_LIVE_SMOKE=1`), exit 0, **no editor contact**. This is all the implementer verifies; the orchestrator runs it against a GUI editor.

The rotation runner enumerates `test-*.mjs`, so this file is not in the rotation and the count does not move.

- [ ] **Step 3: What a successful orchestrator run prints**

With a GUI editor open on the sample 5.6 target and one Blueprint editor open on the named asset:

```
[tabs] BlueprintEditor for /Game/<...>.<...>
[tabs]   GraphEditor — "Event Graph" active=true viewport=false
[tabs]   Inspector — "Details" active=false viewport=false
[tabs]   ...
[capture-active] 1284x742 -> <project>/Saved/UEMCP/Captures/<asset>_GraphEditor_20260913-141207-318.png (184213 bytes on disk, 184213 reported)
[details] Inspector expanded rows 21 -> 63
[details] scrolled to row 20 of 62 (requested 20)
[capture-details] 402x742 -> <project>/Saved/UEMCP/Captures/<asset>_Inspector_20260913-141209-006.png (58119 bytes on disk, 58119 reported)
[pie] started in a new window; waiting for the first frames
[capture-pie] 1280x720 -> <project>/Saved/UEMCP/Captures/PIE_20260913-141216-441.png (912004 bytes on disk, 912004 reported)
[pie] stopped

[live-smoke-asset-editor-capture] PASS — 3 PNGs written with non-zero size
```

Exit code 0. Tab ids, dimensions and byte counts vary by editor and asset; what must hold is: a non-empty tab list, three `bytes on disk` values greater than zero and equal to the reported `byte_length`, `rows_after > rows_before`, and a PIE capture whose dimensions are the game window's rather than the level editor's. **Open the three PNGs.** The one thing no assertion here can check is whether the pixels show the right thing — a Slate widget that has never been painted can produce a plausible file of the wrong content.

If `capture-pie` reports the level-editor viewport's dimensions, PIE did not open its own window; re-run with the asset editor focused before `start_pie`.

- [ ] **Step 4: Bump the plugin version in lockstep**

Three plugin files landed with new shipped commands, so a target that syncs without busting its deploy cache would run a DLL that answers `UNKNOWN_COMMAND` for tools the server now advertises. The W-L deploy marker compares both version fields, so both must move.

In `manifest.json`:

```json
  "version": "1.0.18",
```

In `plugin/UEMCP/UEMCP.uplugin`:

```json
	"Version": 19,
	"VersionName": "1.0.18",
```

In `server/test-plugin-manifest.mjs`:

```js
const EXPECTED_VERSION_NAME = '1.0.18';
const EXPECTED_PLUGIN_VERSION = 19;
```

```bash
cd server && node test-plugin-manifest.mjs
```

Expected: PASS, same assertion count as before.

- [ ] **Step 5: Update `CLAUDE.md`**

Line 11, Project Overview — the counts move by +5 tools and −1 planned entry (154 − 1 + 5 = 158 declared; 143 − 1 + 5 = 147 toolset-scoped; 10 − 1 = 9 planned; 158 − 9 = 149 active):

```markdown
- **Tool Definitions**: `tools.yaml` — **single source of truth** for the registry: 158 YAML-declared tools (11 management + 147 toolset-scoped across 16 toolsets); 9 of the toolset-scoped entries are `status: planned` (hidden, not yet registered), leaving 149 active/callable tools
```

Line 28, Dynamic Toolset System:

```markdown
158 declared / 149 active tools (see Project Overview above for the full breakdown) across 16 dynamic toolsets. Toolsets are enabled/disabled dynamically to stay under the ~40-tool accuracy threshold.
```

Line 69, Implemented — add the visual-capture sentence after the Phase 2 TCP toolsets bullet:

```markdown
- Visual capture: `get_viewport_screenshot` + `get_asset_preview_render`, plus the EN-24/EN-25 asset-editor set — `list_asset_editor_tabs`, `capture_asset_editor`, `details_panel_expand_all`, `details_panel_scroll`, `capture_pie_viewport` (`Public/AssetEditorCapture.h` + `Private/AssetEditorCapture{,Handler}.cpp`). Addressed by asset path through `UAssetEditorSubsystem::FindEditorForAsset`; nothing is ever opened or focused. Captures always write under `Saved/UEMCP/Captures/`; `inline: true` adds base64 and degrades to `inline_omitted: "too_large"` above 8 MiB. UE 5.6 keeps `SetRootExpansionStates` private, so details paging uses the public `IDetailsView` interface and scrolls by row rather than by pixel.
```

Lines 73 and 419, the rotation counts — `7580` becomes `7664` in both (the file count stays 79):

```markdown
**7664 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 79 rotation test files**
```

Line 421, Native plugin tests — the count, the file list and the coverage clause:

```markdown
**Native plugin tests**: 29 UE automation tests live in `plugin/UEMCP/Source/UEMCP/Private/Tests/` (`UEMCPTests.cpp`, `MCPServerTransportPolicyTests.cpp`, `UEMCPBlueprintHelperTests.cpp`, `UEMCPBlueprintHandlerTests.cpp`, `UEMCPAssetEditorCaptureTests.cpp`; pretty-name filter `UEMCP.`; flags `EditorContext | EngineFilter`, compiled only when `WITH_DEV_AUTOMATION_TESTS`). They cover transport intake, the command registry, the response builder, the parsers, the pure Blueprint helpers in `Public/BlueprintHandlerHelpers.h`, three `BlueprintHandlers.cpp` handlers end-to-end through the registry, and every headless-reachable error path of the five asset-editor capture handlers; the other `*Handlers.cpp` bodies remain uncovered. The runner passes `-nullrhi`, so captures themselves are proved only by `server/live-smoke-asset-editor-capture.mjs`, and the two capture tests that need an open asset editor record a labelled skip if `UAssetEditorSubsystem` declines headless. Run them with `run-native-tests.bat [--profile <name>] [--target <alias>]` (headless `UnrealEditor-Cmd`, about 30 s on a mid-size project; exit 0 only when every test passes, 1 on failures or not-run, 2 preflight or config, 3 timeout, 4 no report; `--dry-run` prints the command). The pre-push hook refuses to publish plugin source while any built target in the gate profile (`smoke` when present, else default; `UEMCP_PUSH_GATE_PROFILE` overrides) reports NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY; never-built targets are ignored; bypass with `--no-verify` or `UEMCP_SKIP_COMPILE_GATE=1`.
```

In the File Layout tree, next to the existing `*Handlers.cpp` line under `plugin/UEMCP/Source/UEMCP/Private/`:

```
│       ├── AssetEditorCapture{,Handler}.cpp ← EN-24/EN-25 asset-editor, details-panel and PIE capture
```

- [ ] **Step 6: Close EN-24 and EN-25 in the backlog**

In `docs/tracking/backlog.md`, append to the two headings (nothing else in those entries changes — the sketch they record is now history, and the deviations from it are in the plan and the D-log):

```markdown
### EN-24 — Asset-editor capture: `capture_asset_editor` + `list_asset_editor_tabs` (supersedes planned `capture_active_editor_tab`) — **DONE 2026-09**
```

```markdown
### EN-25 — PIE-window capture and editor-identity on TCP 55558 — **DONE 2026-09**
```

Then add one closing line at the end of the EN-25 entry, since only half of it shipped:

```markdown
- **Closed 2026-09-13**: `capture_pie_viewport` shipped, and `wait_for_editor` now refuses a listener whose reported project is not the attached one (`EDITOR_PROJECT_MISMATCH`), with `connection_info` reporting `identityMismatch`. The per-project port and the `SetReuseAddr` removal stay open — the identity check removes the dangerous outcome (acting on the wrong editor) without a config surface in `.uemcp-targets.json`, `.mcp.json` and the plugin's `Listen()`. Revisit when the headless automation runner needs a port strategy anyway (WS2 step 0.4). Plan: `docs/superpowers/plans/2026-09-13-editor-capture-and-identity.md`.
```

- [ ] **Step 7: Add the D-log row**

Append to the decision-log table in `docs/tracking/risks-and-decisions.md`, after D197:

```markdown
| D198 | **Asset-editor and PIE capture, and editor identity on the wire 2026-09-13** — five visual-capture tools plus a readiness rule, closing EN-24 and EN-25. `get_viewport_screenshot` reads `GEditor->GetActiveViewport()`, which the engine resolves to the level-editor viewport, so no asset editor and no own-window PIE session was reachable. The new handlers address an editor explicitly: `UAssetEditorSubsystem::FindEditorForAsset(asset, /*bFocusIfOpen*/ false)` → `IAssetEditorInstance::GetAssociatedTabManager()` → `CollectSpawners()` + `FindExistingLiveTab(FTabId)` for the tabs, `FSlateApplication::TakeScreenshot` for the pixels. Nothing is opened or focused; `capture_active_editor_tab` (`status: planned` behind an `FWidgetRenderer` path that never shipped) is deleted. **Three engine-API claims in the source request did not survive 5.6.** (1) `SetRootExpansionStates` is **private** — `Editor/PropertyEditor/Private/SDetailsViewBase.h:181`, not on `IDetailsView` — so expand-all is `ShowAllAdvancedProperties()` plus `ScrollPropertyIntoView(path, /*bExpandProperty*/ true)` over `GetPropertiesInOrderDisplayed()`, which reaches the same state because that call expands every ancestor (`SDetailsViewBase.cpp:335-349`). (2) `GetScrollWidget()` returns `SharedThis(this)` (`SDetailsViewBase.cpp:1975`), i.e. the details view rather than the `SDetailTree`, and `SDetailTree` is a private type, so there is no reachable `STableViewBase::SetScrollOffset`; paging is by **row** via `GetPropertyRowNumbers()` + `CountRows()`, which also makes `row_offset` stable across DPI and panel size. (3) The per-handler `MCPThreadMarshal` the request assumed is already central — `FMCPCommandRegistry::Dispatch` wraps every handler in `RunOnGameThread`. **Validation order is the load-bearing design decision**: asset, editor and tab are resolved *before* the renderer gate, because the automation runner passes `-nullrhi` and `FApp::CanEverRender()` is false there — gating first would collapse `ASSET_NOT_FOUND` / `EDITOR_NOT_OPEN` / `TAB_NOT_FOUND` into a single `CAPTURE_UNSUPPORTED` and leave one testable path instead of five. It is pinned by a source-order assertion and by the `AssetNotFound` native test. **EN-25 identity**: the plugin binds 55558 with `SetReuseAddr(true)`, so a second editor shares the port and the OS picks who answers; the readiness probe treated any answer to `get_editor_state` as ready. It now compares the reported `uproject_path` against the attached project through `normalizeComparisonPath` and returns a futile `identity_mismatch` phase carrying the existing `EDITOR_PROJECT_MISMATCH` code — **no new error code**, because `ProjectContext` already used that one for exactly this in both its process-scan and handshake paths, and `connection_info` already detected it; the gap was `wait_for_editor` and a field a caller would actually read. An editor reporting no path stays *unknown*, not wrong. Per-project port stays deferred: it needs a config surface in `.uemcp-targets.json`, `.mcp.json` and the plugin's `Listen()`, and the identity check removes the dangerous outcome at a fraction of the cost. **Deliberate residue**: `CollectSpawners()` is documented as the spawners that get Window-menu entries, so a toolkit hiding a spawner will not have that tab listed — `capture_asset_editor` still accepts such an id because it resolves through `FindExistingLiveTab`. `get_viewport_screenshot` is untouched, and its PNG tail is duplicated rather than extracted: the new tail always writes a file, defaults its path, and caps inline base64 at 8 MiB, and `test-visual-capture-source.mjs` pins the old one by source substring. (closes backlog EN-24 + the capture half of EN-25) | Native suite **22 → 29** (`Native tests: 29 passed, 0 failed, 0 not run`), five new `UEMCP.AssetEditorCapture.*` tests unconditional and two recording a labelled skip when `UAssetEditorSubsystem` declines to open an editor headless. Node rotation **7580 → 7664 across 79 files**, delta +84 reconciled exactly: 40 (`test-tcp-tools`) + 27 (`test-visual-capture-source`: 9 registry + 10 + 8 source) + 13 (`test-editor-readiness`) + 4 (`test-project-server-wire`). Every 5.6 signature cited above was read from `<UE_ENGINE_ROOT>/Engine/Source` before implementation, not inferred. Pixels are proved only by `server/live-smoke-asset-editor-capture.mjs` against a GUI editor — three PNGs with non-zero size on disk, including one PIE capture in its own window; the native suite runs under `-nullrhi` and asserts the refusal instead. Plugin version bumped 1.0.17 → 1.0.18 (`.uplugin` Version 18 → 19) so the W-L deploy marker busts stale target caches; without it a synced target could answer `UNKNOWN_COMMAND` for tools the server advertises. Plan: `docs/superpowers/plans/2026-09-13-editor-capture-and-identity.md`; spec: `docs/superpowers/specs/2026-09-13-editor-capture-and-identity-design.md`. |
```

- [ ] **Step 8: Scrub, verify, and run the rotation**

The D-log row and CLAUDE.md are tracked content, so they go through the codename gate before the commit, not after:

```bash
cd D:/DevTools/UEMCP
git diff --stat
git diff | grep -i -f .git/info/forbidden-tokens
cd server && node run-rotation.mjs
```

Expected: the grep prints nothing (a match means a codename or the blocked scratch-directory word reached tracked content — fix it before committing; the per-checkout token list matches that bare word as well as codenames). Rotation: `Aggregate: 7664 passed / 0 failed / 7664 total` across 79 files — unchanged from Task 4, because this task adds no rotation test.

- [ ] **Step 9: Commit**

```bash
git add server/live-smoke-asset-editor-capture.mjs manifest.json plugin/UEMCP/UEMCP.uplugin server/test-plugin-manifest.mjs CLAUDE.md docs/tracking/backlog.md docs/tracking/risks-and-decisions.md
git commit -F - <<'MSG'
Record the asset-editor capture work: live smoke, version lockstep, docs

live-smoke-asset-editor-capture.mjs is the only proof of pixels — the native
suite runs under -nullrhi and asserts the refusal. It lists an open editor's
tabs, captures the active tab, expands and pages a Details tab and captures
that, then starts PIE in its own window and captures it, checking each PNG's
size on disk. Opt-in like the other smokes and outside the rotation.

Plugin version 1.0.17 -> 1.0.18 (.uplugin Version 18 -> 19) so the W-L deploy
marker busts stale caches: without it a synced target could answer
UNKNOWN_COMMAND for tools the server now advertises.

CLAUDE.md tool counts 154/144 -> 158/149, native tests 22 -> 29, rotation
7580 -> 7664. Backlog EN-24 and EN-25 closed, with the per-project port and
the SetReuseAddr removal left open and their revisit trigger recorded.
D198 records the three 5.6 engine-API claims that did not survive
verification and the validation-order decision behind the error codes.

Rotation unchanged at 7664 across 79 files; native 29.
MSG
```

---

## Verification summary

| After | Node rotation | Native tests |
|---|---|---|
| baseline | 7580 / 79 files | 22 |
| Task 1 | 7629 | 22 |
| Task 2 | 7639 | 26 |
| Task 3 | 7647 | 29 |
| Task 4 | 7664 | 29 |
| Task 5 | 7664 | 29 |

The +84 rotation delta reconciles exactly: 40 (`test-tcp-tools.mjs`) + 27 (`test-visual-capture-source.mjs`, as 9 + 10 + 8) + 13 (`test-editor-readiness.mjs`) + 4 (`test-project-server-wire.mjs`). If a measured total differs, find the missing assertions before moving on — a test file that fails on import contributes 0 and the runner now says so, but a block that silently never runs does not.
