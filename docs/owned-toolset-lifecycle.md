# Owned offline toolset lifecycle

Run `node server/run-rotation.mjs --test-profile owned-toolset-lifecycle --json`
for 18 required named cases. The profile is additive and engine-free. It does not
replace or remove `test-phase1.mjs` or any consumer/legacy contract.

The fixture creates one temporary `OwnedToolsetLifecycle.uproject` with a Content
directory, authored descriptor bytes, and an empty workspace. It initializes
unresolved before writing the descriptor, then explicitly attaches it. The real
ProjectContext, ConnectionManager, ToolIndex and ToolsetManager run with explicit
`env: {}`, fixed connection configuration and injected TCP/HTTP-down responders.
Tool visibility is observed through registered simulated SDK handles. All scratch
data is removed through the repository's canonical scratch-root helper in finally.

## Bounded witness mapping

| Inventory witness | New owned witness |
|---|---|
| P1 / phase1 “ProjectContext attachment enables offline” | Explicit attachment enables offline with the independently authored project name, root, descriptor path, generation 1 and visible offline handles. |
| P2 / “offline disabled successfully” | Disable result and hidden handles while the full project snapshot remains unchanged and offline availability remains true. |
| P3 / “offline re-enabled successfully” | Explicit re-enable result and restored handles with unchanged project identity/generation. |
| P4 / “offline in enabled set” | Complete unresolved/attach/disable/re-enable cycle ends with exactly `['offline']`. |

Extra controls cover unresolved rejection even when a configured root is readable,
missing/no-descriptor roots, a removed descriptor after a fresh availability check,
failed replacement attachment, transition back to unresolved context, repeated
enable/disable without extra notifications, and unavailable live toolsets. Three
authored offline sentinel names prevent an empty index from passing visibility
checks. Comparator controls first accept a valid view, then reject wrong identity,
generation drift, missing enabled state, a hidden sentinel or wrong connection root.

## Limits and retained obligations

Classification: **retain: partial**. This is manager-level offline lifecycle proof.
The test explicitly synchronizes managers on ProjectContext resets; it does not
qualify the production server's reset callback, actual MCP tools/list transport,
SDK notification batching, editor connectivity, consumer assets, or native behavior.
Existing project-server-wire and connection-reset tests remain supporting checks.
Explicit-env server bootstrap, text-project handlers/MCP wire, registry budgets
and metadata harness isolation belong to separate migration units.

Run the profile and related regressions with the ambient project variables cleared,
with an invalid root only, and with invalid root plus explicit env mode. The suite's
own explicit environment must keep the result identical. Retain the known invalid
ambient failures in legacy phase1/consumer suites visibly; do not rewrite them into
skips or claim blanket equivalence from these 18 witnesses. No retirement approved.
