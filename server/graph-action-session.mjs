import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const holdTriggerWiring = 'For a repeating Hold trigger, set a held flag on Started (press). Clear it on both Completed (release after the hold triggers) and Canceled (early release).';

export const graphActionAssetPath = z.string().regex(/^\/[^/]+\/[^/].*$/, 'Supply an absolute Unreal asset path, for example /Game/Characters/BP_Player.');

const rediscoverableErrors = new Set([
  'STALE_GRAPH_REVISION', 'STALE_GRAPH_ACTION', 'CONFLICTING_INPUT_BINDING',
  'PLACEMENT_POSTCONDITION_FAILED', 'PLACEMENT_OUTCOME_UNCONFIRMED',
]);

// An action belongs to the MCP attachment that discovered it. The editor checks
// these private fields on the game thread alongside the graph and source asset.
export function createGraphActionSender(projectContext, connectionManager) {
  const sessionId = randomUUID();
  return async (toolName, args) => {
    const generation = projectContext.generation;
    const projectFile = projectContext.identity?.uprojectPath;
    if (!projectFile) throw new Error('Attach the target Unreal project before discovering graph actions.');
    const params = {
      ...args,
      attachment_id: `${sessionId}/${generation}`,
      expected_project_file: projectFile,
    };
    let dispatched = false;
    const beforeDispatch = () => {
      if (projectContext.generation !== generation) throw new Error('Project attachment changed. Run find_graph_actions again.');
      dispatched = true;
    };
    try {
      const reply = await connectionManager.send('tcp-55558', toolName, params, { skipCache: true, beforeDispatch });
      if (toolName === 'place_graph_action' && reply?.result?.node_class === '/Script/InputBlueprintNodes.K2Node_EnhancedInputAction') {
        return { ...reply, result: { hold_trigger_wiring: holdTriggerWiring, ...reply.result } };
      }
      return reply;
    } catch (error) {
      if (!error.wireError && (!dispatched || toolName !== 'place_graph_action')) throw error;
      const { code, message, detail } = error.wireError ?? {
        code: 'PLACEMENT_OUTCOME_UNCONFIRMED',
        message: `No editor result confirms whether the node was placed. ${error.message}`,
      };
      error.graphActionResult = {
        ok: false,
        code,
        message: code === 'UNKNOWN_COMMAND'
          ? `The attached editor plugin does not implement ${toolName}. Sync the matching UEMCP plugin to the attached project, rebuild its editor target, restart the editor and reconnect.`
          : message,
        ...(detail === undefined ? {} : { detail }),
      };
      if (toolName === 'place_graph_action' && rediscoverableErrors.has(code)) {
        const sourcePath = detail?.source_asset_path;
        error.graphActionResult.rediscover = {
          tool: 'find_graph_actions',
          arguments: {
            asset_path: args.asset_path,
            graph_guid: args.graph_guid,
            ...(typeof sourcePath === 'string' ? { source_asset_path: sourcePath } : {}),
          },
          instruction: 'Use the exact source_asset_path from the selected action, including an empty string for an empty player. Compare placed_nodes with your pre-edit node GUIDs before retrying.',
        };
      }
      throw error;
    }
  };
}
