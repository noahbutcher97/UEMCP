# Inline Viewport Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `visual-capture.get_viewport_screenshot` as the canonical inline viewport screenshot tool.

**Architecture:** Reuse the proven `GEditor->GetActiveViewport()` / `FViewport::ReadPixels` path from legacy `take_screenshot`, but expose it through the `visual-capture` toolset with bounded inline PNG output. The Node layer owns SDK schema, routing, and registry truthfulness; the C++ layer owns viewport read, optional resize, PNG compression, optional disk write, and structured response/error envelopes.

**Tech Stack:** Node.js ES modules, Zod schemas, `tools.yaml`, UE 5.6 C++ editor plugin handlers, `FImageUtils::ImageResize`, `FImageUtils::CompressImage`, PowerShell verification commands, live-editor smoke through `smoke-live.bat`.

## Global Constraints

- Work on branch `d181-inline-viewport-screenshot`.
- Use TDD: every production behavior starts with a failing test.
- Keep `take_screenshot` as legacy file-output compatibility; do not remove it in D181.
- Keep the new tool in `visual-capture`, not `actors`.
- Default inline output must be bounded to 768x432 to avoid large stdio payloads.
- Maximum requested output size is 1920x1080.
- Response payload uses `mime: "image/png"`.
- Relative `output_path` resolves under `FPaths::ProjectSavedDir()`.
- No broad visual-capture expansion; `capture_active_editor_tab`, `get_asset_thumbnail`, and `get_asset_visual_summary` remain planned/excluded.

---

## File Structure

- Modify `server/menhance-tcp-tools.mjs`: add `get_viewport_screenshot` schema and direct TCP dispatch through existing M-enhance tool path.
- Modify `server/test-tcp-tools.mjs`: add red/green routing, validation, and response-shape coverage.
- Modify `tools.yaml`: flip `visual-capture.get_viewport_screenshot` from planned/non-discoverable to shipped metadata with exact params.
- Modify `server/test-tool-registry-truth.mjs` only if the current gate exposes a real classification issue; otherwise leave it unchanged.
- Modify `plugin/UEMCP/Source/UEMCP/Private/VisualCaptureHandler.cpp`: add helper functions and register `get_viewport_screenshot`.
- Modify `plugin/UEMCP/Source/UEMCP/Public/VisualCaptureHandler.h`: document the new handler response shape.
- Optional docs touch only if tests reveal stale active docs after the YAML flip.

---

### Task 1: Node SDK Schema And Routing

**Files:**
- Modify: `server/test-tcp-tools.mjs`
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `tools.yaml`

**Interfaces:**
- Consumes: `executeMenhanceTool(toolName, args, connectionManager)` from `server/menhance-tcp-tools.mjs`.
- Produces: `MENHANCE_SCHEMAS.get_viewport_screenshot` with params `{ width?, height?, return_base64?, output_path? }`.

- [ ] **Step 1: Write the failing test**

Add a test block near the existing `get_asset_preview_render` visual-capture tests:

