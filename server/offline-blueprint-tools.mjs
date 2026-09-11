// offline-blueprint-tools.mjs — the offline Blueprint graph verbs: node search
// (single and bulk), graph listing, comment subgraphs, entry points, node
// detail, exec/data tracing and neighbors, all over the S-B-base edge-topology
// parser. Every public verb is wrapped by withAssetExistenceCheck so a missing
// asset returns {available:false} instead of throwing.

import {
  resolvePackageIndex,
  readExportProperties,
  pinBlockLayoutForPackage,
  formatFName,
  resolveLinkedToEdges,
} from './uasset-parser.mjs';
import {
  parseAssetHeader,
  stripPackageIndex,
  parseAssetForPropertyRead,
  withAssetExistenceCheck,
} from './offline-core.mjs';
import { queryAssetRegistry } from './offline-asset-tools.mjs';

/**
 * find_blueprint_nodes — Agent 10.5 Tier 4 (D48 S-A skeletal surface).
 *
 * Walk K2Node exports in a Blueprint, extract semantic references from each
 * node's tagged-property stream, and apply class/member/target filters.
 * Covers 19 skeletal K2Node classes (17 non-delegate + 2 delegate-presence).
 * Does NOT trace exec chains — pin edges aren't parseable from offline bytes
 * and live in the 3F sidecar.
 *
 * Semantic field extraction reuses the tier-3 tagged-property fallback —
 * FMemberReference / FGraphReference / FUserPinInfo all decode through
 * readExportProperties without special handler registration.
 */
const SKELETAL_K2NODE_CLASSES = new Set([
  // Entry / event
  'K2Node_Event', 'K2Node_CustomEvent',
  'K2Node_FunctionEntry', 'K2Node_FunctionResult',
  // Variable access
  'K2Node_VariableGet', 'K2Node_VariableSet',
  // Function call
  'K2Node_CallFunction', 'K2Node_CallParentFunction',
  // Control flow
  'K2Node_IfThenElse', 'K2Node_ExecutionSequence',
  'K2Node_SwitchEnum', 'K2Node_SwitchString', 'K2Node_SwitchInteger',
  'K2Node_DynamicCast', 'K2Node_MacroInstance',
  // Literal / passthrough
  'K2Node_Self', 'K2Node_Knot',
  // Delegate — class identity only, no payload
  'K2Node_AddDelegate', 'K2Node_AssignDelegate',
]);

function extractNodeSemantics(nodeClass, props) {
  // Shared helpers — safe-read nested struct fields.
  const mr = (key) => (props?.[key] && typeof props[key] === 'object' && !Array.isArray(props[key]))
    ? props[key] : null;
  const resolveObjectName = (v) => {
    if (!v || typeof v !== 'object') return null;
    return v.packagePath || v.objectName || null;
  };

  const out = {};
  switch (nodeClass) {
    case 'K2Node_Event': {
      const ref = mr('EventReference');
      if (ref) {
        out.member_name = ref.MemberName ?? null;
        out.target_class = resolveObjectName(ref.MemberParent);
      }
      break;
    }
    case 'K2Node_CustomEvent': {
      out.member_name = props?.CustomFunctionName ?? null;
      break;
    }
    case 'K2Node_FunctionEntry':
    case 'K2Node_FunctionResult': {
      const ref = mr('FunctionReference');
      if (ref) out.member_name = ref.MemberName ?? null;
      break;
    }
    case 'K2Node_VariableGet':
    case 'K2Node_VariableSet': {
      const ref = mr('VariableReference');
      if (ref) {
        out.member_name = ref.MemberName ?? null;
        out.target_class = resolveObjectName(ref.MemberParent);
        if (ref.bSelfContext === true) out.extras = { ...(out.extras ?? {}), self_context: true };
      }
      break;
    }
    case 'K2Node_CallFunction':
    case 'K2Node_CallParentFunction': {
      const ref = mr('FunctionReference');
      if (ref) {
        out.member_name = ref.MemberName ?? null;
        out.target_class = resolveObjectName(ref.MemberParent);
        if (ref.bSelfContext === true) out.extras = { ...(out.extras ?? {}), self_context: true };
      }
      break;
    }
    case 'K2Node_SwitchEnum': {
      const enumRef = props?.Enum;
      if (enumRef && typeof enumRef === 'object') {
        out.target_class = resolveObjectName(enumRef);
      }
      break;
    }
    case 'K2Node_DynamicCast': {
      const tt = props?.TargetType;
      if (tt && typeof tt === 'object') {
        out.target_class = resolveObjectName(tt);
      }
      break;
    }
    case 'K2Node_MacroInstance': {
      const ref = mr('MacroGraphReference');
      if (ref) {
        out.macro_path = resolveObjectName(ref.MacroGraph);
        out.graph_name = ref.GraphName ?? null;
      }
      break;
    }
    // K2Node_IfThenElse, ExecutionSequence, SwitchString, SwitchInteger,
    // Self, Knot, AddDelegate, AssignDelegate: class identity only.
    default:
      break;
  }
  return out;
}

export async function findBlueprintNodes(projectRoot, params) {
  const assetPath = params.asset_path;
  const filterClass = params.node_class || null;
  const filterMember = params.member_name || null;
  const filterTarget = params.target_class || null;
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const offset = Math.max(0, params.offset ?? 0);

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, buf, names, exports, imports, resolve, structHandlers, containerHandlers } = ctx;
  const header = await parseAssetHeader(projectRoot, assetPath);
  const primary = header.data.assetRegistry.objects[0] || null;

  const matched = [];
  let totalSkeletal = 0;
  const nonSkeletalCounts = new Map();

  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls) continue;
    if (!cls.startsWith('K2Node_')) continue;
    if (!SKELETAL_K2NODE_CLASSES.has(cls)) {
      nonSkeletalCounts.set(cls, (nonSkeletalCounts.get(cls) ?? 0) + 1);
      continue;
    }
    totalSkeletal += 1;
    if (filterClass && cls !== filterClass) continue;

    // Parse the node's tagged properties to extract FMemberReference / etc.
    let nodeProps;
    try {
      nodeProps = readExportProperties(buf, e, names,
        { resolve, structHandlers, containerHandlers });
    } catch {
      nodeProps = { properties: {} };
    }
    const semantics = extractNodeSemantics(cls, nodeProps.properties);

    if (filterMember && semantics.member_name !== filterMember) continue;
    if (filterTarget) {
      const t = semantics.target_class;
      if (!t || (t !== filterTarget && !t.endsWith(filterTarget))) continue;
    }

    matched.push({
      node_class: cls,
      member_name: semantics.member_name ?? null,
      target_class: semantics.target_class ?? null,
      macro_path: semantics.macro_path ?? null,
      graph_name: semantics.graph_name ?? null,
      export_index: i + 1,
      node_name: e.objectName,
      extras: semantics.extras,
    });
  }

  const totalMatched = matched.length;
  const page = matched.slice(offset, offset + limit);
  const truncated = offset + limit < totalMatched;

  const nodesOutOfSkeletal = [...nonSkeletalCounts.entries()]
    .map(([node_class, count]) => ({ node_class, count }))
    .sort((a, b) => b.count - a.count);

  return {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    asset_name: primary ? (primary.objectPath || primary.objectClassName) : null,
    total_skeletal: totalSkeletal,
    total_matched: totalMatched,
    offset,
    limit,
    truncated,
    nodes: page,
    nodes_out_of_skeletal: nodesOutOfSkeletal,
  };
}

