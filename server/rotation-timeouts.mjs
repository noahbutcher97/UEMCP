export const DEFAULT_ROTATION_FILE_TIMEOUT_MS = 5 * 60 * 1000;

// These suites retain bounded process and Windows-native integration lanes.
export const ROTATION_FILE_TIMEOUT_OVERRIDES_MS = Object.freeze({
  'test-client-transaction.mjs': 8 * 60 * 1000,
  'test-deployment-contracts.mjs': 8 * 60 * 1000,
});

export function rotationFileTimeoutMs(file) {
  if (typeof file !== 'string' || !/^test-[^/\\]+\.mjs$/.test(file)) {
    throw new TypeError('rotation file must be a test basename');
  }
  return Object.hasOwn(ROTATION_FILE_TIMEOUT_OVERRIDES_MS, file)
    ? ROTATION_FILE_TIMEOUT_OVERRIDES_MS[file]
    : DEFAULT_ROTATION_FILE_TIMEOUT_MS;
}
