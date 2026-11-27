// URigVMLink::Serialize writes the two pin paths in source-to-target order.
// The GUID uses the byte order returned by Cursor.readGuid for a serialized FGuid.
const rigVMVersionKey = '9b9549dce74dc05388ea5691395d7c5e';
const unsupportedPackageFlags = 0x200 | 0x2000 | 0x80000000; // cooked, unversioned properties, filtered editor data

export function supportsSavedRigModel(summary) {
  const version = summary.customVersions.find(entry => entry.key === rigVMVersionKey)?.version;
  // Editor packages verified against the installed 5.8 / 5.9 RigVM module.
  return summary.fileVersionUE5 === 1018 && [25, 27].includes(version)
    && (summary.packageFlags & unsupportedPackageFlags) === 0;
}

function readRigVMLink(cursor, { summary }) {
  if (!supportsSavedRigModel(summary)) throw new Error('Unsupported RigVM editor package version or flags');
  if (cursor.remaining() > 2 * 256 * 1024 + 8) throw new Error('RigVM link text exceeds budget');
  return { SourcePinPath: cursor.readFString(), TargetPinPath: cursor.readFString() };
}

export const nativeExportDecoders = new Map([
  ['/Script/RigVMDeveloper.RigVMLink', readRigVMLink],
]);