/**
 * find_blueprint_nodes_bulk — Corpus-wide K2Node scan under a path_prefix.
 *
 * Closes SERVED_PARTIAL Workflow Catalog rows 26/27/28/42/62/63 by folding
 * N-round-trip "which BPs call X / handle Y / access Z" iteration into a
 * single call. Walks queryAssetRegistry for Blueprint assets under the
 * prefix, reuses findBlueprintNodes per result, aggregates match counts.
 *
 * Semantics inherited from findBlueprintNodes:
 *   - node_class / member_name / target_class filter with identical rules
 *     (target_class does suffix match).
 *   - Single-BP total_matched becomes per-BP match_count.
 *
 * Pagination is two-level:
 *   - max_scan  — caps how many .uasset files walked on disk (registry level).
 *   - limit/offset — slice matched-BP results[] after filtering.
 *
 * Per-BP parse errors are swallowed into errors[] (a single corrupt asset
 * shouldn't poison a corpus scan). Only BPs with match_count > 0 enter
 * results[] — the "how many BPs match?" question stays compact.
 */
export async function findBlueprintNodesBulk(projectRoot, params) {
  const pathPrefix = params.path_prefix;
  if (!pathPrefix) throw new Error('Missing required parameter: path_prefix');
  if (!pathPrefix.startsWith('/Game/')) {
    throw new Error(`path_prefix must start with /Game/ (got: ${pathPrefix})`);
  }

  const filter = {
    node_class: params.node_class || null,
    member_name: params.member_name || null,
    target_class: params.target_class || null,
  };
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);
  const maxScan = Math.max(1, Math.min(params.max_scan ?? 500, 5000));
  const includeNodes = params.include_nodes ?? false;

  // max_scan is a Blueprint-count cap (the param name's plain reading). We
  // always walk the full prefix subtree at the registry layer — Content/
  // trees commonly contain 10-40x more non-BP assets than BPs, so capping
  // the file-walk would silently truncate to a tiny BP count on large
  // projects. Instead: walk wide, cap narrow at the BP level.
  const registry = await queryAssetRegistry(projectRoot, {
    class_name: 'Blueprint',
    path_prefix: pathPrefix,
    limit: 2000,
    max_scan: 20000,
  });

  const allBpPaths = registry.results.map(r => r.path);
  const bpPaths = allBpPaths.slice(0, maxScan);
  // scan_truncated: the matched-BP set we're about to process is incomplete.
  // Causes: queryAssetRegistry paginated off >2000 BPs, its file-walk hit
  // 20000, or our max_scan BP cap clipped results. Distinct from
  // page_truncated (pagination over the filtered set).
  const scanTruncated = registry.truncated || allBpPaths.length > maxScan;

  const perBp = [];
  const errors = [];

  for (const bpPath of bpPaths) {
    try {
      // Invoke the single-BP handler with a high internal limit so we
      // capture all matches (we aggregate the count, then page at bulk
      // level). 10000 comfortably exceeds any real BP's skeletal count.
      const single = await findBlueprintNodes(projectRoot, {
        asset_path: bpPath,
        node_class: filter.node_class,
        member_name: filter.member_name,
        target_class: filter.target_class,
        limit: 10000,
        offset: 0,
      });
      if (single.total_matched === 0) continue;

      const row = { path: bpPath, match_count: single.total_matched };
      if (includeNodes) row.nodes = single.nodes;
      perBp.push(row);
    } catch (err) {
      errors.push({ path: bpPath, error: err.message });
    }
  }

  // Rank by match density so page one carries the densest assets. Array.sort is
  // stable, so equal counts keep registry order and pagination stays deterministic.
  perBp.sort((a, b) => b.match_count - a.match_count);

  const totalBpsMatched = perBp.length;
  const pageResults = perBp.slice(offset, offset + limit);
  const pageTruncated = totalBpsMatched > offset + limit;

  const out = {
    path_prefix: pathPrefix,
    filter,
    total_bps_scanned: bpPaths.length,
    total_bps_matched: totalBpsMatched,
    scan_truncated: scanTruncated,
    page_truncated: pageTruncated,
    offset,
    limit,
    results: pageResults,
  };
  if (errors.length) out.errors = errors;
  return out;
}

// ── M-spatial: BP traversal verbs (offline-primary, no plugin/TCP/sidecar) ──
//
// Five verbs built on the existing L1+L2+L2.5 parser surface. No new binary
// parsing: the tagged-fallback path already decodes spatial UPROPERTYs
// (NodePosX/Y, NodeWidth/Height, NodeComment, EnabledState, CommentColor,
// bCommentBubble*) on K2Node and UEdGraphNode_Comment exports.
//
// FA-β contract: every verb returns {available_fields[], not_available[],
// schema_version, plugin_enhancement_available}. Partial verbs (bp_show_node,
// bp_list_entry_points) enumerate what the offline-only implementation
// cannot deliver — callers route to M-new when pin-aware data is required.
//
// FA-δ invariant: these verbs produce non-empty correct data on real BPs
// with no sidecar/plugin/editor present (proven in test-phase1.mjs).

const M_SPATIAL_SCHEMA_VERSION = 'm-spatial-v1';

const SPATIAL_AVAILABLE_FIELDS = [
  'positions',         // NodePosX/Y
  'node_size',         // NodeWidth/Height when serialized
  'comments',          // NodeComment + UEdGraphNode_Comment CommentColor/FontSize
  'contains',          // spatial rect containment for comment boxes
  'class_identity',    // K2Node/EdGraphNode_Comment class name
  'enabled_state',     // EnabledState enum when serialized
  'node_guid',         // FGuid NodeGuid
  'member_reference',  // FMemberReference — via existing skeletal surface
];

const ENTRY_POINT_CLASSES = new Set([
  'K2Node_Event',
  'K2Node_CustomEvent',
  'K2Node_FunctionEntry',
]);

