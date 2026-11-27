import { readExportProperties } from './uasset-parser.mjs';
import { supportsInstancedStructLayout } from './uasset-structs.mjs';

const nameColumn = '/Script/Chooser.ChooserNameColumn';
const hardResult = '/Script/Chooser.AssetChooser';
const softResult = '/Script/Chooser.SoftAssetChooser';
const comparisons = new Set(['MatchEqual', 'MatchNotEqual', 'MatchAny']);
const fortniteMain = '86181d60844f64acded316aad6c7ea0d';
// Chooser stores its row migration version as a property. The serializer
// for soft result paths also uses FortniteMain's package custom version.
const tableVersions = new Map([[268, 3], [273, 4]]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

/** Interpret saved fields using the defaults of the qualified editor Chooser layout. */
export function assembleRawChooser(ctx, { asset_path }) {
  const mainVersion = ctx.summary.customVersions.find(row => row.key === fortniteMain)?.version;
  const tableVersion = tableVersions.get(mainVersion);
  if (!supportsInstancedStructLayout(ctx.summary) || tableVersion === undefined) {
    fail('UNSUPPORTED_CHOOSER_LAYOUT', 'Expected a supported editor package with row data');
  }
  const entry = ctx.exports.find(item => item.bIsAsset && item.outerIndex === 0 &&
    item.objectName === asset_path.split('/').at(-1) && ctx.resolve(item.classIndex)?.packagePath === '/Script/Chooser.ChooserTable');
  if (!entry) fail('NOT_CHOOSER_TABLE', 'Expected a Chooser table at the exact supplied package path');
  const stream = readExportProperties(ctx.buf, entry, ctx.names, ctx);
  if (!stream.terminated || stream.truncated) fail('UNSUPPORTED_CHOOSER_LAYOUT', 'Incomplete Chooser property stream');
  const p = stream.properties;
  if ((p.Version !== undefined && (!Number.isInteger(p.Version) || p.Version < 0 || p.Version > tableVersion)) ||
      [p.Results, p.Columns, p.Results_DEPRECATED, p.Columns_DEPRECATED].some(value =>
        value !== undefined && (!Array.isArray(value) || value.length > 0))) {
    fail('UNSUPPORTED_CHOOSER_LAYOUT', 'Chooser package needs an unqualified table version or legacy row conversion');
  }
  const issues = [];
  const array = (name, limit) => {
    const value = p[name] ?? [];
    if (!Array.isArray(value)) fail('UNSUPPORTED_CHOOSER_LAYOUT', 'Unsupported Chooser layout for ' + name);
    if (value.length > limit) fail('CHOOSER_TOO_LARGE', 'Chooser inspection limit exceeded for ' + name);
    return value;
  };
  const results = array('ResultsStructs', 2048);
  const sourceColumns = array('ColumnsStructs', 64);
  const disabled = array('DisabledRows', 2048);
  if (!disabled.every(value => typeof value === 'boolean')) fail('UNSUPPORTED_CHOOSER_LAYOUT', 'Invalid disabled row data');
  if (results.length * sourceColumns.length > 8192) fail('CHOOSER_TOO_LARGE', 'Chooser cell count exceeds inspection limit');
  function result(instance, position) {
    if (instance === undefined || (instance?.type === null && !instance.unsupported)) return null;
    const type = instance?.type ?? null;
    if ((type !== hardResult && type !== softResult) || !instance?.value) {
      issues.push({ reason: 'unsupported_result_type_or_layout', ...position });
      return { type };
    }
    const ref = instance.value.Asset;
    if (ref == null || (type === softResult && ref.assetPath === null && !ref.unsupported)) return { type, asset_path: null };
    const path = type === hardResult ? ref.packagePath : ref.assetPath;
    if (typeof path !== 'string' || ref.unsupported) {
      issues.push({ reason: 'unresolved_result_path', ...position });
      return { type };
    }
    return { type, asset_path: type === softResult && ref.subPath ? path + ':' + ref.subPath : path };
  }
  const rows = results.map((instance, row_index) => ({
    row_index, disabled: disabled[row_index] ?? false, cells: [], result: result(instance, { row_index }),
  }));
  const columns = sourceColumns.map((instance, column_index) => {
    const type = instance?.type ?? '';
    const fields = instance?.value;
    const desc = { column_index, type };
    if (fields && typeof (fields.bDisabled ?? false) === 'boolean') desc.disabled = fields.bDisabled ?? false;
    else if (fields) issues.push({ reason: 'missing_column_disabled_state', column_index });
    if (type !== nameColumn || !fields) {
      issues.push({ reason: 'unsupported_column_type_or_layout', column_index });
      return desc;
    }
    desc.on_unresolved_input = 'pass_all_rows';
    const input = fields.InputValue;
    const binding = input?.value?.Binding;
    if (input?.type === '/Script/Chooser.NameContextProperty' && binding && !binding.unsupported &&
        Number.isInteger(binding.ContextIndex ?? 0) && typeof (binding.IsBoundToRoot ?? false) === 'boolean' &&
        Array.isArray(binding.PropertyBindingChain ?? []) && (binding.PropertyBindingChain?.length ?? 0) <= 32 &&
        (binding.PropertyBindingChain ?? []).every(name => typeof name === 'string')) {
      desc.context_index = binding.ContextIndex ?? 0;
      desc.bound_to_root = binding.IsBoundToRoot ?? false;
      desc.property_chain = binding.PropertyBindingChain ?? [];
    } else issues.push({ reason: 'unsupported_or_oversized_input_binding', column_index });
    const cells = fields.RowValues ?? [];
    if (!Array.isArray(cells) || cells.length !== rows.length) issues.push({ reason: 'cell_count_mismatch', column_index });
    if (Array.isArray(cells)) {
      for (let r = 0; r < Math.min(rows.length, cells.length); r++) {
        const cell = cells[r];
        const comparison = typeof cell?.Comparison === 'string' ? cell.Comparison.split('::').at(-1) :
          (cell?.Comparison === undefined ? 'MatchEqual' : null);
        if (!cell || cell.unsupported || !comparisons.has(comparison) || typeof (cell.Value ?? 'None') !== 'string') {
          issues.push({ reason: 'unsupported_cell_layout', column_index, row_index: r });
        } else rows[r].cells.push({ column_index, value: cell.Value ?? 'None', comparison });
      }
    }
    return desc;
  });
  const fallback = result(p.FallbackResult, { fallback: true });
  const payload = { schema_version: 1, asset_path, columns, rows, fallback, complete: issues.length === 0, issues };
  if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) fail('CHOOSER_TOO_LARGE', 'Chooser inspection output exceeds size limit');
  return payload;
}
