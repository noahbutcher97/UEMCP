# Plugin batch: ghost BeginPlay and BUG-2 fixes, capture path confinement, capture coverage, runner passthrough — design

**Date:** 2026-09-14
**Status:** approved design; implementation plan follows via the writing-plans skill.
**Closes:** backlog BUG-2 (all four bullets), EN-28, EN-29; adds `--extra-arg` to the native test runner.
**Supersedes nothing.** Follows D198 (native handler coverage) and D199 (capture tools) and uses their fixture and review conventions.

## 1. Purpose

Four plugin-side items are open on the same handlers and the same deploy cycle. Batching them costs one peer-coordinated deploy window instead of four. The batch changes wire behaviour in four places (all recorded in BUG-2 and approved), adds one shared path resolver to the three capture tools, closes the capture coverage the headless suite could not reach, and gives the runner a flag so the next owner-required argument does not need a wrapper script.

## 2. Facts the design rests on

All line numbers are at commit 1abf12a; the implementer re-checks them.

- **The compiler drops a disabled ghost event and everything under it.** During compilation the ubergraph merge clones each source graph with `bCloningForCompile` (`Editor/KismetCompiler/Private/KismetCompiler.cpp:4485`, `:4503`), and `FEdGraphUtilities::CloneGraph` (`Editor/UnrealEd/Private/EdGraphUtilities.cpp`, ~line 279) excludes every node with `!IsNodeEnabled()` from a non-transient source graph. An event node has no input exec pass-through, so the links from its `Then` pin are severed in the clone; the orphaned nodes are not in `GatherRootSet` and `PruneIsolatedNodes` removes them. A timer chain inserted on the ghost compiles to nothing, with no error.
- **Ghost-ness is derived, not stored.** `UEdGraphNode::IsAutomaticallyPlacedGhostNode()` is `!bUserSetEnabledState && EnabledState == ENodeEnabledState::Disabled`. `SetEnabledState(ENodeEnabledState::Enabled, /*bUserAction=*/true)` therefore both enables and un-ghosts. The editor's own placement path (`UBlueprintEventNodeSpawner::Invoke`) removes the ghost and spawns a fresh node instead; the approved fix enables in place so node GUIDs and positions survive.
- **The plugin reuses ghosts at three sites.** `FindExistingEventNode` (`BlueprintHandlers.cpp:791`) matches on member name with no enabled-state filter; it is called from `FindOrCreateReceiveBeginPlay` (`:905`, used by `add_blueprint_timer` at `:2692`), from `HandleAddBlueprintEventNode` (`:1740`), and from `HandleOverrideBlueprintParentMember` (`:1994`).
- **The compiler creates a function stub only for enabled events.** After a successful compile of a Blueprint whose `ReceiveBeginPlay` node is enabled, the generated class has a `ReceiveBeginPlay` function of its own (`FindFunctionByName` with `EIncludeSuperFlag::ExcludeSuper`); with the ghost excluded it does not. This is the headless observable for the reproduction test.
- **Fixtures are ordinary packages.** `CreateFixtureBlueprintOfType` (`Tests/UEMCPBlueprintHandlerTests.cpp`) uses `CreatePackage` and `FKismetEditorUtilities::CreateBlueprint`; nothing marks the package or graphs `RF_Transient`, so the exclusion in the first fact applies to fixtures. A fresh Actor fixture on stock settings (`bSpawnDefaultBlueprintNodes`) carries the ghost.
- **Compile-failure handling differs by handler.** `add_blueprint_timer` reads `compiled_ok` from the compile result (`:2724`), rolls back its authoring and returns `COMPILE_FAILED` (`:2756`); `disconnect_blueprint_pin` reads `compiled_ok` (`:3233`) and returns `COMPILE_FAILED` (`:3272`); `HandleAddBlueprintVariableAssignment` compiles (`:2540`) and then sets `requires_compile = !bCompile`, `compiled = bCompile` (`:2578-2579`) without reading the result.
- **`disconnect_blueprint_pin` builds `target_pin_info` before the break.** The block at `~:3203` precedes the targeted break at `~:3220-3230`; `pin_info` at `~:3258` follows it, so `link_count` disagrees between the two blocks on a real disconnect.
- **`FormatLiteralForPinCategory`** (`BlueprintHandlerHelpers.cpp:~248-251`) reads a three-element array with `AsNumber()` per element without checking types, so `[1,"a",3]` formats `0.000000` and logs a LogJson error instead of returning `LITERAL_TYPE_MISMATCH`; `SetSupportedVariableDefault` validates each element.
- **Capture output paths are unconfined.** `get_viewport_screenshot` (`VisualCaptureHandler.cpp`, ~119-123 and ~240-251) and the shared `FinishCapture` used by `capture_asset_editor` and `capture_pie_viewport` (`AssetEditorCaptureHandler.cpp`) accept any absolute path and any `..` segment; relative paths land under `Saved/`. Both copies append `.png` when the requested name lacks a case-insensitive `.png` suffix. No helper in `Public/HandlerCommon.h` validates against `FPaths::ProjectDir()`.
- **The inline branch has never run.** `FinishCapture` writes `byte_length`, then either `png_base64` or `inline_omitted: "too_large"` when the base64 length (`(N + 2) / 3 * 4`) exceeds `InlineBase64MaxBytes = 8 * 1024 * 1024`. No test or smoke has exercised either arm.
- **`CAPTURE_UNSUPPORTED` has two gates.** `CaptureWidgetToPng` (`Public/AssetEditorCapture.h`, defined in `AssetEditorCapture.cpp`) sets it when Slate cannot render; `capture_pie_viewport` has its own gate ("No renderer is available"). The headless `CaptureUnsupportedHeadless` test cannot reach either because `OpenFixtureEditor` declines first.
- **`details_panel_scroll` reports a row it may not have reached.** It clamps to `CountRows() - 1` (category rows included), then searches `GetPropertyRowNumbers()` (property rows only) for the first row at or after the clamp; when none exists it reports the clamped offset as `row_offset` anyway.
- **The runner has no passthrough.** `buildEditorCommand` accepts `extraArgs` but `main` never passes it and `parseRunnerArgs` has no flag for it; `run-native-tests.bat` forwards every argument except `-y`, `--yes`, `--no-pause` verbatim. The primary target's owner requires `-ExecCmds="Automation RunTests UEMCP,Automation Quit"`, `-ddc=InstalledNoZenLocalFallback` and `-NoSourceControl`, which a scratch wrapper supplied on 2026-09-14.

