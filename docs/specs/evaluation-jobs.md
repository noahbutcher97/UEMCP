# Registered evaluation workloads

Attach to the project and call `list_evaluation_workloads` to discover its workload kinds, registered versions, input/result schemas, execution modes, time limits and prerequisites. Submit `start_evaluation_job` with a stable `request_id`, the selected `kind`, its optional integer `version` and an `inputs` object matching that schema. A request can also use the legacy top-level spacing arguments. Choose one argument form per submission.

The worker records the normalized inputs, version and a fingerprint of the implementation binding and schemas. Retries with an equivalent object field order or an explicitly written default resolve to the same request. Old queued spacing and PPO records select version 1. A changed or missing registration produces a terminal diagnostic for pending work. Previously completed results can be retrieved after uninstalling an extension. The service limits normalized requests to 60 KiB and results to 768 KiB.

Attach the project that owns the saved config and map. Use `start_evaluation_job` with a caller-chosen `request_id`, `config`, `map` and a nonnegative int32 `seed`. After reconnecting to the same project, use the returned `job_id` with `get_evaluation_job` or `get_evaluation_result`. If the submission reply was lost, repeat the original request with the same ID and arguments.

The Win64 worker launches the project's installed editor commandlet. A numeric launcher association selects its matching installation. Set `UE_ENGINE_ROOT` in the MCP server environment for custom locations. Build the UEMCP plugin for the project first. An editor window and a TCP listener are unnecessary for evaluation. An interactive editor can remain open when evaluating saved inputs.

## Workloads

- `player_start_spacing` loads the two saved project packages. The DataAsset supplies a finite, nonnegative floating `Settings.Threshold` in metres. The map must contain 2–256 unattached PlayerStarts in one persistent level. External actors, partitioned and streaming levels, and split cooked packages fall outside this contract. Each start passes when its nearest other start is at least the threshold away. The seed orders the observations. This static geometry calculation uses stored positions without world simulation or rendering.
- `train_spacing_policy` uses those observations in a two-action contextual bandit. A clipped PPO update trains a logistic accept/reject policy for the specified `steps` (32–8192). The terminal result contains the input digests, feature definition, seed, step count, weights and mean reward. It can be read after restarting the MCP server.
- `physics_joint_response` takes a saved PhysicsAsset `asset`, `joint` and optional `steps` (1–3,600, default 180). The asset needs a preview skeletal mesh and a valid child body. Its commandlet advances a private zero-gravity Chaos physics scene at 120 steps per second. It holds the parent fixed, isolates the selected constraint and applies a child angular velocity of 2 radians per second around its twist axis once per step. Read initial, peak absolute and final twist in degrees, step count and timestep in the result. Job progress records the engine build and digest of the submitted asset.

## Installing a project workload

A native editor module implements [UUEMCPNativeWorkload](../../plugin/UEMCP/Source/UEMCP/Public/UEMCPNativeWorkload.h). Return a stable kind and version, and implement `Evaluate` using the typed inputs. A built and enabled project module or plugin provides the class to Unreal. Install a UTF-8 manifest alongside the exact project file, for example `Example.uproject.uemcp-workloads.json`. Both discovery and a fresh worker resolve it against that project. Two project files in one directory can have different registrations.

```json
{
  "schema_version": 1,
  "workloads": [{
    "kind": "project_measurement",
    "version": 1,
    "description": "Square the supplied length.",
    "mode": "commandlet",
    "handler": "/Script/WorkloadSample.ProjectMeasurement",
    "input_schema": {
      "type": "object",
      "properties": { "length": { "type": "number" } },
      "required": ["length"],
      "additionalProperties": false
    },
    "result_schema": {
      "type": "object",
      "properties": { "square": { "type": "number" } },
      "required": ["square"],
      "additionalProperties": false
    }
  }]
}
```

Choose a distinct kind for every installed definition. Pin changed behavior or schema to a new version before accepting submissions. Use a strict object input schema with declared defaults. Declare file inputs with `package_inputs`, for example `{"asset":".uasset"}`; supported extensions are `.uasset` and `.umap`. The native runner verifies each declared package digest under a read lease through execution. It checks the installed class's kind and version before calling its implementation and validates the returned object against the declared schema. The manifest limit is 32 definitions and 64 KiB.

## CLI discovery and execution

Run `node server/evaluation-cli.mjs --help` for the full syntax. `list PROJECT.uproject` prints the same catalog as MCP. `start PROJECT.uproject REQUEST_ID KIND INPUTS_JSON [VERSION]` returns a durable ID. Use `status`, `result` or `cancel` with the project file and ID from another process. `run PROJECT.uproject KIND INPUTS_JSON NEW_OUTPUT_DIRECTORY [VERSION]` waits for completion and writes the JSON result to stdout. The legacy spacing CLI retains its positional arguments and result shape.

Each result identifies the Unreal build, resolved packages and SHA-256 fingerprints. The commandlet holds read leases on the inputs while loading and hashing them. Save editor changes before submission to include them. Conflicting writers, changed files, unsupported inputs and abnormal child exits produce a failed job.

## Recovery and cancellation

Work is serialized per project. The first process to claim a request owns its one execution. A new server can recover an acknowledged or unacknowledged registration. Reusing a request ID with different arguments returns `REQUEST_CONFLICT`. If a claimed worker dies, the caller receives a terminal failure. Use a new request ID for a deliberate rerun.

On Windows the local process provider starts a hidden supervisor independently of the MCP client's process tree. A Windows job object bounds its descendants' lifetime. The launcher requires access to the local Windows process provider. A poll may restart a registered queue after interruption. `recovering` means the current client could not verify the previous owner. A durable terminal decision resolves that state. `cancel_evaluation_job` arbitrates with completion and returns `cancelling` while an active worker shuts down. Poll until terminal.

The project stores job records and available commandlet logs under `Saved/UEMCP/EvaluationJobs`, partitioned by the canonical project file. Keep the records while clients need to reconnect. The fixed native runner is also available directly:

```text
node server/run-spacing-evaluation.mjs PROJECT.uproject /Game/Evaluation/DA_Config /Game/Evaluation/Map 17 NEW_OUTPUT_DIRECTORY
```

The CLI writes the terminal result to stdout, returns a nonzero exit code on failure and stores its Unreal log in the new output directory. See the [unit plan and qualification](../plans/editor-workflow-gaps.md#4-run-an-evaluation-headlessly).
