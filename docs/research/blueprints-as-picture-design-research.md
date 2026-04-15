# Blueprints-as-Picture — Design Research

> **Status**: Research (read-only). Informs a future bucket 3F addition to `docs/specs/phase3-plugin-design-inputs.md`. No code, no commits.
> **Parent docs**: [amendment](../specs/blueprints-as-picture-amendment.md), [parent spec](../specs/blueprint-introspection.md).
> **Date**: 2026-04-15. Author: research pass on Noah's handoff.

---

## Framing

The primary consumer is Claude Code doing dynamic BP access while the developer is in Rider, doing code review, or otherwise not running the UE editor. That use case makes the sidecar the load-bearing mechanism, not an optimization. A TCP-only v1 would refuse service any time the editor isn't up, which is most of the time for this user. The amendment's Path C-first framing is therefore correct; the research work is to pin down the mechanisms it hand-waves (delegate choice, atomicity, dirty-editor handling, schema drift, priming strategy) so Phase 3 lands with the corner cases closed rather than discovered in production. NodeToCode's collector — the closest living reference — confirms nothing in UE 5.6 serializes node positions or comment-box containment for LLM consumption, so we have nothing to copy but also no binary format constraining us.

---

## Q1 — Plugin-side extraction: which path, under what constraints?

### The three paths

| Axis | Path A — Editor-mediated TCP only | Path B — Offline `.uasset` UProperty parser | Path C — Sidecar via editor Save hook |
|---|---|---|---|
| Implementation cost (person-weeks, rough) | ~1 week (one TCP command + a `UEdGraph` walker we have to write anyway) | 4–8+ weeks, open-ended | ~1 week on top of Path A (Save hook + writer); happy path is "call the Path A serializer, write bytes" |
| Per-read latency | 50–200 ms per call (TCP round-trip + graph walk) — comparable to Phase 2 oracle tool latencies | 10–50 ms after one-time parse; 100–500 ms if cold | <10 ms (read disk JSON) when sidecar fresh |
| Correctness on edge cases | High (editor is ground truth). Degrades to "tool unavailable" when editor offline. | Medium–low. BP-generated classes, struct versioning, nested objects, referenced assets, and the BP editor's in-memory-only fixups (e.g., node reconstruction on load) all fall outside a shallow parser. Will diverge from the editor's view of the same BP in non-obvious ways. | High when fresh; correctness depends entirely on freshness rules (Q3). Never better than "what was on disk at last save." |
| Maintenance across UE versions | Low. `UEdGraphNode`, `UEdGraphPin`, `UK2Node`, `UEdGraphNode_Comment` have been stable since UE4. We own the extraction, not the binary format. | High. UE asset binary format changes across minor versions; BP serialization quirks change across patch releases. CUE4Parse chases this constantly and is still imperfect for Blueprints. | Same as Path A (same extraction code) plus schema-version migration burden for sidecars. |
| Editor-dependency at read time | Hard requirement | None | None when fresh; Path A fallback when stale. |
| Risk of blocking Phase 3 landing | Low | High (scope creep kills the milestone) | Low-medium (delegate choice + atomicity + edge cases in Q3) |

### Why Path B is a no

