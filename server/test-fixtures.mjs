// test-fixtures.mjs — Shared fixture constants + drift policy for integration tests.
//
// ═══════════════════════════════════════════════════════════════════════════
// PROJECT-SPECIFIC FIXTURE DEPENDENCY
// ═══════════════════════════════════════════════════════════════════════════
//
// Tests importing from this module reference ProjectA-specific assets. Expected
// values derived from these constants (e.g., generated-class suffix, CDO export
// name) will drift when the referenced assets are renamed or refactored.
//
// Symptoms: assertion failures on clean HEAD that reference these constants.
//
// Fix patterns:
//   1. Asset renamed/moved: update the `path` field on the affected entry;
//      derived names (`generatedClassName`, `cdoExportName`, `name`) flow
//      through automatically.
//   2. Asset deleted or refactored beyond recognition: swap to a sibling asset
//      that exercises the same parser code path (e.g., D71 BP_OSPlayerR →
//      BP_OSPlayerR_VikramProto swap).
//   3. Asset content drift (property removed, graph restructured): update the
//      per-test structural threshold or soften the assertion (e.g., replace a
//      specific member name check with a structural "at least one K2Node of
//      class X" check).
//
// See D71 + D75 (docs/tracking/risks-and-decisions.md) for prior drift-fix
// incidents and the fixture-philosophy rationale (D73 + Noah's 2026-04-22
// guidance).
//
// Byte-level decode coverage lives in test-uasset-parser.mjs via synthetic
// helpers (no project fixtures). This module is for integration-level tests
// that exercise the full executeOfflineTool pipeline on real assets — the
// tier-3 "keep project-specific, frame honestly" option.
// ═══════════════════════════════════════════════════════════════════════════

// A GAS ability BP with rich FGameplayTag CDO defaults and a well-known parent
// class. Exercises: CDO export resolution, variable_defaults decoding,
// FGameplayTag struct handler, property filtering, parent-class import
// resolution.
export const GAS_ABILITY_BP = deriveBpNames('/Game/GAS/Abilities/BPGA_Block');

// Primary player character BP — graph-rich asset used for find_blueprint_nodes,
// bp_list_graphs, bp_show_node coverage. Has multiple graphs (EventGraph +
// UserConstructionScript + function graphs), many skeletal K2Nodes, at least
// one EdGraphNode_Comment.
export const PLAYER_BP = deriveBpNames('/Game/Blueprints/Character/BP_OSPlayerR');

// Medium-complexity dev map for list_level_actors placed-actor walking and
// transform decoding.
export const DEV_TEST_MAP = { path: '/Game/Developers/steve/Steve_TestMap' };

// Content map used for F4 placed-actor-filter coverage (must have K2Node /
// Function exports alongside placed actors).
export const MARKETPLACE_MAP = { path: '/Game/Maps/Deployable/MarketPlace/MarketPlace_P' };

// Smaller map used for export-table + import-resolution walking.
export const BEAUTIFUL_CORNER_MAP = { path: '/Game/Maps/Deployable/MarketPlace/Beautiful_Corner' };

// Path prefixes used by bulk-scan tests.
export const ABILITIES_PREFIX = '/Game/GAS/Abilities';
export const CHARACTERS_PREFIX = '/Game/Characters';
export const BLUEPRINTS_PREFIX = '/Game/Blueprints';
export const GAME_ROOT_PREFIX = '/Game/';

// ─── Helpers ─────────────────────────────────────────────────────────────

function deriveBpNames(path) {
  const name = path.split('/').pop();
  return {
    path,
    name,
    generatedClassName: `${name}_C`,
    cdoExportName: `Default__${name}_C`,
  };
}