// Canonical node name uses the FName Number suffix ("_0", "_1", ...) so duplicate
// base names (9 × EdGraphNode_Comment) disambiguate. Matches UE's display.
//
// Formats from the BASE via the shared parser helper rather than re-appending a
// suffix: readExportTable already returns a canonical objectName, so appending
// here again would yield EdGraphNode_Comment_0_0. One helper, one convention.
function canonicalNodeName(exportEntry) {
  if (!exportEntry) return null;
  return formatFName(
    exportEntry.objectNameBase ?? exportEntry.objectName,
    exportEntry.objectNameNumber,
  );
}

/**
 * Classify an EdGraph by its objectName. Heuristic — UE doesn't serialize
 * a type enum on UEdGraph; graph membership on the UBlueprint (UbergraphPages,
 * FunctionGraphs, etc.) is the canonical signal. We rely on naming conventions
 * instead of parsing the UBlueprint's TArray<ObjectProperty> refs to keep the
 * v1 surface simple; `unknown` is the fallback when no heuristic matches.
 */
function classifyGraph(name, className = 'EdGraph') {
  if (className === 'AnimationGraph') return 'anim_graph';
  if (name === 'EventGraph' || name.startsWith('Ubergraph')) return 'ubergraph';
  if (name === 'UserConstructionScript' || name === 'ConstructionScript') return 'construction_script';
  if (name.endsWith('_DelegateSignature')) return 'delegate_signature';
  if (name.startsWith('Macro_') || name.endsWith('_Macro')) return 'macro';
  if (name === 'Timeline' || name.endsWith('_Timeline')) return 'timeline';
  return 'function';
}

const BLUEPRINT_ASSET_EXPORT_CLASSES = new Set([
  'Blueprint',
  'AnimBlueprint',
  'WidgetBlueprint',
]);

const TOP_LEVEL_BLUEPRINT_GRAPH_CLASSES = new Set([
  'EdGraph',
  'AnimationGraph',
]);

/**
 * Walk the export table and bucket graph-node exports by their containing
 * top-level graph. Returns { graphs, nodesByGraph, commentsByGraph }
 * keyed by the graph's 1-based FPackageIndex. `ubpIndex` is the UBlueprint's
 * export index — graphs whose outerIndex resolves to it are considered
 * belonging to this BP.
 */
function indexBlueprintGraphs(ctx) {
  const { exports, imports } = ctx;

  // Find the UBlueprint-family export. AnimBlueprint assets serialize their
  // top-level AnimGraph as class AnimationGraph under the AnimBlueprint export,
  // not as a plain EdGraph.
  const ubpIdx = exports.findIndex(e =>
    BLUEPRINT_ASSET_EXPORT_CLASSES.has(resolvePackageIndex(e.classIndex, exports, imports, 'objectName')));
  const ubpPackageIndex = ubpIdx >= 0 ? ubpIdx + 1 : null;

  // Build the top-level graph set. Nested animation state/transition graphs
  // are deliberately left for the deeper AnimGraph readback surface.
  const graphByPackageIndex = new Map();
  const graphs = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!TOP_LEVEL_BLUEPRINT_GRAPH_CLASSES.has(cls)) continue;
    if (ubpPackageIndex !== null && e.outerIndex !== ubpPackageIndex) continue;
    const graphPi = i + 1;
    const rec = {
      name: e.objectName,
      graph_type: classifyGraph(e.objectName, cls),
      export_index: graphPi,
      node_count: 0,
      comment_count: 0,
      _nodes: [],
      _comments: [],
    };
    graphByPackageIndex.set(graphPi, rec);
    graphs.push(rec);
  }

  // Bucket graph-node exports under their outer graph. AnimGraphNode_* counts
  // make bp_list_graphs honest for AnimBlueprints; deeper semantic decoding
  // remains D188 scope.
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls) continue;
    const isK2Node = cls.startsWith('K2Node_');
    const isAnimGraphNode = cls.startsWith('AnimGraphNode_');
    const isComment = cls === 'EdGraphNode_Comment';
    if (!isK2Node && !isAnimGraphNode && !isComment) continue;
    const rec = graphByPackageIndex.get(e.outerIndex);
    if (!rec) continue;
    const row = { export_index: i + 1, export: e, className: cls };
    if (isComment) {
      rec._comments.push(row);
      rec.comment_count += 1;
    } else {
      rec._nodes.push(row);
      rec.node_count += 1;
    }
  }

  return { graphs, ubpPackageIndex };
}

/**
 * Pick the spatial sub-shape from a parsed node's properties. Missing fields
 * are omitted (not null) so response payloads stay compact for nodes that
 * inherit defaults — NodePosX/Y are usually present; NodeWidth/Height are
 * only serialized on EdGraphNode_Comment and the rare sized K2Node.
 */
function extractSpatial(props) {
  const out = {};
  // Positions default to 0 when not serialized (UE omits class defaults).
  // Callers treat missing positions as "at origin" — always present for
  // consistent downstream containment math.
  out.node_pos_x = typeof props.NodePosX === 'number' ? props.NodePosX : 0;
  out.node_pos_y = typeof props.NodePosY === 'number' ? props.NodePosY : 0;
  if (typeof props.NodeWidth === 'number') out.node_width = props.NodeWidth;
  if (typeof props.NodeHeight === 'number') out.node_height = props.NodeHeight;
  if (typeof props.NodeComment === 'string' && props.NodeComment.length > 0) {
    out.node_comment = props.NodeComment;
  }
  if (props.EnabledState !== undefined) out.enabled_state = props.EnabledState;
  if (typeof props.bCommentBubblePinned === 'boolean') out.comment_bubble_pinned = props.bCommentBubblePinned;
  if (typeof props.bCommentBubbleVisible === 'boolean') out.comment_bubble_visible = props.bCommentBubbleVisible;
  if (typeof props.NodeGuid === 'string') out.node_guid = props.NodeGuid;
  return out;
}

/**
 * Parse comment-specific UPROPERTYs from a UEdGraphNode_Comment node's
 * decoded property map. CommentColor decodes via FLinearColor handler.
 */
function extractCommentExtras(props) {
  const out = {};
  if (props.CommentColor && typeof props.CommentColor === 'object') {
    out.comment_color = props.CommentColor;
  }
  if (typeof props.FontSize === 'number') out.font_size = props.FontSize;
  if (typeof props.bColorCommentBubble === 'boolean') out.color_comment_bubble = props.bColorCommentBubble;
  if (typeof props.bCommentBubbleVisible_InDetailsPanel === 'boolean') {
    out.comment_bubble_visible_in_details_panel = props.bCommentBubbleVisible_InDetailsPanel;
  }
  return out;
}