The state of the art for offline UE asset parsing is CUE4Parse (C#, LGPL) and UEViewer. Both are read-only and both explicitly punt or best-effort on Blueprint-generated classes. The harder sub-problems — `UClassProperty` resolution for user structs compiled into the BP, instanced subobject references inside components, the editor's load-time reconstruction of `UEdGraphNode` pins from serialized pin descriptors — are where "I can extract positions" turns into "I can't tell the user which function their `UK2Node_CallFunction` actually resolves to when the target lives in another package I haven't also parsed." Even if we got to 80% fidelity it would diverge from the editor's view in quiet ways that would cost more to debug than the capability saves. Track 2a (Agent 3's asset-registry parser) is deliberately scoped to the FAssetRegistryData tag block precisely because that block is stable and small; extending that parser to full graph fidelity is an order of magnitude more work for a fraction of the users (people without the editor running who want graph-level detail — not a large population on this team). **Recommend: rule Path B out permanently. The amendment already does, implicitly; the research confirms.**

### Recommendation: Path C (sidecar-first) with Path A as live-extraction

Because Claude Code's primary use is dynamic BP access without the editor running, sidecars must be the default read path from day one. Path A is not a v1-versus-v1.1 question; it's the live-extraction side of the same system, used in three cases: the Save hook serializer (the sidecar writer calls the same code), dirty-editor reads (when the editor is up and holding unsaved changes, TCP is ground truth), and on-demand priming (a reader that finds no sidecar and detects a running editor requests one synchronously, getting both the answer and a freshly-written sidecar for next time).

**Path C as v1 means the following ship together in Phase 3:**

1. **`dump_graph` TCP command** on :55558. Same serializer used by both the command and the Save hook. Implements parent spec format + spatial additions + `comments[]` with pre-computed `contains[]`.
2. **Save hook** on `UPackage::PackageSavedEvent` (see Q2), atomic-rename writes (see Q3), writing to the sidecar cache tree (see Q1a below).
3. **`prime_bp_cache` editor command** — upgraded from "nice to have" to "required bootstrap." The first time someone opens the project after Phase 3 ships, it writes sidecars for every existing BP that hasn't been re-saved yet. Without this, a fresh checkout leaves Claude Code unable to read any BP until each one is individually opened and saved. `prime_bp_cache` is the difference between "works on day zero" and "works after the team organically re-saves every BP." Auto-invoked on first editor load when the cache is empty (see Q1b).
4. **`bp_is_dirty` TCP probe** — new. Q3 failure mode #4 (editor open with unsaved changes, sidecar stale) is not a v1.1 concern because Claude Code and the editor running concurrently is a real workflow (developer is mid-edit, asks Claude Code a question about the BP they're working on). When this probe is unreachable (editor offline), the reader trusts the sidecar. When it's reachable and returns dirty, the reader calls `dump_graph` over TCP for that BP only.
5. **Node.js reader** with the D33 freshness key extended to `{path, mtime, size, schema_version}`. Try sidecar → fall back to TCP (priming the sidecar in the process) → emit `no_sidecar_and_editor_offline` only if both paths fail.
6. **Repo policy**: a single directory exclusion (`Saved/UEMCP/` in `.gitignore` and `.p4ignore`) covers the entire cache. Saved/ is already ignored by convention in UE projects, so in practice this is belt-and-suspenders — but the line goes in the v1 PR regardless (see Q1a for why the location choice makes this near-trivial).

**Never Path B.**

**What can still defer to v1.1:** `bp_paths_between` (see Q4 — the least-proven verb), and polish on `prime_bp_cache` (progress reporting, resumability for huge projects). The core read path is not phaseable without breaking the primary use case.

### Q1a — Sidecar location: mirror tree under `Saved/UEMCP/BPCache/`

The amendment left this open between "next-to-asset" and "parallel mirror tree." The mirror tree wins on UE convention and on three concrete grounds:

1. **UE convention puts derived-from-source state in `Saved/`**, not `Content/`. `Content/` is source assets. The sidecar is a cache of the asset, not a sibling of it. `DerivedDataCache/` is the closest engine analog but has engine-managed semantics and reserved key conventions we should not hijack; `Saved/UEMCP/BPCache/` is the right analog without overloading a reserved name. `Intermediate/` is wrong because it's wiped on project-file regeneration; our cache is not a build artifact.
2. **P4 safety is categorical, not per-file**. Next-to-asset means every BP directory accumulates `.bp.json` files that must be excluded in `.p4ignore`, and a single forgotten rule submits machine-local cache into the depot. A single `Saved/UEMCP/` directory exclusion covers the entire tree forever, and Saved/ is already conventionally ignored by both git and Perforce in UE workflows. This drops the "accidental commit" risk from "possible" to "effectively impossible."
3. **The sidecar is per-developer cache, and that's correct**. The freshness key is `{path, mtime, size, schema_version}` on *that developer's machine*. If sidecars were checked into P4 at `Content/`, every sync would ship stale caches keyed to whoever submitted last. Saved/ is already per-user by convention, so the cache naturally stays local to the machine that generated it. This also makes a full cache reset trivial (`rm -rf Saved/UEMCP/BPCache/`), which matters when schema bumps or UE version upgrades invalidate everything.

**Path translation cost**: `Content/Characters/BP_OSPlayer.uasset` → `Saved/UEMCP/BPCache/Characters/BP_OSPlayer.bp.json`. Strip the `Content/` prefix, prepend `Saved/UEMCP/BPCache/`, swap extension. ~5 lines in the reader and ~5 in the Save hook. Trivial.

**Wipe-resilience**: users routinely nuke `Saved/` to clear editor state. The cache is designed to rebuild from the source assets via `prime_bp_cache`; nothing irreversible is lost. This is a feature, not a concern, once `prime_bp_cache` is a required bootstrap (per Q1 item 3) rather than an optional utility.

### Q1b — `prime_bp_cache` auto-run: yes, on first editor load when cache is empty, default-on setting

The primary use case is Claude Code against a fresh P4 sync with no editor running. `Saved/` is not synced from Perforce, so the cache is guaranteed empty on first checkout → every `bp_*` verb hits the `no_sidecar_and_editor_offline` fallback and Claude Code looks broken until someone remembers to run a manual command. That is the wrong first impression for the tool's primary consumer.

**Recommendation**: the plugin detects an empty `Saved/UEMCP/BPCache/` on editor startup and kicks off `prime_bp_cache` as a background task (not blocking editor readiness). The amendment already specifies progress reporting (every 10% or 100 BPs) which becomes the idle-time UX. Expose a plugin setting `bAutoPrimeBlueprintCache`, default `true`, for users who want to opt out.

**Cost accounting**:
- ProjectA-scale projects (~50-100 BPs at ~10ms serialize each): ~1 second of background work during a boot that already takes tens of seconds for module/shader compile.
- Larger projects (500+ BPs): ~5 seconds of background work on a cold start, amortized across the editor's normal startup wait.
- The cost is paid *once per fresh checkout*, not per editor launch — on subsequent launches the cache is already warm and the sweep is a no-op (detection step is `fs.readdir(cache_dir).length === 0`).

**Why not auto-prime on every launch**: wasteful, surprising, and the non-empty-cache case is the common one after day zero.

**Why not lazy/on-demand priming by the reader**: the reader is Node.js and runs outside the editor. If the editor isn't up, it can't trigger a prime — that's exactly the failure mode we're trying to avoid. If the editor IS up, the stale-sidecar fallback (TCP `dump_graph`) already handles on-demand extraction for individual BPs. Lazy is already what we do for the editor-running case; eager-on-first-boot covers the editor-not-running case.

---

## Q2 — Delegate selection and firing semantics

The right delegate is **`UPackage::PackageSavedEvent`** (or its modern successor `FCoreUObjectDelegates::OnPackageSavedWithContext` in UE 5.1+), filtered for packages that contain a `UBlueprint`. Reasoning per candidate:

| Candidate | Fires on | Fires once per save? | Threading | Verdict |
|---|---|---|---|---|
| `UPackage::PackageSavedEvent` / `OnPackageSavedWithContext` | After the package's disk write completes | Yes — once per package save | Game thread | **Correct choice.** Payload includes the `UPackage*`; we iterate its contents, find the `UBlueprint` if present, serialize, write sidecar. |
| `FCoreUObjectDelegates::OnObjectSaved` | Per saved `UObject` within a package | No — fires multiple times (BP, generated class, CDO, nested subobjects) | Game thread | Wrong granularity. Would write the sidecar 3-5× per save. Usable only with dedup by outermost `UPackage`. |
| `UBlueprint::OnChanged()` | Structural BP changes (nodes added/removed/wired) in the editor, **not at save boundaries** | No — fires many times during editing | Game thread | Wrong semantics. We'd thrash sidecars every keystroke. |
| `FKismetEditorUtilities::OnBlueprintCompiled` | After BP compile | Per compile | Game thread | Compile ≠ save. A user can compile without saving; a user can save without triggering a fresh compile if nothing changed. Out-of-phase with disk state. |
| `FAssetRegistryModule::AssetUpdatedEvent` | Asset registry notices a change | Per registry update, after some latency | Game thread | Too downstream; we want to write as close to the save as possible. |

**Semantics of the chosen delegate:**

- Fires after the disk write, so we know the `.uasset` mtime is settled before we compute the sidecar's freshness key. No race where the sidecar is older than the asset mtime it was written for.
- Fires on the game thread, so access to the in-memory `UBlueprint`/`UEdGraph` is safe without synchronization.
- Fires for transient saves (e.g., temp packages during cook) — filter on `Package->HasAnyFlags(RF_Transient)` to skip.
- Fires on auto-save — we want this, treat it as a normal save.
- Does **not** fire on compile-only-no-save — good, we don't want to rebuild the sidecar for an un-persisted compile.
- Does **not** fire on rename; rename triggers a separate delete-and-save sequence. Our handler sees the new save and the old sidecar is stranded — the D33 freshness check on next read detects the stale sidecar by name mismatch and ignores it.

**Exception handling inside the delegate handler:** UE will generally catch exceptions and log them without crashing, but the editor is single-threaded on the game thread and a hang in our handler blocks the editor. Mandatory rules for the handler body: (a) wrap file I/O in a try-equivalent (`IFileManager::Get().FileExists` + `FFileHelper::SaveStringToFile` returns a bool; check it, log on failure, move on); (b) never block on a TCP call or network resource; (c) hard-cap serialization time — if a BP has pathological node count (>2000), fall back to "log warning, skip sidecar write for this BP, rely on TCP." Never block the asset save by propagating an exception.

**Is there a BP-specific delegate?** `UBlueprint::OnCompiled()` and `OnChanged()` are the closest, but neither is a save boundary (see above). The amendment's intuition that there's a first-class "BP saved" delegate is wrong — we hook the generic package-saved event and filter. That's fine; it's idiomatic UE.

---

## Q3 — Sidecar correctness under adversarial conditions

D33 gives us an mtime+size key and a 60s TTL sweep. The amendment claims this covers sidecar freshness but does not enumerate the failure modes. Here is the enumeration with a rule per row.

| # | Failure mode | Detected how | Resolution | User-visible |
|---|---|---|---|---|
| 1 | Sidecar mtime < asset mtime (sidecar stale) | mtime comparison on every read | Ignore sidecar; fall back to TCP if editor running, else return `no_sidecar_and_editor_offline` | Transparent when editor running; honest error when not |
| 2 | Sidecar mtime > asset mtime (asset reverted via P4/Git; sidecar reflects future state that no longer exists) | mtime comparison | Ignore sidecar (treat as stale — content no longer matches); fall back to TCP; next save rewrites sidecar | Transparent; may incur one TCP round-trip on first read after revert |
| 3 | Sidecar exists but schema major-version differs from reader | JSON `"version": "x.y.z"` parse; reject if major differs | Ignore sidecar; fall back to TCP when editor running; emit `schema_version_mismatch` with the observed version when editor offline | Honest; hint to run `prime_bp_cache` once |
| 4 | BP open in editor with unsaved changes; sidecar on disk is pre-edit | Per-call TCP probe returns `editor_dirty: true` + `dirty_hash` alongside `on_disk_hash`; caller sees mismatch | **TCP is ground truth when editor is connected.** Never read sidecar if editor reports dirty for that BP. Amendment says this implicitly; make it explicit. | Claude sees the live editor state, not stale disk |
| 5 | Two editor instances have the BP open; one saves | Whichever one saves writes the sidecar; the other sees a newer mtime and either discards its dirty state or produces a conflict on its own save attempt | UE's standard asset-collision handling applies (warns user on save). Sidecar follows the asset — whichever `.uasset` wins, its sidecar wins. We do not arbitrate. | Same as today's UE multi-editor behavior |
| 6 | P4 lock / read-only `.uasset`, sidecar write attempts | `FFileHelper::SaveStringToFile` returns false | Log warning, skip this sidecar. **Never mark for add, never check out.** Sidecars are .gitignored/.p4ignored. | Silent; next read falls back to TCP |
| 7 | User manually deletes sidecar | Next read finds no file | Fall back to TCP if editor running; `no_sidecar_and_editor_offline` if not | Expected and documented |
| 8 | Asset moved/renamed (sidecar stranded at old path) | New sidecar written at new path on save; old one orphaned | Accept orphan; `prime_bp_cache` with a sweep flag can clean them up; acceptable drift | Orphans harmless |
| 9 | Sidecar write partially succeeds (disk full / write interrupted) | Corrupt JSON on next read; parse fails | Treat as missing; fall back to TCP; log. Consider atomic rename pattern (`.bp.json.tmp` → rename) to prevent this class entirely. | Transparent with atomic rename |

**Recommendation beyond the amendment:**
- **Use atomic rename for sidecar writes** (`FFileHelper::SaveStringToFile` to `<bp>.bp.json.tmp`, then `IFileManager::Move` rename). Closes failure mode #9 entirely. Costs a few LOC.
- **Freshness key = mtime+size+schema_version, not just mtime+size.** Schema version bump invalidates all caches project-wide without a manual `prime_bp_cache` sweep. The amendment already carries `version` in the sidecar; the reader should include it in the D33 cache key.
- **mtime granularity**: NTFS is 100 ns — fine. WSL/network mounts vary (1s or worse). On networked projects, a size check becomes essential (same-mtime saves with different content size are the real-world hazard). Already in D33; confirm this is preserved for sidecars specifically.
- **Failure mode #4 is the one the amendment underspecifies.** Call out explicitly that "sidecar read is valid only when the editor reports the BP not-dirty." That requires TCP:55558 to expose a cheap `bp_is_dirty` probe (a few ms, no serialization). Add this as a sub-requirement to 3F-1 in Phase 3.

---

## Q4 — Verb ergonomics: do the nine compose?

### Scenario 1: "What happens when the player presses the attack button in GA_OSComboAttack?"

Well-behaved Claude trace:

1. `bp_list_graphs("GA_OSComboAttack")` → returns `[{name: "EventGraph", type: "EventGraph", entry_node_ids: ["N1"]}, {name: "ActivateAbility", type: "Function", ...}, ...]`. ~200 tokens.
2. `bp_list_entry_points("GA_OSComboAttack", "ActivateAbility")` → `[{id: "N1", name: "Function Entry", pos: [...]}, ...]`. ~150 tokens.
3. `bp_trace_exec("GA_OSComboAttack", "ActivateAbility", "N1", max_depth=15)` → tree of exec nodes from the function entry, with immediate data inputs per node. For ComboAttack this returns maybe 20-30 nodes at depth 15 = ~1500 tokens.

**Total: ~1850 tokens.** Compared to full `get_blueprint_graph` dump: ~10K tokens for a BP this size. **5× savings**, and Claude gets answers in the shape of the question (an execution narrative) rather than a JSON soup.

### Scenario 2: "Why is the HitReaction montage not playing?"

1. `bp_find_in_graph("BP_OSCharacter", "EventGraph", {type: "call_function", member_name: "PlayMontage*"})` → finds the relevant node, say `N47`. ~100 tokens.
2. `bp_show_node("BP_OSCharacter", "EventGraph", "N47")` → full node with pin-level inputs resolved. Reveals the `Montage` pin is fed by `N46`. ~300 tokens.
3. `bp_trace_data("BP_OSCharacter", "EventGraph", "N46.P2", direction="back", max_depth=5)` → source of the montage value. Maybe it's a `Select`/`Switch` keyed off `HitReactionType`. ~500 tokens.
4. Claude now knows whether the input is coming from a valid source or a null path. ~900 tokens total.

**Works cleanly.**

### Scenario 3: "Is the 'IsStunned' tag ever removed in this ability?"

1. `bp_find_in_graph("GA_OSStun", "EventGraph", {type: "call_function", member_name: "RemoveLooseGameplayTag"})` — hits zero nodes if the designer used a `RemoveGameplayEffectFromTarget` call with a GE that applied the tag. **Coverage gap, not verb gap.**
2. Workaround: `bp_find_in_graph` with a broader predicate (`{type: "call_function"}` filtered by category "GameplayEffects") — still won't resolve to "the tag is removed" without inspecting the referenced GE asset, which is a different BP.

**Verdict on scenario 3:** The nine verbs do what they claim (find-and-trace within one graph), but answering tag-lifecycle questions fundamentally requires cross-BP reasoning that belongs to a different tool (asset-dependency + GE-introspection via Track 2a and/or Phase 4 Remote Control). This is not a defect in the amendment; it's a scope boundary that the amendment should call out to prevent Claude from concluding "the tag is never removed" when really it's removed by a GE in a sibling asset.

### Verdict on the nine verbs

| Verb | Keep in v1 | Reasoning |
|---|---|---|
| `bp_list_graphs` | ✅ | Cheap, foundational, every session uses it |
| `bp_list_entry_points` | ✅ | Cheap, scenario 1 makes the case |
| `bp_trace_exec` | ✅ | The core verb; this is what "read the picture" means |
| `bp_trace_data` | ✅ | Scenario 2 makes the case |
| `bp_show_node` | ✅ | Detail-view; trivial to implement on the cached dump |
| `bp_neighbors` | ✅ | Low cost, high utility for "what's around this" |
| `bp_subgraph_in_comment` | ✅ | Justifies the `contains[]` pre-compute in the amendment — ship together |
| `bp_paths_between` | ⚠️ **Defer to v1.1** | Most expensive to get right (cycle handling, path pruning, `max_paths` tuning); least-used verb in the scenario walks. Defer, observe which real questions actually need it. |
| `bp_find_in_graph` | ✅ | Scenarios 2 & 3 both lead with it — foundational for any non-entry-point starting question |

**One missing coverage dimension, not a missing verb:** the amendment needs an explicit note that tag-lifecycle and GE-composed state questions require cross-BP tools outside the nine. Not a verb to add; a caveat to document in the tool descriptions so Claude knows when to stop trying.

**Net:** ship 8 of 9 verbs in v1, defer `bp_paths_between` to v1.1 when we have real usage data.

---

## Q5 — Interaction with Track 2a (offline asset-registry parser)

Track 2a reads the FAssetRegistryData tag block directly from `.uasset` files and exposes `query_asset_registry`, `inspect_blueprint` (registry-level: class, parent, interfaces), and `list_level_actors`. It is intentionally shallow — it does not walk graphs.

The sidecar reader can cheaply cross-check sidecar-claimed identity (`metadata.name`, `metadata.class`, `metadata.path`) against the same fields extracted by Track 2a. This defends against sidecar-staleness failure mode #8 (sidecar stranded at old path after rename — though we decided that's acceptable drift) and against the more exotic case of a copy-paste error where someone duplicates a sidecar next to the wrong `.uasset`.

**Verdict on value**: defensive coding for a rare case. Worth doing when the cost is ~10 LOC (and it is — two field comparisons and an error branch), not worth doing if it adds coupling that complicates Phase 3 landing. It does not add meaningful coupling: the sidecar reader already reads the `.uasset`'s mtime, and Track 2a's inspection is an in-memory function call. Recommend: do the cross-check, log a warning on mismatch, ignore the sidecar. Don't make it a hard requirement until we see mismatches in the wild.

---

## Q6 — What we're committing to by shipping sidecars in v1

With sidecars as the primary read path (Q1 rewritten per Noah's direction), the honest accounting of what this costs is worth writing down explicitly so nobody is surprised in Phase 3.

**Complexity bought upfront**:
- Delegate selection and its edge cases (Q2) must be right at v1 — no "observe in production and tune later."
- Atomic-rename write pattern is required from day one (Q3 failure mode #9 is user-facing when Claude Code is reading concurrent with a save).
- Schema version migration is a v1 concern — the first schema bump will invalidate every sidecar in every project; `prime_bp_cache` is the recovery mechanism and must be robust. Auto-prime on empty-cache detection (Q1b) makes schema-bump recovery silent from the developer's perspective.
- Repo policy (single `Saved/UEMCP/` entry in `.gitignore` / `.p4ignore`) must be in the v1 PR. Near-trivial given the Saved/ location choice (Q1a), but the belt-and-suspenders line goes in the initial PR to document intent for future contributors.
- Dirty-editor handling (`bp_is_dirty` probe, Q3 failure mode #4) is part of v1, not a later add — concurrent developer-edits-while-Claude-reads is a primary workflow.
- Auto-prime-on-first-launch behavior (Q1b) must be correct at v1 — specifically, the "detect empty cache" check must be cheap and must not block editor readiness.

**Complexity NOT bought upfront** (still deferrable):
- `bp_paths_between` — Q4 case for deferring stands.
- `prime_bp_cache` polish (progress bar, resumability, cancellation) — the basic version must work in v1; UX polish can iterate.
- AnimBP / Material / Widget spatial verbs — amendment already defers these; research does not change that.

**What the sidecar-first choice gives us that TCP-only would not**:
- Claude Code works on a project without the editor running. That is the use case; nothing else delivers it.
- Sub-10-ms read latency per verb call — meaningful when Claude is composing verbs in a loop (`bp_show_node` on 10 nodes to understand a scene).
- Graceful degradation path: when the sidecar is missing and the editor is offline, the honest error (`no_sidecar_and_editor_offline`) hints at `prime_bp_cache`. When the editor is available, the read self-heals by priming the sidecar on-demand.

**The risk I'd call out loudest**: the `UPackage::PackageSavedEvent` handler is running on the game thread inside the editor's save flow. A bug there — infinite loop, hang on a locked file, exception that bubbles — is noticeable to the developer because it stalls saves. The mitigations in Q2 (hard time cap, bool-returning file I/O, skip-on-failure) are not optional polish; they're load-bearing. Phase 3 test plan must include an explicit "save hook under adverse conditions" suite: read-only disk, disk full, 2000-node BP, concurrent save from a second editor instance.

---

## Summary for the Phase 3 inputs bucket

If bucket 3F lands with the following shape, the amendment's capability ships on time and the risk surface is right-sized:

**v1 (ship together, required for primary use case — Claude Code against offline editor):**
- **3F-1**: `dump_graph` TCP command on :55558. Implements the parent spec format + the spatial additions + `comments[]` pre-computed `contains[]`.
- **3F-1-dirty**: cheap `bp_is_dirty` TCP probe. Needed to correctly handle Q3 failure mode #4.
- **3F-2**: Save hook on `UPackage::PackageSavedEvent`, filtered for BPs, atomic-rename write, writes to `Saved/UEMCP/BPCache/` mirror tree (Q1a), freshness key includes schema version.
- **3F-3**: `prime_bp_cache` editor command, auto-invoked on first editor load when cache is empty (Q1b), gated by default-on `bAutoPrimeBlueprintCache` setting.
- **3F-verbs**: eight of the nine verbs (defer `bp_paths_between`).
- **Repo policy**: `Saved/UEMCP/` in `.gitignore` and `.p4ignore` in the v1 PR.

**v1.1 (deferrable without breaking the primary use case):**
- **3F-4**: `bp_paths_between` verb, after real usage shows demand.
- **3F-3-polish**: `prime_bp_cache` UX improvements (progress bar, resumability, cancellation).
- AnimBP / Material / Widget spatial verbs (already deferred by the amendment).

**Documentation additions (v1 PR):**
- Call out in tool descriptions that tag-lifecycle and GE-composed state questions require cross-BP reasoning beyond the nine verbs. Direct Claude to Track 2a tools for class-level questions when the editor is offline.
- Document the `Saved/UEMCP/BPCache/` location and its `prime_bp_cache` recovery path in the plugin README so developers know where the cache lives and how to nuke it.

**Test suite requirement (v1):** "save hook under adverse conditions" — read-only disk, disk full, 2000-node BP, concurrent save from a second editor instance, schema-version mismatch on read, cache-wipe-then-auto-prime on next editor launch.
