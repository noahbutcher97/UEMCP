# Blueprint Authoring Reliability Design

## Goal

Make Blueprint authoring reliable enough for repeatable agent workflows by prioritizing lifecycle truth, variable/default ergonomics, timer authoring, PIE runtime verification, and one live timer-mover acceptance smoke.

## Current State

The Blueprint write surface can create Blueprints, add components, add graph-targeted nodes, author variable assignments, validate pin compatibility, compile assets, spawn actors, start PIE, read PIE session state, read PIE actor state, and sample PIE actor state. Recent live smoke verified `sample_pie_actor_state` against an open editor, including create/compile/spawn/PIE/sample/cleanup.

The remaining risk is not raw connectivity. The risk is that higher-level Blueprint behavior depends on lower-level postconditions that are still uneven: compile diagnostics, save/dirty state, generated-class readiness, CDO/default values, and runtime-world verification.

## Priority Order

1. Blueprint lifecycle correctness.
2. Blueprint variable/default/assignment workflows.
3. Timer/callback authoring helper.
4. PIE runtime verification hardening.
5. Timer-mover live acceptance smoke.

Timer-mover is the acceptance scenario, not the first implementation target. It should prove the lower-level tools work together after lifecycle, variable, and timer primitives are solid.

## Design Principles

- Prefer canonical low-level tools over single-purpose demo helpers.
- Keep live PIE verification separate from editor-world actor reads.
- Treat dirty/save/compile/generated-class state as explicit postconditions.
- Keep server-side composites for wait/sampling workflows that must allow Unreal to tick.
- Use tracked docs for durable specs and reports; keep local orchestrator state untracked.

## Lifecycle Design

Blueprint lifecycle work should converge the user-facing compile path on diagnostic truth. `compile_blueprint` and `bp_compile_and_report` currently overlap, but the diagnostic-quality behavior belongs in a canonical path that reports:

- `succeeded` and `compiled_ok`
- `num_errors`, `num_warnings`, and structured messages
- generated-class status
- package path and dirty state after compile
- whether the asset was saved, left dirty, or not saveable

`compile_blueprint` is the canonical diagnostic compile surface for Blueprint writes. `bp_compile_and_report` remains as a compatible read-toolset entry point that uses the same diagnostic result shape. Lifecycle implementation should add two explicit persistence surfaces:

- `save_asset` for a generic editor asset save with dirty-state reporting
- `compile_and_save_blueprint` for the common Blueprint workflow: compile, fail on compile errors unless explicitly overridden, save on success, and return both compile diagnostics and save result

All new response fields must be additive. Existing callers that only check `compiled`, `succeeded`, or `compiled_ok` must keep working.

## Variable Design

Variable authoring should support both member-definition defaults and graph assignments. The minimum target is:

- create supported variable types with exposed/editable flags
- set member defaults for scalar and vector values when Unreal supports the type safely
- add graph assignments from literal values
- add graph assignments from another variable
- return pin metadata, graph name, compile requirement, and any unsupported-default reason

Unsupported defaults must fail with structured errors or return an explicit unsupported list. Silent success is not acceptable.

## Timer Design

Timer authoring should be a focused helper over K2 graph primitives. It should create a safe timer setup on BeginPlay and target either an existing function graph or a callback function it creates. The helper should expose:

- Blueprint path/name
- callback function name
- time/rate
- looping flag
- optional BeginPlay insertion
- optional compile flag

The helper must avoid hiding graph failures. It should return created node IDs, graph names, link results, and `requires_compile`.

## PIE Verification Design

PIE runtime verification should use `get_pie_session_state`, `get_pie_actor_state`, and `sample_pie_actor_state`. The verification pattern must:

- stop any pre-existing PIE session before a destructive live smoke
- start PIE and wait for an active PIE world
- wait for a stable initial actor transform before measuring movement
- sample runtime actor state over time
- assert expected axis movement and distance bounds
- always stop PIE and verify `pie_running:false`
- delete temporary actors and assets

The stability wait exists because live sampling observed a short post-PIE-start transform settle from `[0,0,0]` to the spawned transform.

## Acceptance Scenario

The final acceptance smoke creates a temporary Blueprint actor under `/Game/UEMCP`, adds a visible static mesh component, exposes axis/speed/distance variables, creates timer-driven movement logic, spawns the actor, starts PIE, samples runtime state, verifies nonzero movement along the configured axis, stops PIE, and deletes all temporary artifacts.

The smoke should be opt-in with `UEMCP_LIVE_SMOKE=1`, require `UNREAL_PROJECT_ROOT`, and print concise PASS/CLEAN lines. It should fail if cleanup cannot verify PIE stopped.

## Parallelization

Core implementation is sequential because each layer depends on the prior layer:

1. Lifecycle.
2. Variables.
3. Timer.
4. PIE hardening.
5. Timer-mover smoke.

Safe side work can run in parallel only if it does not change the same production files:

- current docs/count updates
- read-only audit of existing Blueprint write behavior
- fixture-only test scaffolding
- final report synthesis after implementation

## Success Criteria

- Full server rotation passes with `UNREAL_PROJECT_ROOT` set to the target Unreal project root.
- Registry truthfulness remains green.
- No new active YAML tool is discoverable without a callable Node implementation.
- Live smoke passes against an open editor and cleans up temporary assets.
- If plugin C++ changes are made, manifest and `.uplugin` versions are bumped, the target project is synced, Unreal is rebuilt, and `verify-deploy.bat --no-pause` reports `ALL-SYNC`.

## Non-Goals

- No GAS authoring implementation.
- No data-asset writer implementation.
- No broad visual-capture expansion.
- No new high-level one-off “make timer mover” tool before lifecycle, variable, and timer primitives are reliable.
- No commit of local orchestrator state or machine-local target files.

## Open Risks

- Some variable defaults may require type-specific C++ handling rather than generic property assignment.
- Compile/save behavior may differ between Blueprint, Widget Blueprint, and generated-class refresh paths.
- Long-running or blocking C++ wait loops would prevent PIE from ticking; wait/sampling loops should stay in Node unless there is a clear asynchronous plugin design.
- Multi-PIE identity and level-instance matching still need empirical coverage after single-PIE behavior is stable.
