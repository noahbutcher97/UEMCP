# Audit: test-phase1.mjs Test 5 regression (actors availability)

**Date**: 2026-04-15
**Investigator**: Agent 2
**Scope**: Read-only diagnostic. No production files modified.
**Status**: Diagnosis complete; fix proposed, not applied.

---

## §1 Root cause

Test 5 is **environment-dependent**: it asserts that `actors` (layer `tcp-55557`) reports *unavailable* when "no editor is running", but the test makes a **real TCP connection** to `127.0.0.1:55557` to probe health. When the Unreal Editor is open with the UnrealMCP plugin loaded (i.e., during active Phase 2/3 development — which is now the normal dev state), the `ping` succeeds and `actors` is correctly reported **available**, causing the two assertions to fail. This is not a code regression — the availability plumbing is byte-identical to the pre-Phase-2 baseline (`b10c414` vs HEAD).

Trace:

1. `test-phase1.mjs:83` constructs a `ConnectionManager` **without** a `tcpCommandFn` mock seam (`server/test-phase1.mjs:76-83`).
2. `toolsetMgr.enable(['actors'])` → `ToolsetManager.enable()` → `_isToolsetAvailable('actors')` (`server/toolset-manager.mjs:134`, `268-276`).
3. That calls `connectionManager.isLayerAvailable('tcp-55557')` (`server/toolset-manager.mjs:272`).
4. `isLayerAvailable` sees `lastCheck=0` / status=UNKNOWN and falls through to `_probeLayer('tcp-55557')` (`server/connection-manager.mjs:280-290`).
5. `_probeLayer` uses the real `tcpCommand` (since `_tcpCommandFn` is null) to connect to `127.0.0.1:55557` and send `{"type":"ping","params":{}}` (`server/connection-manager.mjs:576-584`).
6. If any editor/plugin is listening on 55557 and returns a parseable JSON reply (no `status:"error"` and no `success:false`), `extractWireError` returns null and the layer is marked AVAILABLE → `actors` is enabled.
7. Both `actors correctly reported unavailable` and `actors not in enabled set` then fail; the other four Test 5 assertions (offline, gas on 55558, disable/re-enable of offline) pass because `gas` is on the still-unoccupied port 55558 and offline operates purely on disk.

Cross-check: identical diff for `_isToolsetAvailable`, `enable`, and `_probeLayer` between `b10c414` (Phase 1 baseline) and HEAD confirms the semantics haven't drifted. The baseline "36/36 green" was achieved with the editor closed; the failing state is "editor open," which is now the normal case.

---

## §2 Proposed fix

**Recommendation: fix the test, not the code.**

The code is correct — when a real editor answers ping, reporting `actors` available is the right behavior. The test's intent is to exercise the "unavailable → stays out of enabled set" path as a unit-level plumbing check; it should not depend on whether the user happens to have the editor open. The TCP mock seam (`config.tcpCommandFn`) and `ErrorTcpResponder` already exist (`server/test-helpers.mjs:113`) — use them. This is also consistent with how `test-mock-seam.mjs` and `test-tcp-tools.mjs` are structured (263 assertions all passing, all using the mock seam).

Diff:

```diff
--- a/server/test-phase1.mjs
+++ b/server/test-phase1.mjs
@@ -5,6 +5,7 @@ import { load } from 'js-yaml';
 import { ToolIndex } from './tool-index.mjs';
 import { ToolsetManager } from './toolset-manager.mjs';
 import { ConnectionManager } from './connection-manager.mjs';
 import { executeOfflineTool } from './offline-tools.mjs';
+import { ErrorTcpResponder } from './test-helpers.mjs';

@@ -73,12 +74,17 @@
 // ── Test 5: Accumulation and shedding ────────────────────
 console.log('\n═══ Test 5: Accumulation and shedding ═══');

+// Force both TCP layers to report unavailable regardless of whether the editor
+// is currently running. Test 5 exercises enable/disable plumbing, not real TCP.
+const tcpDown = new ErrorTcpResponder('connection_refused');
+
 const config = {
   projectRoot: PROJECT_ROOT,
   tcpPortExisting: 55557,
   tcpPortCustom: 55558,
   httpPort: 30010,
   tcpTimeoutMs: 5000,
+  tcpCommandFn: tcpDown.handler(),
 };
 const connMgr = new ConnectionManager(config);
 const toolsetMgr = new ToolsetManager(connMgr, toolIndex);
```

