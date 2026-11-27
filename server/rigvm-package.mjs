import { supportsSavedRigModel } from './native-export-decoders.mjs';
import { readExportProperties } from './uasset-parser.mjs';

const modelModule = '/Script/RigVMDeveloper.';
const graphClass = modelModule + 'RigVMGraph';
const libraryClass = modelModule + 'RigVMFunctionLibrary';
const pinClass = modelModule + 'RigVMPin';
const linkClass = modelModule + 'RigVMLink';
const directions = new Set(['Input', 'Output', 'IO', 'Visible', 'Hidden', 'Invalid']);
// A package import identifies its exact class, but usually lacks a usable
// superclass hierarchy. These native node classes are defined by RigVMDeveloper.
const nodeClasses = new Set([
  'RigVMNode', 'RigVMAggregateNode', 'RigVMCollapseNode', 'RigVMCommentNode',
  'RigVMDispatchNode', 'RigVMEnumNode', 'RigVMFunctionEntryNode', 'RigVMFunctionInterfaceNode',
  'RigVMFunctionReferenceNode', 'RigVMFunctionReturnNode', 'RigVMInvokeEntryNode',
  'RigVMLibraryNode', 'RigVMParameterNode', 'RigVMRerouteNode', 'RigVMTemplateNode',
  'RigVMUnitNode', 'RigVMVariableNode',
].map(name => modelModule + name));

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function inspectRawRigVM(ctx, { asset_path: assetPath, max_pins: maxPins = 4096 }) {
  if (!Number.isInteger(maxPins) || maxPins < 1 || maxPins > 4096) {
    fail('INVALID_ARGUMENT', 'max_pins must be an integer in [1,4096]');
  }
  if (!supportsSavedRigModel(ctx.summary)) {
    fail('UNSUPPORTED_RIGVM_LAYOUT', 'The package has no supported editor model version');
  }
  const issues = new Set(), graphs = [], visited = new Set(), fields = new Map();
  let nodeCount = 0, pinCount = 0, linkCount = 0, textUnits = 0;
  const cls = entry => ctx.resolve(entry?.classIndex)?.packagePath;
  const entryAt = ref => ref?.packageIndex > 0 ? ctx.exports[ref.packageIndex - 1] : null;
  const tooLarge = () => fail('RIGVM_INSPECTION_LIMIT', 'RigVM model exceeds the graph, node, pin, link or text budget');
  function text(value) {
    textUnits += value?.length ?? 0;
    if (textUnits > 256 * 1024) tooLarge();
    return value;
  }
  function properties(entry, label) {
    if (!fields.has(entry)) {
      const result = readExportProperties(ctx.buf, entry, ctx.names, ctx);
      if (!result.terminated || result.truncated) issues.add(label + ': incomplete export payload');
      fields.set(entry, result.properties);
    }
    return fields.get(entry);
  }
  function refs(value, location, remaining) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { issues.add(location + ': unreadable references'); return []; }
    if (value.length > remaining) tooLarge();
    return value;
  }
  function owned(ref, owner, type, label) {
    const entry = entryAt(ref);
    if (!entry || entry.outerIndex !== owner || (type && cls(entry) !== type)) {
      issues.add(label + ': unresolved or misowned export');
      return null;
    }
    return entry;
  }

  function pinsOf(nodeRef, node, nodeFields, label) {
    const pins = [], pending = [], seen = new Set();
    function enqueue(list, owner, prefix) {
      for (const ref of refs(list, label + ': Pins', maxPins - pinCount)) {
        if (++pinCount > maxPins) tooLarge();
        const pin = owned(ref, owner, pinClass, label);
        if (!pin) continue;
        const path = text(prefix + '.' + pin.objectName);
        if (seen.has(path)) { issues.add(label + ': duplicate pin ' + path); continue; }
        seen.add(path);
        pending.push({ ref, pin, path });
      }
    }
    enqueue(nodeFields.Pins, nodeRef.packageIndex, node.objectName);
    for (let i = 0; i < pending.length; i++) {
      const { ref, pin, path } = pending[i];
      const data = properties(pin, label + '.' + path);
      const type = typeof data.CPPType === 'string' ? data.CPPType : '';
      const direction = (typeof data.Direction === 'string' ? data.Direction.split('::').pop() : 'Invalid');
      if (!type || !directions.has(direction)) issues.add(label + '.' + path + ': unknown pin type or direction');
      enqueue(data.SubPins, ref.packageIndex, path);
      // Native getters can build aggregate defaults from subpins, reflected types and traits.
      // An on-disk literal for those cases can differ from the editor's evaluated default.
      const aggregate = data.SubPins?.length > 0 || type.startsWith('TArray<') || data.DefaultValueObject ||
        (data.CPPTypeObject && !['FName', 'FString'].includes(type));
      const literal = data.DefaultValue ?? '';
      if (aggregate || typeof literal !== 'string') issues.add(label + '.' + path + ': default needs type-specific interpretation');
      pins.push({ path, type: text(type), direction, default: aggregate || typeof literal !== 'string' ? null : text(literal) });
    }
    if (nodeFields.OrphanedPins !== undefined) issues.add(label + ': orphaned pins omitted');
    return pins;
  }

  function graph(ref, owner, parentPath) {
    const entry = owned(ref, owner, null, parentPath ?? 'RigVMClient');
    if (!entry) return;
    const type = cls(entry);
    if (type !== graphClass && type !== libraryClass) { issues.add(entry.objectName + ': unsupported graph class'); return; }
    if (visited.has(ref.packageIndex)) { issues.add(entry.objectName + ': repeated graph membership'); return; }
    visited.add(ref.packageIndex);
    if (visited.size > 128) tooLarge();
    const path = text(parentPath ?? (type === libraryClass ? 'FunctionLibrary::' : entry.objectName + '::'));
    const data = properties(entry, path), nodes = [], links = [], nested = [], endpoints = new Set(), members = new Set();
    graphs.push({ path, nodes, links });
    for (const nodeRef of refs(data.Nodes, path + ': Nodes', 1024 - nodeCount)) {
      nodeCount++;
      const node = owned(nodeRef, ref.packageIndex, null, path);
      if (!node) continue;
      const label = path + '|' + node.objectName;
      const nodeClass = cls(node);
      if (!nodeClasses.has(nodeClass)) { issues.add(label + ': unsupported node class ' + nodeClass); continue; }
      if (members.has(node.objectName)) { issues.add(label + ': repeated node membership'); continue; }
      members.add(node.objectName);
      const nodeFields = properties(node, label);
      const pins = pinsOf(nodeRef, node, nodeFields, label);
      for (const pin of pins) endpoints.add(pin.path);
      nodes.push({ name: text(node.objectName), class: text(nodeClass), pins });
      if (nodeFields.ContainedGraph) nested.push([nodeFields.ContainedGraph, nodeRef.packageIndex, label]);
    }
    for (const linkRef of refs(data.Links, path + ': Links', 4096 - linkCount)) {
      linkCount++;
      const link = owned(linkRef, ref.packageIndex, linkClass, path);
      if (!link) continue;
      const pair = properties(link, path + '|' + link.objectName);
      if (!endpoints.has(pair.SourcePinPath) || !endpoints.has(pair.TargetPinPath)) {
        issues.add(path + '|' + link.objectName + ': unresolved link'); continue;
      }
      links.push({ source: text(pair.SourcePinPath), target: text(pair.TargetPinPath) });
    }
    for (const args of nested) graph(...args);
  }

  const leaf = assetPath.split('/').pop();
  const mainIndex = ctx.exports.findIndex(e => e.bIsAsset && e.outerIndex === 0 && e.objectName === leaf);
  if (mainIndex < 0) fail('NOT_RIGVM_ASSET', 'Expected a matching primary asset export');
  let owner = mainIndex + 1;
  let data = properties(ctx.exports[mainIndex], assetPath);
  if (!data.RigVMClient && data.EditorAsset) {
    const editorAsset = entryAt(data.EditorAsset);
    if (editorAsset) { owner = data.EditorAsset.packageIndex; data = properties(editorAsset, editorAsset.objectName); }
  }
  const client = data.RigVMClient;
  if (!client || !Array.isArray(client.Models)) fail('NOT_RIGVM_ASSET', 'The saved asset has no readable RigVM client model list');
  for (const ref of refs(client.Models, assetPath + ': Models', 128)) graph(ref, owner);
  if (client.FunctionLibrary) graph(client.FunctionLibrary, owner);
  return { schema_version: 1, asset_path: assetPath, complete: !issues.size, issues: [...issues], graphs };
}
