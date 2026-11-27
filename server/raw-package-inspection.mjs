import { createHash } from 'node:crypto';
import { parsePropertyReadBuffer } from './offline-core.mjs';
import { readInspectionSource } from './saved-inspection-snapshot.mjs';
import { Cursor, parseSummary, PKG_FILTER_EDITOR_ONLY, PKG_UNVERSIONED_PROPERTIES } from './uasset-parser.mjs';

export async function readPackageInspection(projectRoot, args, checkAttachment = () => {}) {
  if (args.max_pins !== undefined && (args.kind !== 'rigvm' || !Number.isInteger(args.max_pins) ||
      args.max_pins < 1 || args.max_pins > 4096)) throw new Error('max_pins requires rigvm and an integer from 1 to 4096.');
  const bytes = await readInspectionSource(projectRoot, args);
  checkAttachment();
  const summary = parseSummary(new Cursor(bytes));
  const cookedFlag = 0x200;
  if (summary.packageFlags & (cookedFlag | PKG_UNVERSIONED_PROPERTIES | PKG_FILTER_EDITOR_ONLY)) {
    throw new Error('Direct inspection requires a versioned editor package with editor data.');
  }
  if (summary.packageName && summary.packageName !== 'None' && summary.packageName !== args.asset_path) {
    throw new Error('Saved package identity differs from the requested asset path.');
  }
  const ctx = parsePropertyReadBuffer(bytes);
  const payload = args.kind === 'rigvm'
    ? (await import('./rigvm-package.mjs')).inspectRawRigVM(ctx, args)
    : (await import('./raw-chooser-inspection.mjs')).assembleRawChooser(ctx, args);
  checkAttachment();
  return {
    ...payload,
    origin: 'raw_package',
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    package_version: summary.fileVersionUE5,
  };
}