/**
 * Compute which nodes are contained inside each comment box. Center-point
 * in rectangle — a node at (x,y) with half-extents (w/2,h/2) is contained
 * when its center (x + w/2, y + h/2) is strictly inside the comment's
 * (NodePosX, NodePosY) - (NodePosX + NodeWidth, NodePosY + NodeHeight)
 * rectangle. K2Nodes rarely serialize NodeWidth/Height — they're treated as
 * point nodes (w=h=0) for the containment check. Zero-size comment rects
 * return an empty list. Nested comments are reported pairwise; no hierarchy
 * is inferred.
 *
 * Complexity O(N*M). For BP_OSPlayerR (~184 K2Nodes × ~9 comments) this is
 * ~1700 float compares — microseconds.
 *
 * @param {Array<{node_id, node_pos_x, node_pos_y, node_width?, node_height?}>} nodes
 * @param {Array<{node_id, node_pos_x, node_pos_y, node_width, node_height}>} commentNodes
 * @returns {Map<number, Array<number>>} commentId → contained node_id list
 */
export function computeCommentContainment(nodes, commentNodes) {
  const out = new Map();
  for (const c of commentNodes) {
    const cx1 = c.node_pos_x ?? 0;
    const cy1 = c.node_pos_y ?? 0;
    const cw = c.node_width ?? 0;
    const ch = c.node_height ?? 0;
    if (cw <= 0 || ch <= 0) {
      out.set(c.node_id, []);
      continue;
    }
    const cx2 = cx1 + cw;
    const cy2 = cy1 + ch;
    const contained = [];
    for (const n of nodes) {
      if (n.node_id === c.node_id) continue;
      const nx = (n.node_pos_x ?? 0) + (n.node_width ?? 0) / 2;
      const ny = (n.node_pos_y ?? 0) + (n.node_height ?? 0) / 2;
      if (nx >= cx1 && nx <= cx2 && ny >= cy1 && ny <= cy2) {
        contained.push(n.node_id);
      }
    }
    out.set(c.node_id, contained);
  }
  return out;
}

function faBetaManifest(notAvailable = [], extraAvailable = []) {
  return {
    schema_version: M_SPATIAL_SCHEMA_VERSION,
    available_fields: [...SPATIAL_AVAILABLE_FIELDS, ...extraAvailable],
    not_available: notAvailable,
    plugin_enhancement_available: false,
  };
}

/**
 * bp_list_graphs — enumerate UEdGraph subobjects of a UBlueprint.
 */
async function bpListGraphs(projectRoot, params) {
  const assetPath = params.asset_path;
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath } = ctx;
  const { graphs } = indexBlueprintGraphs(ctx);

  const graphRows = graphs
    .map(g => {
      // EN-8: per-graph comment_ids[] enumerates UEdGraphNode_Comment node_guids
      // (serialized class name is 'EdGraphNode_Comment' — no U prefix). Callers
      // use these to skip inspect_blueprint when locating comments before
      // bp_subgraph_in_comment. Empty array when the graph has no comments
      // (field is always present for shape stability). Parse cost is bounded:
      // BP_OSPlayerR has ~9 comments total, so this adds microseconds.
      const comment_ids = g._comments
        .map(c => parseNodeShape(ctx, c.export, c.export_index).row.node_guid)
        .filter(guid => typeof guid === 'string');
      return {
        name: g.name,
        graph_type: g.graph_type,
        node_count: g.node_count,
        comment_count: g.comment_count,
        comment_ids,
        export_index: g.export_index,
      };
    })
    .sort((a, b) => {
      // Deterministic ordering: type bucket then name.
      const typeOrder = ['ubergraph', 'construction_script', 'function', 'macro', 'delegate_signature', 'timeline', 'unknown'];
      const ai = typeOrder.indexOf(a.graph_type);
      const bi = typeOrder.indexOf(b.graph_type);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });

  return {
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    graph_count: graphRows.length,
    graphs: graphRows,
    ...faBetaManifest([]),
  };
}

/**
 * Parse a node's properties and assemble its base + spatial shape.
 * Shared by bp_find_in_graph, bp_subgraph_in_comment, bp_show_node,
 * bp_list_entry_points. Returns null if the node's serial range is invalid.
 */
function parseNodeShape(ctx, exportEntry, exportIndex) {
  const { buf, names, resolve, structHandlers, containerHandlers } = ctx;
  let parsed;
  try {
    parsed = readExportProperties(buf, exportEntry, names, { resolve, structHandlers, containerHandlers });
  } catch {
    parsed = { properties: {} };
  }
  const props = parsed.properties;
  const className = resolvePackageIndex(exportEntry.classIndex, ctx.exports, ctx.imports, 'objectName');
  const row = {
    node_id: exportIndex,
    node_name: canonicalNodeName(exportEntry),
    class_name: className,
    ...extractSpatial(props),
  };
  if (className === 'EdGraphNode_Comment') Object.assign(row, extractCommentExtras(props));
  return { row, rawProps: props };
}

/**
 * bp_find_in_graph — filter K2Nodes within a single UEdGraph.
 */
async function bpFindInGraph(projectRoot, params) {
  const assetPath = params.asset_path;
  const graphName = params.graph_name;
  if (!graphName) throw new Error('Missing required parameter: graph_name');
  const filterClass = params.node_class || null;
  const filterMember = params.member_name || null;
  const filterTarget = params.target_class || null;
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const offset = Math.max(0, params.offset ?? 0);

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath } = ctx;
  const { graphs } = indexBlueprintGraphs(ctx);
  const graph = graphs.find(g => g.name === graphName);
  if (!graph) {
    throw new Error(`Graph not found: ${graphName}. Available: ${graphs.map(g => g.name).join(', ')}`);
  }

  const matched = [];
  for (const row of graph._nodes) {
    const cls = row.className;
    if (!SKELETAL_K2NODE_CLASSES.has(cls)) continue;
    if (filterClass && cls !== filterClass) continue;
    const shape = parseNodeShape(ctx, row.export, row.export_index);
    const semantics = extractNodeSemantics(cls, shape.rawProps);
    if (filterMember && semantics.member_name !== filterMember) continue;
    if (filterTarget) {
      const t = semantics.target_class;
      if (!t || (t !== filterTarget && !t.endsWith(filterTarget))) continue;
    }
    matched.push({
      ...shape.row,
      node_class: cls,
      member_name: semantics.member_name ?? null,
      target_class: semantics.target_class ?? null,
      macro_path: semantics.macro_path ?? null,
      graph_name: graph.name,
      extras: semantics.extras,
    });
  }

  const page = matched.slice(offset, offset + limit);
  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    graph_name: graph.name,
    graph_type: graph.graph_type,
    total_nodes_in_graph: graph.node_count,
    total_matched: matched.length,
    offset,
    limit,
    truncated: offset + limit < matched.length,
    nodes: page,
    ...faBetaManifest([]),
  });
}

/**
 * bp_subgraph_in_comment — return the comment node + nodes it spatially contains.
 */
