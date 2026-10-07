# Owned editor capture: offline coverage and native queue

Base reconstructed from actual source: `71cf1167bd56dab67aafa26b9afecfdeda5b0b37` (PR #36). The inaccessible cloud patches and historical 43+70 counts are not evidence for this candidate.

## Scope and required offline command

From `server/`, run:

```powershell
node run-rotation.mjs --test-profile owned-editor-capture-offline --json
```

This additive profile requires 50 exact named cases. It verifies the immutable owned UE5.6 corpus, executes the real JS schema/dispatch through an injected transport, checks specific C++ source contracts, and exercises shared scenario acceptance checks with explicitly synthetic responses. It does not execute C++, decode a rendered PNG, prove Slate state, or qualify a consumer project. Existing `test-tcp-tools.mjs`, `test-visual-capture-source.mjs`, native automation, and `live-smoke-asset-editor-capture.mjs` remain required witnesses in their existing lanes.

Run the profile once with active-project settings cleared and once with deliberately invalid ambient project settings. Preserve both JSON execution records (source HEAD, dirty patch and file hashes, profile digest, exact case evidence, corpus identity). A skip, missing case, duplicate case, substituted input, or execution error is not a pass. Run `npm test` and `npm run lint`; distinguish pre-existing failures and gated skips from this profile's results.

`owned-editor-capture-checks.mjs` is a shared acceptance library with no editor connection or launch side effects. Its scenario takes a caller-supplied `call(name,args)` returning the unwrapped result and rejecting errors with the exact `.code`. It also requires `inspectCapture(label,result,options)`; the offline adapter only checks synthetic bytes. A native adapter must read/decode real PNG files and arrange visual review. Merely supplying a no-op callback is not native evidence.

The reader confines files to an explicit canonical project root, rejects relative/outside paths, `.git` metadata paths, and symlink/junction ancestors. It never follows Git `gitdir` or `commondir` redirects. This is capture-evidence read confinement, not a change to Git provenance collection or to the plugin's lexical output-path resolver. The native `OutputPathConfinement` test does not establish reparse-point write confinement.

## Native coordinator handoff — do not launch from an offline worker

All Unreal launch, build, deployment, editor interaction and native cleanup belong to the existing native coordinator. No native action was performed to prepare this slice. No C++ production or native test changes are included.

Coordinator preflight:

1. Bind evidence to the integrated candidate's exact source identity, plugin deployment hash/version, UE5.6 build, target project identity and invocation. Use the coordinator's approved isolated host and output roots on D:. Do not use a consumer project or the canonical source checkout as the host.
2. Keep `server/fixtures/serialization/ue5.6-owned-v1` immutable. Copy the verified corpus to the owned host through the approved fixture workflow; compare manifest/package/oracle hashes before and after. Never regenerate or save back into the committed corpus. The graph oracle establishes asset/topology identity only.
3. Rendered acceptance needs a GPU-backed UE5.6 editor, initialized Slate, and a visible asset editor on `/Game/Serialization/BP_OwnedLink`. Open visible Details and non-Details tabs under coordinator ownership. Record their actual IDs, labels, and the active tab; do not assume `Details`/`Graph` from the synthetic fixture are real toolkit IDs. Keep focus stable between tab listing and active capture.
4. Require useful Details content (select the owned object/node in the owned host if necessary), record visible property names and page state, and allow Slate refresh/ticks after expansion/scroll. Empty or hidden Details content is not a positive paging witness. Do not alter or save graph topology to manufacture coverage.

Queue the exact existing automation names below. Preserve full report and log, not only aggregate success. The coordinator chooses the approved runner/launch commands.

| Lane | Exact automation names | Acceptance |
| --- | --- | --- |
| Headless/native addressing and helpers | `UEMCP.AssetEditorCapture.AssetNotFound`, `UEMCP.AssetEditorCapture.EditorNotOpen`, `UEMCP.AssetEditorCapture.DetailsPanelParams`, `UEMCP.AssetEditorCapture.OutputPathConfinement`, `UEMCP.AssetEditorCapture.InlinePngCap` | Each named test and its assertions executes successfully. These tests create temporary native fixtures under coordinator control. |
| Headless/NullRHI refusal | `UEMCP.AssetEditorCapture.CaptureUnsupportedHelper` | Must actually execute `CAPTURE_UNSUPPORTED` and zero-byte assertions without a renderer. A rendered run explicitly skips this branch. |
| Rendered editor addressing | `UEMCP.AssetEditorCapture.OpenEditorTabs`, `UEMCP.AssetEditorCapture.DetailsPanelTab` | Editor opens, live tabs exist, unknown tab is rejected, and a non-Details tab is found and rejected for scrolling. The current tests can log `skipped:` while returning success; such a report leaves these obligations blocked. |

These native automation tests author their own temporary Blueprint fixture. They do not replace the following rendered scenario on the owned saved package. The existing `CaptureUnsupportedHeadless` and `PieNotRunning` witnesses also remain retained; this bounded queue does not claim them.

## Required rendered scenario

Use `runOwnedEditorCaptureScenario` with the actual tab IDs, an error-preserving dispatch adapter, `afterExpand` and `afterScroll` callbacks that await Slate refresh, and the real PNG inspection callback, or execute the identical sequence manually and retain per-step evidence. `afterScroll` defaults to `afterExpand` for callers using one refresh callback; both Details captures await it. Offline no-op callbacks do not provide rendered evidence. Do not invoke the old combined smoke blindly: it additionally starts/stops PIE and is outside this bounded editor-capture scenario.

| Step | Tool and parameters (all asset calls use the owned path) | Required evidence |
| --- | --- | --- |
| tabs | `list_asset_editor_tabs` | Exact object path echo, nonempty toolkit name, unique real tab IDs, Details/non-Details present, exactly one owned active tab and visible UI corroboration. |
| capture active tab | `capture_asset_editor` with `tab_id` omitted | Response tab equals the immediately observed active tab; decode and inspect its actual PNG. Reject the resolver's first-tab fallback as active-tab proof. |
| unknown tab | `capture_asset_editor` with a confirmed absent tab ID | Exact `TAB_NOT_FOUND`, never success on another tab or `CAPTURE_UNSUPPORTED`. |
| details expand | `details_panel_expand_all` with actual Details ID | `expanded:true`, nonnegative row counts; after a tick, visually verify expanded properties/advanced rows. Counts alone do not establish expansion. |
| non-Details scroll | `details_panel_scroll` on actual non-Details ID, `row_offset:0` | Exact `NOT_A_DETAILS_PANEL`; success is a failure. |
| details scroll | `details_panel_scroll` on Details, `row_offset:20` | Requested offset echoed, integral nonnegative row/max, clamped/landed row within bounds, boolean `scrolled`; inspect actual visible paging. The scenario requires max offset at least 20 and `scrolled:true` here. If the fixture cannot provide those without topology edits, positive paging remains blocked. |
| capture details | `capture_asset_editor` with actual Details ID | Exact tab/object identity plus decoded PNG and visual Details content. A valid PNG of a graph or viewport fails. |
| inline details | Same tool and tab, `inline:true` | Decoded file size equals `byte_length`, dimensions match PNG, MIME is PNG; canonical base64 equals file bytes. Under 8 MiB encoded size, omission fails. Above it require `inline_omitted:too_large` and absent base64; record inline payload branch still unexercised if only omitted. |
| over-range details | `details_panel_scroll`, `row_offset:100000` | Requested offset 100000; returned row no greater than max and no less than clamped offset (thus max for the expected small panel); boolean `scrolled`. A false value is allowed when no property row exists there, and must be recorded rather than described as a successful scroll. |

For each of the three captures, use `readCapturePng` and `assertCaptureBytes`, then an actual image decoder (for example Pillow `Image.open(path).load()` followed by dimension/mode checks), and visual inspection of that same saved file. Retain file SHA-256, byte count, decoded size/mode, exact response, requested/returned tab IDs, and a reviewer note identifying the visible editor/tab/property content. PNG signature, file size, base64 decoding, and the graph oracle alone are insufficient; NullRHI cannot provide pixel acceptance. Capture evidence must belong to this invocation, not a stale file from a previous run.

## Classification and integration

Retain: partial. No test or fixture is retired, no coverage-ledger row is declared complete, and no native/rendered behavior is qualified by the Node result. Residual obligations include the native queue above, actual rendering/decoding/visual review, focus and tick stability, meaningful Details paging, and consumer/version diversity. Independent review must assess the exact candidate and these limits. Retirement and publication are not authorized by this work.
