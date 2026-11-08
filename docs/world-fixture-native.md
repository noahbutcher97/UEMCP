# Owned World native fixture

The World fixture is an explicit, supervisor-managed UE 5.6 qualification lane. It authors a unique owned map and reads it in a separate fresh process. It is excluded from ordinary broad automation discovery because the author case writes an asset.

The exact cases are:

- `UEMCP.WorldMapFixture.AuthorMap`
- `UEMCP.WorldMapFixture.ReloadAndReadOracle`

The native runner's default `UEMCP` filter and existing named profiles retain their prior behavior. These World cases are enumerated only when the first startup `ExecCmds` command is `Automation RunTests <exact-name>` (or the engine's `RunTest` alias). A `+` list of full names and paired `^<exact-name>$` selectors are recognized. Partial names, `StartsWith:`, groups, `RunAll`, later commands and interactive console selection do not opt this fixture in. Use the supervisor's single-phase startup command followed by `;Quit` in a new process.

This is discovery admission, not launch authority. Exact requests remain discoverable even when their phase, IDs or required flags are absent or invalid, so execution reports the authority error. On engines other than 5.6, the same exact names execute failure handlers reporting an unsupported engine. They do not compile the 5.6 package reader or report a successful skip. The reader retains its UE4=522 / UE5=1017 layout assertion and runtime engine-minor validation; support for another package layout requires a separate review.

## Supervisor prerequisites

Run only through the reviewed supervisor and existing native coordination contract. A native-runner `--filter` selection alone does not supply these prerequisites:

- Exact `UEMCPWorldRun`, `UEMCPWorldStage` and `UEMCPWorldAttempt` arguments containing unique lower-case 32-hex IDs.
- `UEMCPWorldPhase=author` or `UEMCPWorldPhase=reload`, plus `-NullRHI -NoSound -Unattended`.
- A matching `Saved/UEMCPWorld/<run>/<phase>.authority.json` with schema `owned-world-authority-v1` and exact `run_id`, `stage_id`, `attempt_id`, `phase` and `project_dir` fields. The marker alone is insufficient launch authority.
- An independently attested physical non-reparse project/output path, source and compiled-plugin identities, process ownership, bounded execution, required report names and cleanup.

Author requires its unique `/Game/__UEMCPWorld/<run>/L_PlacedActors` path and output/sidecar paths to be absent. Reload requires a new process, a distinct attempt ID, an unloaded package, the exact author receipt and immutable authored bytes. Both phases retain exclusive output creation and their existing ownership checks. The supervisor must reject missing cases, error events, labelled skips and empty reports rather than accepting an unrelated successful test.

## Validation boundaries

`node server/test-world-fixture-native-source.mjs` runs portable source contracts and required-report rejection controls without an engine, project, private assets or native execution. It does not execute C++ discovery, compile the plugin, or qualify author/reload behavior.

The supported-engine build/package matrix and actual 5.6 author/separate-reload evidence must bind the final integrated source. Historical receipts remain valid only at their original bindings. Prior 134-export/64-marker evidence does not eliminate the 129 inherited-default transform residuals or establish original consumer equivalence, registry diversity/performance, rendered capture or full persistence. The task-only supervisor and its private execution evidence are not repository artifacts.