async function bpSubgraphInComment(projectRoot, params) {
  const assetPath = params.asset_path;
  const rawId = params.comment_node_id;
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new Error('Missing required parameter: comment_node_id');
  }
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;

  // Resolve comment_node_id — integer/numeric-string matches export_index;
  // plain string matches canonicalNodeName or objectName.
  // Resolve any node id first (integer export_index OR string objectName),
  // then verify it's a comment. Two-phase lookup gives callers a precise
  // "not a comment" message when they pass a valid non-comment id, vs a
  // generic "not found" when the id is bogus.
  const asNum = Number(rawId);
  let commentExportIndex = null;
  if (Number.isInteger(asNum) && asNum > 0 && asNum <= exports.length) {
    commentExportIndex = asNum;
  } else {
    for (let i = 0; i < exports.length; i++) {
      const e = exports[i];
      if (e.objectName === rawId || e.objectNameBase === rawId || canonicalNodeName(e) === rawId) {
        commentExportIndex = i + 1;
        break;
      }
    }
  }
  if (commentExportIndex === null) {
    throw new Error(`Comment node not found: ${rawId}`);
  }
  const commentExport = exports[commentExportIndex - 1];
  const commentClass = resolvePackageIndex(commentExport.classIndex, exports, imports, 'objectName');
  if (commentClass !== 'EdGraphNode_Comment') {
    throw new Error(`Node is not a comment: ${rawId} (className: ${commentClass})`);
  }

  // Build the comment's shape.
  const commentShape = parseNodeShape(ctx, commentExport, commentExportIndex);

  // Collect sibling nodes in the same graph (outerIndex match).
  const graphPi = commentExport.outerIndex;
  const siblings = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    if (e.outerIndex !== graphPi) continue;
    if (i + 1 === commentExportIndex) continue;
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls) continue;
    if (!cls.startsWith('K2Node_') && cls !== 'EdGraphNode_Comment') continue;
    const shape = parseNodeShape(ctx, e, i + 1);
    siblings.push(shape.row);
  }

  const commentRow = commentShape.row;
  const contained = computeCommentContainment(siblings, [commentRow]).get(commentRow.node_id) ?? [];
  const containedNodes = siblings.filter(s => contained.includes(s.node_id));

  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    comment: commentRow,
    contained_count: containedNodes.length,
    contained: containedNodes,
    ...faBetaManifest([]),
  });
}

/**
 * bp_list_entry_points — enumerate K2Node_Event/CustomEvent/FunctionEntry nodes.
 *
 * M-new (D58) precision upgrade: class-identity heuristic retained for
 * backward-compat, now annotated with `has_no_exec_in` via S-B-base pin data.
 * A true entry point has no incoming exec pin wired — entries whose
 * `has_no_exec_in` is `false` are technically entry-shaped nodes that
 * receive control from elsewhere (rare, but possible with complex macro
 * instantiations). The response advertises `exec_connectivity` in
 * `available_fields` once pin data is loaded; falls back to FA-β partial
 * coverage when the topology parse fails.
 */
async function bpListEntryPoints(projectRoot, params) {
  const assetPath = params.asset_path;
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;
  const { graphs } = indexBlueprintGraphs(ctx);

  // Map graph package-index → graph name for echoing per entry.
  const graphNameByPi = new Map();
  for (const g of graphs) graphNameByPi.set(g.export_index, g.name);

  // Build a quick lookup: (graph_name, node_guid) → has_incoming_exec_link?
  // Key by the (graph, guid) tuple per D70 — NodeGuids are NOT unique across
  // sibling graphs in one BP.
  const topology = extractBPEdgeTopologyFromCtx(ctx, assetPath);
  const incomingExecByGraphGuid = new Map();
  for (const [gName, gEntry] of Object.entries(topology.graphs ?? {})) {
    for (const [srcGuid, srcNode] of Object.entries(gEntry.nodes)) {
      for (const pin of Object.values(srcNode.pins)) {
        if (pin.direction !== 'EGPD_Output') continue;
        if (!isExecPin(pin)) continue;
        for (const link of pin.linked_to) {
          incomingExecByGraphGuid.set(`${gName}|${link.node_guid}`, true);
          void srcGuid;
        }
      }
    }
  }

  const entries = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls || !ENTRY_POINT_CLASSES.has(cls)) continue;
    const shape = parseNodeShape(ctx, e, i + 1);
    const semantics = extractNodeSemantics(cls, shape.rawProps);
    const gName = graphNameByPi.get(e.outerIndex) ?? null;
    const oracleGuid = toOracleHexGuid(shape.row.node_guid);
    const hasNoExecIn = gName !== null && oracleGuid !== null
      ? !incomingExecByGraphGuid.has(`${gName}|${oracleGuid}`)
      : null;
    entries.push({
      ...shape.row,
      node_class: cls,
      member_name: semantics.member_name ?? null,
      target_class: semantics.target_class ?? null,
      graph_name: gName,
      has_no_exec_in: hasNoExecIn,
    });
  }

  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    entry_point_count: entries.length,
    entry_points: entries,
    ...faBetaManifest([], ['exec_connectivity']),
  });
}

/**
 * bp_show_node — full export record for a single node by id.
 *
 * M-new (D58) pin-block completion: pins[] is populated from S-B-base
 * topology when the node is reachable there (keyed by its Oracle-A
 * NodeGuid under its owning graph). When the node's guid converts and
 * matches a topology entry, `pin_block` and `pin_defaults` move from
 * `not_available` to `available_fields`. Non-graph-node exports (nodes
 * whose class isn't K2Node_* / EdGraphNode_Comment, or whose pin-block
 * parse returned malformed) still emit pins=[] with both fields in
 * not_available.
 */