```js
// get_viewport_screenshot dispatches to tcp-55558 and preserves inline PNG metadata.
{
  const fakePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_viewport_screenshot', {
    status: 'success',
    result: {
      source_width: 1920,
      source_height: 1080,
      width: 768,
      height: 432,
      mime: 'image/png',
      byte_length: 1024,
      base64: fakePngBase64,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  const defs = getMenhanceToolDefs();

  t.assert(defs.get_viewport_screenshot !== undefined, 'get_viewport_screenshot is registered in M-enhance defs');
  t.assert(defs.get_viewport_screenshot.isReadOp === false, 'get_viewport_screenshot bypasses cache because viewport state is volatile');
  t.assert(/PNG/.test(defs.get_viewport_screenshot.description), 'get_viewport_screenshot description labels PNG output');

  const res = await executeMenhanceTool('get_viewport_screenshot',
    { width: 768, height: 432, return_base64: true }, cm);
  t.assert(res.result.mime === 'image/png', 'get_viewport_screenshot labels PNG output');
  t.assert(res.result.base64 === fakePngBase64, 'get_viewport_screenshot returns inline base64 payload');
  t.assert(res.result.width === 768 && res.result.height === 432, 'output dimensions round-trip');

  const call = fake.lastCall('get_viewport_screenshot');
  t.assert(call && call.port === 55558, 'get_viewport_screenshot routed to tcp-55558');
  t.assert(call.params.width === 768 && call.params.height === 432, 'width/height forwarded');
  t.assert(call.params.return_base64 === true, 'return_base64 forwarded');

  fake.resetCalls();
  await executeMenhanceTool('get_viewport_screenshot',
    { return_base64: false, output_path: 'UEMCP/viewport.png' }, cm);
  const fileCall = fake.lastCall('get_viewport_screenshot');
  t.assert(fileCall.params.return_base64 === false, 'return_base64=false forwarded');
  t.assert(fileCall.params.output_path === 'UEMCP/viewport.png', 'output_path forwarded');

  await t.assertRejects(
    () => executeMenhanceTool('get_viewport_screenshot', { width: 0 }, cm),
    /Number must be greater than or equal to 1/,
    'get_viewport_screenshot rejects width below 1'
  );
  await t.assertRejects(
    () => executeMenhanceTool('get_viewport_screenshot', { width: 1921 }, cm),
    /Number must be less than or equal to 1920/,
    'get_viewport_screenshot rejects width above 1920'
  );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server; node test-tcp-tools.mjs`

Expected: FAIL on missing `defs.get_viewport_screenshot`.

- [ ] **Step 3: Implement minimal Node schema**

Add to `MENHANCE_SCHEMAS`:

```js
get_viewport_screenshot: {
  description: 'Capture the active editor viewport as inline PNG, defaulting to bounded 768x432 output.',
  schema: {
    width: z.number().int().min(1).max(1920).optional()
      .describe('Output PNG width in pixels (default 768)'),
    height: z.number().int().min(1).max(1080).optional()
      .describe('Output PNG height in pixels (default 432)'),
    return_base64: z.boolean().optional()
      .describe('Inline base64 PNG in response (default true)'),
    output_path: z.string().optional()
      .describe('Optional disk output; absolute path or relative to Saved/'),
  },
  isReadOp: false,
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server; node test-tcp-tools.mjs`

Expected: PASS, including the new visual-capture assertions.

- [ ] **Step 5: Flip YAML metadata**

Update `tools.yaml`:

```yaml
get_viewport_screenshot:
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
  description: Active editor viewport as bounded inline base64 PNG, with optional disk output.
  params:
    width:         { type: number, required: false, default: 768 }
    height:        { type: number, required: false, default: 432 }
    return_base64: { type: boolean, required: false, default: true }
    output_path:   { type: string, required: false }
```

- [ ] **Step 6: Verify registry truthfulness**

Run: `cd server; node test-tool-registry-truth.mjs`

Expected: PASS; planned/excluded exemptions decrease by one and missing active live tools remain 0.

---