## 3. Scope

In: the items in §4. Out: coverage of `AnimationHandlers.cpp` (its own unit, D200), the per-project port and `SetReuseAddr` (EN-31), any change to `get_viewport_screenshot` beyond path resolution and the extension rule, and any change to how `FindExistingEventNode` matches names.

## 4. Design

### 4.1 Ghost BeginPlay: enable in place

One helper in `Public/BlueprintHandlerHelpers.h` (implemented in `Private/BlueprintHandlerHelpers.cpp`, per the shared-helper rule):

```cpp
/** Enables an auto-placed ghost event node in place. Returns true when the node was a ghost and is now enabled. */
bool EnsureEventNodeEnabled(UK2Node_Event* EventNode);
```

It returns false without touching a node that is not `IsAutomaticallyPlacedGhostNode()`; otherwise it calls `SetEnabledState(ENodeEnabledState::Enabled, true)` and returns true. The caller marks the Blueprint structurally modified as it already does after authoring.

Call sites: the three reuse sites listed in §2. Each handler's success response gains `enabled_ghost: true` when the helper returned true, and omits the field otherwise (no `false`, matching how the handlers report other optional facts). For `add_blueprint_timer` the field sits at the top level of the result beside `begin_play_node`. `FindOrCreateReceiveBeginPlay` gains an out-parameter `bool& bOutEnabledGhost` (its one caller is updated). `RollbackTimerAuthoring` is unchanged and does not re-disable a node this call enabled, so after a rolled-back compile failure the BeginPlay node stays enabled and empty. That is acceptable: it is exactly what the editor leaves behind when a user places the event and adds nothing, and the error result carries `enabled_ghost: true` so the caller knows the graph changed in that one way.

### 4.2 The other three BUG-2 quirks

- `HandleDisconnectBlueprintPin`: move the `target_pin_info` construction after the break so both `target_pin_info.link_count` and `pin_info.link_count` are post-break values.
- `FormatLiteralForPinCategory`: for the three-element array case, require every element to be a JSON number; otherwise return the `LITERAL_TYPE_MISMATCH` outcome the caller already maps, with the message naming the offending index. Mirror `SetSupportedVariableDefault`'s element check rather than duplicating it: extract the "all elements are numbers" predicate into a small helper both use.
- `HandleAddBlueprintVariableAssignment`: after `CompileBlueprint`, read `compiled_ok` exactly as `add_blueprint_timer` does; on failure roll back what this call authored (the assignment node, the literal or getter node it created, and the exec link; the variable itself if this call created it) through a new `RollbackAssignmentAuthoring` mirroring `RollbackTimerAuthoring`'s shape, then return `COMPILE_FAILED` with the compile messages in `result`. On success set `requires_compile = !bCompile` and `compiled = bCompile && compiled_ok` (so `compiled` is never true after a failed compile).