async function bpShowNode(projectRoot, params) {
  const assetPath = params.asset_path;
  const rawId = params.node_id;
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new Error('Missing required parameter: node_id');
  }
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;

  const asNum = Number(rawId);
  let nodeExportIndex = null;
  if (Number.isInteger(asNum) && asNum > 0 && asNum <= exports.length) {
    nodeExportIndex = asNum;
  } else {
    for (let i = 0; i < exports.length; i++) {
      const e = exports[i];
      if (e.objectName === rawId || e.objectNameBase === rawId || canonicalNodeName(e) === rawId) {
        nodeExportIndex = i + 1;
        break;
      }
    }
  }
  if (nodeExportIndex === null) {
    throw new Error(`Node not found: ${rawId}`);
  }

  const nodeExport = exports[nodeExportIndex - 1];
  const className = resolvePackageIndex(nodeExport.classIndex, exports, imports, 'objectName');
  const shape = parseNodeShape(ctx, nodeExport, nodeExportIndex);
  const semantics = className?.startsWith('K2Node_')
    ? extractNodeSemantics(className, shape.rawProps) : {};

  // Graph context — which graph does this node live in?
  const { graphs } = indexBlueprintGraphs(ctx);
  const graph = graphs.find(g => g.export_index === nodeExport.outerIndex);

  // Pin-block completion via topology. Share the ctx already parsed above —
  // avoids a second read of the uasset bytes. Keyed by (graph_name, guid)
  // per D70 uniqueness invariant. When the M-spatial graph lookup returned
  // null (orphan graph case), pin_block degrades to not_available rather
  // than scanning all graphs — NodeGuids are NOT unique across sibling
  // graphs in one BP, so a cross-graph scan could return pins from a
  // coincident-guid node in the wrong graph (audit F-10).
  let pinsOut = [];
  let pinBlockAvailable = false;
  const oracleGuid = toOracleHexGuid(shape.row.node_guid);
  if (oracleGuid && graph) {
    const topology = extractBPEdgeTopologyFromCtx(ctx, assetPath);
    const match = topology.graphs?.[graph.name]?.nodes?.[oracleGuid];
    if (match) {
      pinsOut = Object.entries(match.pins).map(([pinId, pin]) => shapePublicPin(pinId, pin));
      pinBlockAvailable = true;
    }
  }

  const node = {
    ...shape.row,
    outer_graph_name: graph?.name ?? null,
    outer_graph_type: graph?.graph_type ?? null,
    member_name: semantics.member_name ?? null,
    target_class: semantics.target_class ?? null,
    macro_path: semantics.macro_path ?? null,
    properties: shape.rawProps,
    pins: pinsOut,
  };

  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    node,
    ...faBetaManifest(
      pinBlockAvailable ? [] : ['pin_block', 'pin_defaults'],
      pinBlockAvailable ? ['pin_block', 'pin_defaults'] : [],
    ),
  });
}

// ── S-B-base (M-new): offline BP edge topology extractor ─────────────────
//
// Returns Oracle-A-v2-aligned pin + edge topology for a Blueprint asset.
// Verb-surface worker consumes this as the data layer for bp_trace_exec,
// bp_trace_data, bp_neighbors edge mode, bp_show_node pin completion, and
// bp_list_entry_points precision. See docs/handoffs/m-new-s-b-base-parser.md §6.
//
// Output shape:
//   {
//     schema_version: "sb-base-v1",
//     asset_path: "/Game/...",
//     graphs: { "<graphName>": { nodes: { "<nodeGuid>": {class_name, pins} } } }
//     stats: { graphNodeExports, nodesEmitted, pinsEmitted, edgesEmitted, ... }
//   }
//
// Contract matches Oracle-A-v2 per-pin dict (`name`+`direction`+`linked_to`)
// so the differential harness can diff directly without shape adapters.

/**
 * Extract topology from a pre-parsed asset context. Used by
 * `extractBPEdgeTopology` (public entry) and by M-new verbs that have
 * already paid the parse cost (e.g., `bp_show_node` sharing its own ctx).
 */
function extractBPEdgeTopologyFromCtx(ctx, assetPath) {
  const { buf, names, imports, exports, summary, resolve, structHandlers, containerHandlers } = ctx;
  // The pin layout varies PER PACKAGE, not per engine — SourceIndex is gated on
  // a custom version, so one install holds packages on both sides of it.
  const topology = resolveLinkedToEdges(buf, exports, imports, names, {
    resolve, structHandlers, containerHandlers,
    ...pinBlockLayoutForPackage(summary),
  });
  return {
    schema_version: topology.schema_version,
    asset_path: assetPath,
    graphs: topology.graphs,
    stats: topology.stats,
  };
}

// @param {string} projectRoot
// @param {{ asset_path: string }} params
async function extractBPEdgeTopology(projectRoot, params) {
  const assetPath = params.asset_path;
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  return extractBPEdgeTopologyFromCtx(ctx, assetPath);
}

/**
 * Guarded `extractBPEdgeTopology`. Returns an FA-β graceful-degradation
 * envelope (`{available: false, reason: 'asset_not_found', asset_path}`)
 * when the asset is absent, otherwise forwards to the inner handler.
 *
 * Exported for Verb-surface worker + the differential test harness.
 */
export const extractBPEdgeTopologySafe = withAssetExistenceCheck(extractBPEdgeTopology);

// ── M-new Verb-surface shared helpers ──────────────────────────────────────
//
// Exec-vs-data pin classification by NAME CONVENTION — PinCategory is not
// captured in the current S-B-base parse (parsePinBlock skips FEdGraphPinType
// bytes). The vocabulary below covers every exec pin observed across the
// Oracle-A-v2 corpus (BP_OSPlayerR + BP_OSControlPoint + children): standard
// entry/exit (`execute`, `then`, `else`, `completed`, `throw`), Sequence
// fan-out (`then_0`...`then_N`), DynamicCast (`CastFailed`), WhileLoop
// (`LoopBody`), SwitchEnum/Integer (`Out 0`...`Out N`, `Default`). Match is
// case-insensitive. Pins whose name falls outside this set are classified as
// data — acceptable for the 5 v1 verbs; false-negatives surface as "data
// edges that should have been exec" and can be addressed by later PinCategory
// capture (S-B-overrides scope). KNOWN FALSE-POSITIVE RISK: the word
// "Default" appears as both SwitchEnum/String's default-case exec output
// (legit exec) and could conceivably appear as a data pin named "Default"
// on a user-defined node. No such false-positive in the current corpus —
// S-B-overrides can tighten this by reading PinCategory when it lands.
const EXEC_PIN_NAME_RE = /^(execute|exec|then|else|completed|castfailed|loopbody|throw|default)(_\d+)?$|^out( \d+)?$/i;
function isExecPin(pin) {
  if (!pin || typeof pin.name !== 'string') return false;
  return EXEC_PIN_NAME_RE.test(pin.name);
}

/**
 * Convert the raw NodeGuid emitted by the tagged-fallback FGuid handler
 * (32-char lowercase, byte-LE) into Oracle-A-v2 format (32-char uppercase,
 * BE-per-uint32). Mirrors the parser-internal `extractNodeGuid` transform.
 * Returns null when input isn't a 32-char hex string.
 */
function toOracleHexGuid(rawGuid) {
  if (typeof rawGuid !== 'string' || rawGuid.length !== 32) return null;
  let out = '';
  for (let g = 0; g < 4; g++) {
    const chunk = rawGuid.substr(g * 8, 8);
    const beHex = chunk.match(/../g).reverse().join('');
    out += beHex.toUpperCase();
  }
  return out;
}

/**
 * Bridge a NodeGuid input to whichever form is keyed in `nodes`. Verb-surface
 * handlers (bp_trace_exec/bp_trace_data/bp_neighbors) key topology by the
 * Oracle-A-v2 canonical form (uppercase BE-per-uint32) but agents commonly
 * pipe NodeGuids straight from M-spatial-output verbs (bp_list_entry_points,
 * bp_find_in_graph, bp_list_graphs.comment_ids[]) which emit the raw
 * tagged-fallback FGuid form (lowercase byte-LE). Without this bridge the
 * lookup silently fails with `node_not_found` even though the node exists
 * (audit F-2). Tries in order:
 *   1. as-is — caller already canonical OR happens to be keyed verbatim.
 *   2. uppercase — caller passed canonical form with mixed case.
 *   3. toOracleHexGuid(lowercase) — caller passed M-spatial raw form.
 * Returns the form present in `nodes`, or rawInput unchanged when nothing
 * matches (downstream surfaces `node_not_found` per existing contract).
 */
