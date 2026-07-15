function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const PROPERTY_READ_REASON_GROUPS = deepFreeze({
  parserCore: {
    unknownStruct: 'unknown_struct',
    unknownPropertyType: 'unknown_property_type',
    unexpectedPreamble: 'unexpected_preamble',
    serialRangeOutOfBounds: 'serial_range_out_of_bounds',
    valueOverrunsSerial: 'value_overruns_serial',
    tagHeaderReadFailed: 'tag_header_read_failed',
    propertyTagExtensions: 'property_tag_extensions',
    valueReadFailed: 'value_read_failed',
    delegateNotSerialized: 'delegate_not_serialized',
    localizedText: 'localized_text',
    sizeBudgetExceeded: 'size_budget_exceeded',
  },
  containers: {
    complexElementContainer: 'complex_element_container',
    containerCountUnreasonable: 'container_count_unreasonable',
    setWithRemovedItems: 'set_with_removed_items',
    mapWithRemovedItems: 'map_with_removed_items',
    mapTypeParamsMissing: 'map_type_params_missing',
    mapKeyTypeUnsupported: 'map_key_type_unsupported',
    mapValueTypeUnsupported: 'map_value_type_unsupported',
    mapValueStructNameMissing: 'map_value_struct_name_missing',
    structKeyMap: 'struct_key_map',
  },
  structLayouts: {
    bodyInstanceNativeLayoutUnknown: 'body_instance_native_layout_unknown',
  },
  boundedSubobject: {
    subobjectBudgetExhausted: 'subobject_budget_exhausted',
  },
});

export const CONFIGURED_PROPERTY_READ_REASON_CODES = Object.freeze(
  Object.values(PROPERTY_READ_REASON_GROUPS).flatMap(group => Object.values(group)),
);

export const GENERIC_CONTAINER_FALLBACK_REASON = 'container_deferred';

export const REQUIRED_CONTAINER_PROPERTY_TYPES = Object.freeze([
  'ArrayProperty',
  'SetProperty',
  'MapProperty',
]);