### 4.3 Capture output paths (EN-28)

One shared resolver in `Public/AssetEditorCapture.h`, implemented in `AssetEditorCapture.cpp`, used by all three tools:

```cpp
/** Resolves a requested capture path to an absolute .png inside the project. Empty request → Saved/UEMCP/Captures/<DefaultLeaf>. */
bool ResolveCaptureOutputPath(const FString& Requested, const FString& DefaultLeaf, FString& OutAbsolutePath, FString& OutError);
```

Rules, in order: empty request → `FPaths::ProjectSavedDir()/UEMCP/Captures/<DefaultLeaf>`; a relative request → joined under `FPaths::ProjectSavedDir()/UEMCP/Captures/`; an absolute request → used as given. The result is normalised with `FPaths::ConvertRelativePathToFull` and `FPaths::CollapseRelativeDirectories`; if the normalised path does not start with the normalised `FPaths::ProjectDir()` (case-insensitive on Windows), the resolver fails with `OutError` naming the rejected path. `.png` is appended when the name lacks a case-insensitive `.png` suffix. Handlers map a failure to the error code `CAPTURE_PATH_OUTSIDE_PROJECT` and run the resolver **before** any editor or viewport lookup, so the rejection is reachable headless. `get_viewport_screenshot` keeps its default leaf and its existing success fields; only its path resolution and extension code move to the resolver. One deliberate consequence: a relative `out_png` given to `get_viewport_screenshot` now lands under `Saved/UEMCP/Captures/` like the other two tools, where it previously landed directly under `Saved/`; the response's absolute path already tells callers where the file went, and the D-log row records the change. `capture_asset_editor` and `capture_pie_viewport` lose their private copies in `FinishCapture`.

### 4.4 Capture coverage (EN-29)

- **(a)** A native test calls `CaptureWidgetToPng(SNullWidget::NullWidget, ...)` directly under the headless runner and asserts the error code is `CAPTURE_UNSUPPORTED`. The handler-level `CaptureUnsupportedHeadless` test keeps its labelled skip; its comment points at the helper-level test.
- **(b)** The inline block in `FinishCapture` moves into a helper `AppendInlinePng(const TSharedRef<FJsonObject>& Result, const TArray<uint8>& Png, int64 MaxBase64Bytes)` declared in `Public/AssetEditorCapture.h`; `FinishCapture` passes `InlineBase64MaxBytes`. Two native assertions: a 32-byte fabricated buffer with a cap of 16 yields `inline_omitted: "too_large"` and no `png_base64`; the same buffer with a cap of 64 yields `png_base64` that decodes back to the same 32 bytes, and `byte_length` is 32 in both. The live smoke (`server/live-smoke-asset-editor-capture.mjs`) gains one `inline: true` capture whose `png_base64` decodes to exactly `byte_length` bytes.
- **(c)** `details_panel_scroll` adds `scrolled: bool` — true only when a property row at or after the clamped offset existed and the scroll was issued; `row_offset` keeps its current meaning. The smoke gains an over-range scroll (`row_offset: 100000`) asserting `scrolled: false` and `row_offset` equal to the reported clamp. The extension rule now lives in the resolver (§4.3), which closes the `.PNG` casing item.

### 4.5 Runner passthrough

`parseRunnerArgs` accepts `--extra-arg <value>`, repeatable, collected in order into `extraArgs`; `main` passes `extraArgs` to `buildEditorCommand`. Because Unreal's `FParse::Value` returns the **first** occurrence of a `-Name=` argument, appending a second `-ExecCmds=` would be ignored, so `buildEditorCommand` gives extra arguments override semantics: an extra argument of the form `-Name=value` replaces the standard argument with the same `-Name=` prefix (case-insensitive) in place; any other extra argument is appended after the standard flags, in the order given. The usage line lists the flag; `--dry-run` prints the effective command with extras applied, quoted when they contain spaces. The CLAUDE.md native-test paragraph gains one clause naming the flag and the replace rule. `run-native-tests.bat` needs no change. The scratch wrapper from 2026-09-14 retires.

## 5. Testing

Native tests (all headless-reachable, registry-dispatched where a handler is involved, fixture created and torn down per test as in D198):

