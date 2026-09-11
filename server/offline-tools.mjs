// offline-tools.mjs — façade for the offline toolset. Owns the tool-name
// dispatch (executeOfflineTool) and re-exports the surface that tests and
// create-uemcp-server.mjs import. Implementation lives in:
//   offline-core.mjs            shared leaf (paths, cache, header/property parse)
//   offline-project-tools.mjs   project, config, plugins, data sources, tags
//   offline-asset-tools.mjs     registry, asset info, exports, properties, actors
//   offline-blueprint-tools.mjs bp_* graph verbs and node search

import {
  projectInfo,
  listGameplayTags,
  searchGameplayTags,
  listConfigValues,
  listDataSources,
  readDatatableSource,
  readStringTableSource,
  listPlugins,
  getBuildConfig,
} from './offline-project-tools.mjs';
import {
  getAssetInfo,
  queryAssetRegistry,
  inspectBlueprint,
  listLevelActors,
  listAssetExports,
  readAssetProperties,
} from './offline-asset-tools.mjs';
import {
  findBlueprintNodes,
  findBlueprintNodesBulk,
  bpListGraphsSafe,
  bpFindInGraphSafe,
  bpSubgraphInCommentSafe,
  bpListEntryPointsSafe,
  bpShowNodeSafe,
  bpTraceExecSafe,
  bpTraceDataSafe,
  bpNeighborsSafe,
} from './offline-blueprint-tools.mjs';

export {
  buildPropertyReadHandlers,
  resetOfflineAssetCache,
  shouldRescan,
  assetCache,
  resolveAssetDiskPath,
  parseAssetHeader,
  withAssetExistenceCheck,
} from './offline-core.mjs';
export { matchTagGlob } from './offline-project-tools.mjs';
export {
  collectSubobjectExportIndexes,
  summarizeCollisionProperties,
  buildSubobjectResponseRow,
} from './offline-asset-tools.mjs';
export {
  computeCommentContainment,
  extractBPEdgeTopologySafe,
} from './offline-blueprint-tools.mjs';

export async function executeOfflineTool(toolName, params, projectRoot) {
  if (!projectRoot) {
    throw new Error('Project root not configured — offline tools require an attached project path');
  }

  switch (toolName) {
    case 'project_info':
      return await projectInfo(projectRoot);

    case 'list_gameplay_tags':
      return await listGameplayTags(projectRoot);

    case 'search_gameplay_tags':
      if (!params.pattern) throw new Error('Missing required parameter: pattern');
      return await searchGameplayTags(projectRoot, params.pattern);

    case 'list_config_values':
      return await listConfigValues(projectRoot, params.config_file, params.section, params.key);

    case 'get_asset_info':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await getAssetInfo(projectRoot, params.asset_path, params);

    case 'query_asset_registry':
      return await queryAssetRegistry(projectRoot, params);

    case 'inspect_blueprint':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await inspectBlueprint(projectRoot, params);

    case 'list_level_actors':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await listLevelActors(projectRoot, params);

    case 'list_asset_exports':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await listAssetExports(projectRoot, params);

    case 'read_asset_properties':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await readAssetProperties(projectRoot, params);

    case 'find_blueprint_nodes':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await findBlueprintNodes(projectRoot, params);

    case 'find_blueprint_nodes_bulk':
      return await findBlueprintNodesBulk(projectRoot, params);

    case 'bp_list_graphs':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpListGraphsSafe(projectRoot, params);

    case 'bp_find_in_graph':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpFindInGraphSafe(projectRoot, params);

    case 'bp_subgraph_in_comment':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpSubgraphInCommentSafe(projectRoot, params);

    case 'bp_list_entry_points':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpListEntryPointsSafe(projectRoot, params);

    case 'bp_show_node':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpShowNodeSafe(projectRoot, params);

    case 'bp_trace_exec':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpTraceExecSafe(projectRoot, params);

    case 'bp_trace_data':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpTraceDataSafe(projectRoot, params);

    case 'bp_neighbors':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpNeighborsSafe(projectRoot, params);

    case 'list_data_sources':
      return await listDataSources(projectRoot);

    case 'read_datatable_source':
      if (!params.file_path) throw new Error('Missing required parameter: file_path');
      return await readDatatableSource(projectRoot, params.file_path, params.row_struct_header);

    case 'read_string_table_source':
      if (!params.file_path) throw new Error('Missing required parameter: file_path');
      return await readStringTableSource(projectRoot, params.file_path);

    case 'list_plugins':
      return await listPlugins(projectRoot);

    case 'get_build_config':
      return await getBuildConfig(projectRoot);

    default:
      throw new Error(`Unknown offline tool: ${toolName}`);
  }
}