Reasoning: one-line import plus one-line config addition. Fully deterministic, editor-agnostic. Matches the pattern established by the other two test files. No production code touched. `offline` availability is unaffected because it's a disk check, not a TCP probe.

Alternative considered and rejected: adding a "close the editor before running" note to CLAUDE.md. Rejected because (a) it makes unit-level tests dependent on external state, (b) it's friction during active dev, and (c) the existing mock seam was designed precisely for this.

---

## §3 Collateral findings

1. **Output-ordering race in `test-phase1.mjs` Test 3** — In environments where `list_config_values` fails, the `✗ list_config_values: ENOENT …` assertion line is logged *after* `═══ Summary ═══` / `Passed/Failed/Total`, meaning `process.exit(failed > 0 ? 1 : 0)` may run before the last assertion settles. File: `server/test-phase1.mjs:224-229` + `243-248`. Severity: **low**. Action: `await` the entire Test 3 block explicitly, or collect assertions in an array and flush before Summary (purely a reporting bug; the exit code is still correct because `failed` was already incremented synchronously in the catch).

2. **Dead variable in `ToolsetManager.enable`** — `const layer = TOOLSET_LAYERS[name];` at `server/toolset-manager.mjs:133` is assigned and never used (availability is re-derived inside `_isToolsetAvailable`). Severity: **low**. Action: delete the line; keeps the hot path readable.

3. **`_isToolsetAvailable` is a redundant 4-way switch** — `server/toolset-manager.mjs:268-276` branches on layer key only to call `isLayerAvailable(<same key>)`. It could collapse to `return this.connectionManager.isLayerAvailable(TOOLSET_LAYERS[name])`. Severity: **low**. Action: simplify; prevents future drift if a new layer is added and someone forgets to add a branch.

4. **Double offline probe during `load()`** — `ToolsetManager.load()` calls `checkOfflineAvailable()` directly (`server/toolset-manager.mjs:70`), then immediately calls `enable(['offline'])`, which internally triggers another `_probeLayer('offline')` → `checkOfflineAvailable()`. Second call short-circuits via the 30s cache so it's harmless, but the explicit pre-check is redundant. Severity: **low**. Action: drop the pre-check and let `enable()` drive the probe; one codepath, one cache entry.

5. **Potential shared-module state in `TOOLSET_LAYERS`** — `server/toolset-manager.mjs:22` declares `TOOLSET_LAYERS` as a module-level `let` that `load()` overwrites. If two `ToolsetManager` instances are ever constructed in the same process (e.g., a future test that wants isolated instances), the later `load()` silently stomps the earlier instance's layer map. No active callers hit this today. Severity: **medium** (latent footgun, not a bug today). Action: move `TOOLSET_LAYERS` to instance state (`this._toolsetLayers`) in a future refactor.

---

## §4 Open questions

1. **Intent of Test 5**: Is Test 5 meant as a *plumbing unit test* (enable/disable state machine, mock TCP fine) or a *real-environment integration test* (must be run with editor closed)? My fix assumes the former, which matches the rest of the file's character. If the latter, the correct fix is a CLAUDE.md note and no code change — confirm before applying.

2. **Should `_isToolsetAvailable` be collapsed now or deferred?** Finding #3 is trivial but touches a hot codepath. Noah's call on whether to bundle it with the Test 5 fix or leave for a later cleanup CL.

---

Signed: Agent 2