### Task 2: C++ Handler

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/VisualCaptureHandler.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Public/VisualCaptureHandler.h`

**Interfaces:**
- Consumes: existing `BuildSuccessResponse`, `BuildErrorResponse`, and `FMCPCommandRegistry`.
- Produces: TCP wire handler `get_viewport_screenshot`.

- [ ] **Step 1: Write the failing registration evidence test**

Add assertions to `server/test-plugin-get-editor-state-source.mjs` or a focused source audit test that reads `VisualCaptureHandler.cpp` and requires:

```js
t.assert(source.includes('HandleGetViewportScreenshot'), 'visual capture source defines get_viewport_screenshot handler');
t.assert(source.includes('Registry.Register(TEXT("get_viewport_screenshot")'), 'visual capture registers get_viewport_screenshot');
t.assert(source.includes('FImageUtils::ImageResize'), 'viewport screenshot path resizes bounded output');
t.assert(source.includes('FImageUtils::CompressImage'), 'viewport screenshot path compresses PNG through FImageUtils::CompressImage');
```

- [ ] **Step 2: Run test to verify it fails**

Run the touched source-audit test.

Expected: FAIL on missing handler/registration strings.

- [ ] **Step 3: Implement C++ handler**

In `VisualCaptureHandler.cpp`, add includes:

```cpp
#include "Editor.h"
#include "ImageUtils.h"
#include "UnrealClient.h"
```

Add helper behavior:

- Read `width` default 768 and `height` default 432.
- Clamp/reject width outside 1..1920 and height outside 1..1080 with `INVALID_DIMENSIONS`.
- Read `return_base64` default true.
- Read optional `output_path`.
- Require `GEditor && GEditor->GetActiveViewport()`, else `NO_VIEWPORT`.
- Read full active viewport with `Viewport->ReadPixels(Bitmap, FReadSurfaceDataFlags(), Rect)`, else `READ_PIXELS_FAILED`.
- Resize to requested output dimensions using `FImageUtils::ImageResize(SourceW, SourceH, Bitmap, Width, Height, Resized, true, true)`.
- Compress resized data through `FImageUtils::CompressImage(CompressedPng, TEXT("png"), FImageView(...), 0)`, else `PNG_COMPRESS_FAILED`.
- If `output_path` is provided, resolve relative paths under `FPaths::ProjectSavedDir()` and write the PNG; return `FILE_WRITE_FAILED` if write fails.
- Build result with `source_width`, `source_height`, `width`, `height`, `mime`, `byte_length`, optional `file_path`, optional `base64`.

- [ ] **Step 4: Register handler**

Add:

```cpp
Registry.Register(TEXT("get_viewport_screenshot"), &HandleGetViewportScreenshot);
```

- [ ] **Step 5: Run source-audit test to verify it passes**

Run the touched test.

Expected: PASS.

---

### Task 3: Verification, Deployment Readiness, And PR

**Files:**
- Verify all modified files.
- No extra source edits unless verification exposes defects.

**Interfaces:**
- Consumes: D181 Node + C++ implementation.
- Produces: committed branch and PR.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
cd D:\DevTools\UEMCP\server
node test-tcp-tools.mjs
node test-tool-registry-truth.mjs
node test-plugin-get-editor-state-source.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run full server rotation**

Run:

```powershell
cd D:\DevTools\UEMCP\server
npm test
```

Expected: all non-gated tests PASS, with only explicit env/live-gated skips.

- [ ] **Step 3: Build/deploy check**

Run before syncing:

```powershell
cd D:\DevTools\UEMCP
verify-deploy.bat --profile smoke
```

Expected: structured result. If plugin source is newer than deployed DLL, perform the normal close-editor → `sync-plugin.bat` → Unreal `Build.bat` → relaunch → MCP restart cycle before live smoke.

- [ ] **Step 4: Live smoke**

With editor running and MCP restarted, run:

```powershell
cd D:\DevTools\UEMCP
$env:UEMCP_LIVE_SMOKE='1'
node server/run-live-smoke.mjs --project "<project file path>"
```

Expected: existing live smoke passes; add a direct MCP/manual call for `get_viewport_screenshot` if the smoke suite does not yet cover it.

- [ ] **Step 5: Hygiene checks**

Run:

```powershell
git diff --check
git diff | rg -n "<repo-local private-token regex>"
```

Expected: no whitespace errors and no private path/token hits in staged content.

- [ ] **Step 6: Commit and open PR**

Commit explicit paths only, push `d181-inline-viewport-screenshot`, and open a PR with:

- summary of new tool
- verification commands/results
- plugin deploy requirements
- live smoke evidence or exact reason live smoke was deferred
