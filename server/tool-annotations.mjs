import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';

const REFLECT_APPLY = Reflect.apply;
const REFLECT_GET = Reflect.get;
const REFLECT_HAS = Reflect.has;

function captureSetDescriptor(property) {
  return Object.freeze(Object.getOwnPropertyDescriptor(Set.prototype, property));
}

const SET_READ_DESCRIPTORS = Object.freeze({
  size: captureSetDescriptor('size'),
  has: captureSetDescriptor('has'),
  keys: captureSetDescriptor('keys'),
  values: captureSetDescriptor('values'),
  entries: captureSetDescriptor('entries'),
  iterator: captureSetDescriptor(Symbol.iterator),
  forEach: captureSetDescriptor('forEach'),
  union: captureSetDescriptor('union'),
  intersection: captureSetDescriptor('intersection'),
  difference: captureSetDescriptor('difference'),
  symmetricDifference: captureSetDescriptor('symmetricDifference'),
  isSubsetOf: captureSetDescriptor('isSubsetOf'),
  isSupersetOf: captureSetDescriptor('isSupersetOf'),
  isDisjointFrom: captureSetDescriptor('isDisjointFrom'),
});

const SET_READ_METHODS = Object.freeze(Object.assign(Object.create(null), {
  has: SET_READ_DESCRIPTORS.has.value,
  keys: SET_READ_DESCRIPTORS.keys.value,
  values: SET_READ_DESCRIPTORS.values.value,
  entries: SET_READ_DESCRIPTORS.entries.value,
  [Symbol.iterator]: SET_READ_DESCRIPTORS.iterator.value,
  union: SET_READ_DESCRIPTORS.union.value,
  intersection: SET_READ_DESCRIPTORS.intersection.value,
  difference: SET_READ_DESCRIPTORS.difference.value,
  symmetricDifference: SET_READ_DESCRIPTORS.symmetricDifference.value,
  isSubsetOf: SET_READ_DESCRIPTORS.isSubsetOf.value,
  isSupersetOf: SET_READ_DESCRIPTORS.isSupersetOf.value,
  isDisjointFrom: SET_READ_DESCRIPTORS.isDisjointFrom.value,
}));

const MANAGEMENT_SESSION_STATE_TOOL_NAMES = Object.freeze([
  'connection_info',
  'detect_project',
  'find_tools',
  'enable_toolset',
  'disable_toolset',
  'attach_project',
  'detach_project',
  'refresh_project_context',
  // Probing updates layer health status, so this is not purely read-only —
  // same treatment as connection_info(force_reconnect).
  'wait_for_editor',
]);
const managementSessionStateToolSet = new Set(MANAGEMENT_SESSION_STATE_TOOL_NAMES);

const managementSessionStateTools = new Proxy(managementSessionStateToolSet, {
  get(target, property) {
    if (property === 'add' || property === 'delete' || property === 'clear') {
      return undefined;
    }
    if (property === 'size') {
      return REFLECT_APPLY(SET_READ_DESCRIPTORS.size.get, target, []);
    }
    if (property === 'forEach') {
      return (callback, thisArg) => REFLECT_APPLY(SET_READ_DESCRIPTORS.forEach.value, target, [
        (value, key) => REFLECT_APPLY(callback, thisArg, [value, key, managementSessionStateTools]),
      ]);
    }
    const readMethod = SET_READ_METHODS[property];
    if (readMethod !== undefined) {
      return (...args) => REFLECT_APPLY(readMethod, target, args);
    }
    return REFLECT_GET(target, property, managementSessionStateTools);
  },
  has(target, property) {
    if (property === 'add' || property === 'delete' || property === 'clear') {
      return false;
    }
    return REFLECT_HAS(target, property);
  },
});
export const MANAGEMENT_SESSION_STATE_TOOLS = Object.freeze(managementSessionStateTools);

export function getToolAnnotations(toolName, requirement) {
  let annotations;

  switch (requirement) {
    case TOOL_REQUIREMENT_KINDS.OFFLINE_READ:
    case TOOL_REQUIREMENT_KINDS.LIVE_READ:
    case TOOL_REQUIREMENT_KINDS.RC_READ:
      annotations = { readOnlyHint: true };
      break;
    case TOOL_REQUIREMENT_KINDS.LIVE_MUTATION:
    case TOOL_REQUIREMENT_KINDS.RC_MUTATION:
    case TOOL_REQUIREMENT_KINDS.PYTHON_EXEC:
      annotations = { readOnlyHint: false, destructiveHint: true };
      break;
    case TOOL_REQUIREMENT_KINDS.MANAGEMENT:
      annotations = MANAGEMENT_SESSION_STATE_TOOLS.has(toolName)
        ? { readOnlyHint: false, destructiveHint: false }
        : { readOnlyHint: true };
      break;
    default:
      throw new Error(`Unknown tool requirement kind: ${requirement}`);
  }

  return Object.freeze(annotations);
}