function normalizeNodeGuidInput(rawInput, nodes) {
  if (typeof rawInput !== 'string' || rawInput.length !== 32) return rawInput;
  if (!nodes) return rawInput;
  if (nodes[rawInput]) return rawInput;
  const upper = rawInput.toUpperCase();
  if (upper !== rawInput && nodes[upper]) return upper;
  if (/^[0-9a-fA-F]{32}$/.test(rawInput)) {
    const oracle = toOracleHexGuid(rawInput.toLowerCase());
    if (oracle && nodes[oracle]) return oracle;
  }
  return rawInput;
}

/**
 * Look up a graph by name in topology.graphs, returning the graph entry or
 * an FA-β `graph_not_found` envelope with the available_graphs enumeration.
 * Shared by bp_trace_exec, bp_trace_data, bp_neighbors.
 */
function resolveTopologyGraph(topology, assetPath, graphName) {
  const graph = topology.graphs?.[graphName];
  if (graph) return { graph };
  return {
    envelope: {
      available: false,
      reason: 'graph_not_found',
      asset_path: assetPath,
      graph_name: graphName,
      available_graphs: Object.keys(topology.graphs ?? {}),
    },
  };
}

/**
 * Shape a pin for the public surface: strip linked_to's internal structure
 * and tag with pin_kind (exec|data) for caller filtering convenience.
 */
function shapePublicPin(pinId, pin) {
  const out = {
    pin_id: pinId,
    name: pin.name ?? '',
    direction: pin.direction,
    pin_kind: isExecPin(pin) ? 'exec' : 'data',
    linked_to: pin.linked_to,
  };
  if ('default_value' in pin) out.default_value = pin.default_value;
  if ('autogenerated_default_value' in pin) {
    out.autogenerated_default_value = pin.autogenerated_default_value;
  }
  if ('default_object' in pin) out.default_object = pin.default_object;
  if ('default_text_value' in pin) out.default_text_value = pin.default_text_value;
  return out;
}

// ── bp_trace_exec ──────────────────────────────────────────────────────────
//
// BFS walk of outgoing exec pins from a source node. Returns an ordered list
// of visited nodes with the pin they were reached through. Cycle-safe via a
// visited-set; depth capped by `max_depth`. Optional `pin_name` filter
// narrows the exec pins followed at each step (useful for "trace only the
// 'then' chain from a branch" style queries).
async function bpTraceExec(projectRoot, params) {
  const assetPath = params.asset_path;
  const graphName = params.graph_name;
  const rawStartGuid = params.start_node_id;
  if (!graphName) throw new Error('Missing required parameter: graph_name');
  if (!rawStartGuid) throw new Error('Missing required parameter: start_node_id');

  const maxDepth = Math.max(1, Math.min(params.max_depth ?? 50, 500));
  const pinNameFilter = params.pin_name ?? null;

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const topology = extractBPEdgeTopologyFromCtx(ctx, assetPath);
  const g = resolveTopologyGraph(topology, assetPath, graphName);
  if (g.envelope) return g.envelope;

  const nodes = g.graph.nodes;
  // F-2 input bridge: agents commonly pipe `bp_list_entry_points.entry_points
  // [].node_guid` (M-spatial raw lowercase-LE) straight into start_node_id.
  // Normalize against topology key form (Oracle-A canonical uppercase-BE).
  const startGuid = normalizeNodeGuidInput(rawStartGuid, nodes);
  if (!nodes[startGuid]) {
    return {
      available: false,
      reason: 'node_not_found',
      asset_path: assetPath,
      graph_name: graphName,
      start_node_id: startGuid,
    };
  }

  const chain = [];
  const visited = new Set();
  let maxDepthReached = 0;
  let depthCapHit = false;

  // BFS — queue of {node_guid, depth, via_pin, via_pin_name, from_node_guid}
  const queue = [{ node_guid: startGuid, depth: 0, via_pin: null, via_pin_name: null, from_node_guid: null }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur.node_guid)) continue;
    visited.add(cur.node_guid);
    const node = nodes[cur.node_guid];
    if (!node) continue;
    chain.push({
      node_guid: cur.node_guid,
      class_name: node.class_name,
      via_pin: cur.via_pin,
      via_pin_name: cur.via_pin_name,
      from_node_guid: cur.from_node_guid,
      depth: cur.depth,
    });
    if (cur.depth > maxDepthReached) maxDepthReached = cur.depth;
    if (cur.depth >= maxDepth) { depthCapHit = true; continue; }

    for (const [pinId, pin] of Object.entries(node.pins)) {
      if (pin.direction !== 'EGPD_Output') continue;
      if (!isExecPin(pin)) continue;
      if (pinNameFilter !== null && pin.name !== pinNameFilter) continue;
      for (const link of pin.linked_to) {
        if (visited.has(link.node_guid)) continue;
        queue.push({
          node_guid: link.node_guid,
          depth: cur.depth + 1,
          via_pin: pinId,
          via_pin_name: pin.name,
          from_node_guid: cur.node_guid,
        });
      }
    }
  }

  return {
    asset_path: assetPath,
    graph_name: graphName,
    start_node_id: startGuid,
    pin_name_filter: pinNameFilter,
    max_depth: maxDepth,
    max_depth_reached: maxDepthReached,
    truncated_at_depth: depthCapHit,
    chain_length: chain.length,
    chain,
    ...faBetaManifest([], ['exec_connectivity', 'pin_block']),
  };
}

