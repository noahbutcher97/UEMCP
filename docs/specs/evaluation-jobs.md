# Saved player-start evaluations

Attach the project that owns the saved config and map. Use `start_evaluation_job` with a caller-chosen `request_id`, `config`, `map` and a nonnegative int32 `seed`. After reconnecting to the same project, use the returned `job_id` with `get_evaluation_job` or `get_evaluation_result`. If the submission reply was lost, repeat the original request with the same ID and arguments.

The Win64 worker launches the project's installed editor commandlet. A numeric launcher association selects its matching installation. Set `UE_ENGINE_ROOT` in the MCP server environment for custom locations. Build the UEMCP plugin for the project first. An editor window and a TCP listener are unnecessary for evaluation. An interactive editor can remain open when evaluating saved inputs.

## Workloads

- `player_start_spacing` loads the two saved project packages. The DataAsset supplies a finite, nonnegative floating `Settings.Threshold` in metres. The map must contain 2–256 unattached PlayerStarts in one persistent level. External actors, partitioned and streaming levels, and split cooked packages fall outside this contract. Each start passes when its nearest other start is at least the threshold away. The seed orders the observations. This static geometry calculation uses stored positions without world simulation or rendering.
- `train_spacing_policy` uses those observations in a two-action contextual bandit. A clipped PPO update trains a logistic accept/reject policy for the specified `steps` (32–8192). The terminal result contains the input digests, feature definition, seed, step count, weights and mean reward. It can be read after restarting the MCP server.

Each result identifies the Unreal build, resolved packages and SHA-256 fingerprints. The commandlet holds read leases on the inputs while loading and hashing them. Save editor changes before submission to include them. Conflicting writers, changed files, unsupported inputs and abnormal child exits produce a failed job.

## Recovery and cancellation

Work is serialized per project. The first process to claim a request owns its one execution. A new server can recover an acknowledged or unacknowledged registration. Reusing a request ID with different arguments returns `REQUEST_CONFLICT`. If a claimed worker dies, the caller receives a terminal failure. Use a new request ID for a deliberate rerun.

On Windows the local process provider starts a hidden supervisor independently of the MCP client's process tree. A Windows job object bounds its descendants' lifetime. The launcher requires access to the local Windows process provider. A poll may restart a registered queue after interruption. `recovering` means the current client could not verify the previous owner. A durable terminal decision resolves that state. `cancel_evaluation_job` arbitrates with completion and returns `cancelling` while an active worker shuts down. Poll until terminal.

The project stores job records and available commandlet logs under `Saved/UEMCP/EvaluationJobs`, partitioned by the canonical project file. Keep the records while clients need to reconnect. The fixed native runner is also available directly:

```text
node server/run-spacing-evaluation.mjs PROJECT.uproject /Game/Evaluation/DA_Config /Game/Evaluation/Map 17 NEW_OUTPUT_DIRECTORY
```

The CLI writes the terminal result to stdout, returns a nonzero exit code on failure and stores its Unreal log in the new output directory. See the [unit plan and qualification](../plans/editor-workflow-gaps.md#4-run-an-evaluation-headlessly).
