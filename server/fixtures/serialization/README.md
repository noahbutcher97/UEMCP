# Owned serialization corpus

This directory holds immutable UE-authored test packages and independent UE API
references. Missing packages are failures in `node test-owned-serialization.mjs`.
Normal tests never regenerate expected data. Synthetic legacy boundary and
malformed-input coverage remains in `test-legacy-blueprint-topology.mjs`.

The initial required corpus is **ue5.6-owned-v1 only**. Genuine old-engine
authoring remains unqualified: the local UE 5.3 plugin build is blocked by
existing `AssetEditorCaptureHandler.cpp` calls to
`IDetailsView::ScrollPropertyIntoView` at lines 191 and 251, unavailable in that
engine. `ue5.3-owned-v1` remains an explicit supported authoring target for a
future successful build, not an optional passing test or a checked-in binary.
This modern corpus makes no genuine legacy-package qualification claim. The
existing synthetic legacy and consumer compatibility tests remain unchanged.

Author each version in a fresh staged UEMCPFixture host built with that engine:

1. Run `UnrealEditor-Cmd.exe <host.uproject> -run=AuthorSerializationFixture -unattended -NullRHI -nosplash -nop4`.
2. In a **separate process**, run `UnrealEditor-Cmd.exe <host.uproject> -run=DumpBPGraph -BP=/Game/Serialization/BP_OwnedLink -Out=<oracle.json> -Pretty -unattended -NullRHI -nosplash -nop4`.
3. From `server`, run `node finalize-owned-serialization.mjs <ue5.3-owned-v1|ue5.6-owned-v1> <host-directory> <oracle.json> <engine-root>`.
4. Run `node test-owned-serialization.mjs`; review the package version, custom
   versions, source digests, engine Build.version, hashes and topology together.

The commandlet creates an original custom event connected to PrintString. No
Epic sample, engine content, game content, or consumer package is copied. Node
GUIDs are fixed, including nontrivial high bits to exercise GUID decoding. UE
save operations need not produce byte-identical packages; immutable byte hashes
bind each approved save to its reference. An independently reloaded UE graph is
the reference, never Node parser output. The verifier requires exact node GUIDs,
classes, unique pin names/directions and directed links. Pin-ID changes from UE
post-load reconstruction are tolerated only through this unambiguous mapping.

UE 5.3 must actually save a pre-1012 package; UE 5.6 must save 1012 or newer. The
verifier checks real headers and rejects the wrong boundary. Never patch package
version bytes or resave the legacy fixture in the modern engine. These initial
fixtures do not replace realistic consumer/custom-version compatibility cases.

Finalization refuses overwrites. Retain engine author/export logs with the local
source-state evidence; review regeneration as an explicit fixture change. Each
manifest records original ownership (without asserting an additional license
grant), engine build, saved versions/custom versions, save mode, staged
author/export source hashes and file hashes. Finalization verifies the owning
host manifest, every staged source, reviewed allowlist and exact engine identity.
It retains the original invocation, source HEAD and dirty patch digest; later
checkout edits are not falsely described as the authoring source. Input or
verification failures never leave a partially finalized version directory.