// ── bp_trace_data ──────────────────────────────────────────────────────────
//
// BFS walk of outgoing data (non-exec) pins from a source node. Each entry
// in `sinks` represents one edge — if the source node has three output data
// pins each linking to two consumers, you get six rows. Unlike exec traces,
// data wires commonly have multiple consumers per source, so the flat edge
// list is more natural than a deduped node chain.
async function bpTraceData(projectRoot, params) {
  const assetPath = params.asset_path;
  const graphName = params.graph_name;
  const rawStartGuid = params.start_node_id;
  if (!graphName) throw new Error('Missing required parameter: graph_name');
  if (!rawStartGuid) throw new Error('Missing required parameter: start_node_id');

  const maxDepth = Math.max(1, Math.min(params.max_depth ?? 50, 500));

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const topology = extractBPEdgeTopologyFromCtx(ctx, assetPath);
  const g = resolveTopologyGraph(topology, assetPath, graphName);
  if (g.envelope) return g.envelope;

  const nodes = g.graph.nodes;
  // F-2 input bridge: see bpTraceExec.
  const startGuid = normalizeNodeGuidInput(rawStartGuid, nodes);
  if (!nodes[startGuid]) {
    return {
      available: false,
      reason: 'node_not_found',
      asset_path: assetPath,
      graph_name: graphName,
      start_node_id: startGuid,
    };
  }

  const sinks = [];
  const visited = new Set();
  let depthCapHit = false;
  let maxDepthReached = 0;

  const queue = [{ node_guid: startGuid, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur.node_guid)) continue;
    visited.add(cur.node_guid);
    if (cur.depth > maxDepthReached) maxDepthReached = cur.depth;
    if (cur.depth >= maxDepth) { depthCapHit = true; continue; }

    const node = nodes[cur.node_guid];
    if (!node) continue;
    for (const [pinId, pin] of Object.entries(node.pins)) {
      if (pin.direction !== 'EGPD_Output') continue;
      if (isExecPin(pin)) continue;
      for (const link of pin.linked_to) {
        const sinkNode = nodes[link.node_guid];
        const sinkPin = sinkNode?.pins?.[link.pin_id];
        sinks.push({
          from_node_guid: cur.node_guid,
          to_node_guid: link.node_guid,
          class_name: sinkNode?.class_name ?? null,
          source_pin: pinId,
          source_pin_name: pin.name,
          sink_pin: link.pin_id,
          sink_pin_name: sinkPin?.name ?? null,
          depth: cur.depth,
        });
        if (!visited.has(link.node_guid)) {
          queue.push({ node_guid: link.node_guid, depth: cur.depth + 1 });
        }
      }
    }
  }

  return {
    asset_path: assetPath,
    graph_name: graphName,
    start_node_id: startGuid,
    max_depth: maxDepth,
    max_depth_reached: maxDepthReached,
    truncated_at_depth: depthCapHit,
    sink_count: sinks.length,
    sinks,
    ...faBetaManifest([], ['exec_connectivity', 'pin_block']),
  };
}

// ── bp_neighbors ───────────────────────────────────────────────────────────
//
// Immediate-neighbor query. Returns edges adjacent to a target node in one
// or both directions. Each edge is annotated with `edge_kind` (exec|data)
// for client-side filtering. Self-loops are preserved per D70 invariant —
// they appear in `outgoing` only (not double-counted in `incoming`).
async function bpNeighbors(projectRoot, params) {
  const assetPath = params.asset_path;
  const graphName = params.graph_name;
  const rawNodeGuid = params.node_id;
  if (!graphName) throw new Error('Missing required parameter: graph_name');
  if (!rawNodeGuid) throw new Error('Missing required parameter: node_id');

  const directionFilter = params.direction ?? 'both';
  if (!['incoming', 'outgoing', 'both'].includes(directionFilter)) {
    throw new Error(`Invalid direction: ${directionFilter} (expected 'incoming', 'outgoing', or 'both')`);
  }

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const topology = extractBPEdgeTopologyFromCtx(ctx, assetPath);
  const g = resolveTopologyGraph(topology, assetPath, graphName);
  if (g.envelope) return g.envelope;

  const nodes = g.graph.nodes;
  // F-2 input bridge: see bpTraceExec.
  const nodeGuid = normalizeNodeGuidInput(rawNodeGuid, nodes);
  const target = nodes[nodeGuid];
  if (!target) {
    return {
      available: false,
      reason: 'node_not_found',
      asset_path: assetPath,
      graph_name: graphName,
      node_id: nodeGuid,
    };
  }

  const outgoing = [];
  const incoming = [];

  if (directionFilter !== 'incoming') {
    for (const [pinId, pin] of Object.entries(target.pins)) {
      if (pin.direction !== 'EGPD_Output') continue;
      for (const link of pin.linked_to) {
        const remote = nodes[link.node_guid];
        const remotePin = remote?.pins?.[link.pin_id];
        outgoing.push({
          node_guid: link.node_guid,
          class_name: remote?.class_name ?? null,
          local_pin: pinId,
          local_pin_name: pin.name,
          remote_pin: link.pin_id,
          remote_pin_name: remotePin?.name ?? null,
          edge_kind: isExecPin(pin) ? 'exec' : 'data',
        });
      }
    }
  }

  if (directionFilter !== 'outgoing') {
    // Walk every node's output pins looking for links into the target.
    // Self-loop handling: when direction='both', the self-loop is already
    // captured in `outgoing`; skip in the incoming scan to avoid
    // double-counting. When direction='incoming' alone, a self-loop IS
    // semantically an incoming edge — include it.
    const skipSelfLoops = directionFilter === 'both';
    for (const [remoteGuid, remoteNode] of Object.entries(nodes)) {
      if (skipSelfLoops && remoteGuid === nodeGuid) continue;
      for (const [remotePinId, remotePin] of Object.entries(remoteNode.pins)) {
        if (remotePin.direction !== 'EGPD_Output') continue;
        for (const link of remotePin.linked_to) {
          if (link.node_guid !== nodeGuid) continue;
          const localPin = target.pins?.[link.pin_id];
          incoming.push({
            node_guid: remoteGuid,
            class_name: remoteNode.class_name,
            local_pin: link.pin_id,
            local_pin_name: localPin?.name ?? null,
            remote_pin: remotePinId,
            remote_pin_name: remotePin.name,
            edge_kind: isExecPin(remotePin) ? 'exec' : 'data',
          });
        }
      }
    }
  }

  return {
    asset_path: assetPath,
    graph_name: graphName,
    node_id: nodeGuid,
    direction: directionFilter,
    incoming_count: incoming.length,
    outgoing_count: outgoing.length,
    incoming,
    outgoing,
    ...faBetaManifest([], ['exec_connectivity', 'pin_block']),
  };
}

// Guarded M-new verbs — ENOENT → FA-β graceful-degradation envelope.
export const bpTraceExecSafe = withAssetExistenceCheck(bpTraceExec);
export const bpTraceDataSafe = withAssetExistenceCheck(bpTraceData);
export const bpNeighborsSafe = withAssetExistenceCheck(bpNeighbors);

// Guarded M-spatial verbs — ENOENT becomes FA-β graceful-degradation envelope.
// Non-ENOENT errors still throw (D58 contract: distinguish absent from broken).
export const bpListGraphsSafe = withAssetExistenceCheck(bpListGraphs);
export const bpFindInGraphSafe = withAssetExistenceCheck(bpFindInGraph);
export const bpSubgraphInCommentSafe = withAssetExistenceCheck(bpSubgraphInComment);
export const bpListEntryPointsSafe = withAssetExistenceCheck(bpListEntryPoints);
export const bpShowNodeSafe = withAssetExistenceCheck(bpShowNode);