| Test | Asserts |
|---|---|
| `UEMCP.BlueprintHandlers.GhostBeginPlayEnabled` | Precondition: fixture's `ReceiveBeginPlay` is a ghost and its graph is not `RF_Transient`. After `add_blueprint_timer { insert_on_begin_play: true, compile: true }`: success, `enabled_ghost === true`, the node is enabled and no longer a ghost, and the generated class has its own `ReceiveBeginPlay` function. A second identical dispatch on the same fixture omits `enabled_ghost`. **Red step required**: with the helper stubbed to return false, the function-stub assertion must fail; quote both runs. |
| `UEMCP.BlueprintHandlers.EventNodeGhostSites` | `add_blueprint_event_node` and `override_blueprint_parent_member` on a fresh fixture each report `enabled_ghost: true` and leave the node enabled. |
| `UEMCP.BlueprintHandlers.DisconnectPinEdges` (extended) | `target_pin_info.link_count` equals the post-break count. |
| `UEMCP.BlueprintHelpers.LiteralDefaults` (extended) | `[1,"a",3]` → `LITERAL_TYPE_MISMATCH` naming index 1; `[1,2,3]` still formats. |
| `UEMCP.BlueprintHandlers.AssignmentCompileFailed` | With an unresolvable call planted as in `TimerFailures`, `add_blueprint_variable_assignment { compile: true }` returns `COMPILE_FAILED`, `compiled === false`, and the authored nodes are gone. With `compile: false`, `requires_compile === true`. |
| `UEMCP.AssetEditorCapture.OutputPathConfinement` | Resolver: empty → under `Saved/UEMCP/Captures/`; relative with `..` that escapes → error; absolute outside the project → error; absolute inside `Saved/` → accepted; `foo.PNG` keeps its name, `foo` gains `.png`. Handlers: each of the three tools returns `CAPTURE_PATH_OUTSIDE_PROJECT` for an escaping path, before any editor-state error. |
| `UEMCP.AssetEditorCapture.CaptureUnsupportedHelper` | §4.4(a). |
| `UEMCP.AssetEditorCapture.InlinePngCap` | §4.4(b). |

Node: `test-native-runner.mjs` gains assertions for `--extra-arg` (repeatable and order-preserving; a `-ExecCmds=` extra replaces the standard one in place and leaves exactly one `-ExecCmds=` in the argument list; a `-NoSourceControl` extra appends; the usage line names the flag; dry-run quoting). Rotation grows by those only. The live smoke gains the two checks in §4.4; the orchestrator runs it once with a GUI editor before the branch finishes.

Expected native total: 34 + 6 new tests = 40, with the same three labelled skips.

## 6. Deploy and verification

Every red/green cycle runs on the sample 5.6 target. The primary target receives one deploy at the end, inside a peer-granted window with the completion notice shape used on 2026-09-14 (backup path, exact commands, selectors, exit codes, raw log paths). The pre-push gate must read both targets SYNC before the push. `run-native-tests` on both targets must report 40 passed, 0 failed, 0 not run; the primary run uses `--extra-arg` for the owner's three flags instead of a wrapper.

## 7. Documentation

CLAUDE.md: the native-test count (40), the `--extra-arg` clause, and one sentence in the visual-capture bullet on path confinement and `CAPTURE_PATH_OUTSIDE_PROJECT`. Backlog: BUG-2 moves to Fixed with the four outcomes; EN-28 and EN-29 move to Shipped. D-log: one row (D201) recording the compile-time drop mechanism, the fix shape chosen and why, the assignment rollback decision, and the resolver rule. `tools.yaml`: `enabled_ghost`, `scrolled`, and `CAPTURE_PATH_OUTSIDE_PROJECT` appear in the affected tools' descriptions or response notes.

## 8. Constraints that apply to every task

- Public repo: placeholder vocabulary only in tracked files ("the primary target", "the sample target"); the pre-commit and pre-push hooks scan against the per-checkout token file, and the bare word "temp" is blocked (write "scratch").
- No AI attribution in commits. One commit per task; never push from a task.
- C++ helpers used by more than one `Private/*.cpp` live in a `Public/` header; functions under 50 lines where possible; comment intent.
- Every native test creates its fixture in `/Game/__UEMCPTests/<unique leaf>`, registers it with the asset registry, and tears it down on every exit path; nodes are addressed by handler-reported GUIDs; `compile` is explicit on every dispatch.
- Sync before every build (Build.bat compiles the deployed copy); the sample target is the only build target during tasks; stop any build with no compiler process for five minutes and report BLOCKED.
- Wire behaviour changes are the four listed in §4.1 and §4.2, the new fields and error code in §4.3 and §4.4, and the relocation of `get_viewport_screenshot`'s relative output paths under `Saved/UEMCP/Captures/`; nothing else on the wire changes.
