# Owned asset-info and package-parser checks

From `server/`, run the combined required profile:

```sh
npm test -- --test-profile owned-asset-parser
node run-rotation.mjs --test-profile owned-asset-parser --json
```

The profile requires all 22 asset-info/cache cases and all 16 package-parser
cases exactly once, with source identity and four required inputs: the saved
package, manifest, UE oracle and historical authoring source. Missing files,
omitted cases and skipped cases cannot satisfy the required profile. Individual
profiles are `owned-asset-info` (22 cases, four inputs) and
`owned-package-parser` (16 cases, three corpus inputs). The default `npm test`
rotation discovers both `test-*.mjs` files automatically; no package script or
runner changes are needed to register them.

Asset-info checks cover authored identity, metadata and cache reuse/invalidation,
including missing files and corruption. Parser checks use frozen raw-byte
expectations for one hash-pinned UE5.6 saved package: table descriptors/boundaries,
eight export tuples and the Blueprint/generated-class registry pair. Mutations
of copied buffers exercise malformed magic, truncation, wrong layout metadata
and int64 overflow. The wrong-version and overflow mutations are artificial
controls, not saved legacy packages or actual VFX assets.

These are partial supplements to existing tests. Consumer-specific counts/tags,
World/DataTable fixtures, numbered references, legacy layouts, strict/lenient
Cursor contracts, real VFX salvage, and native/runtime qualification remain
retained. Existing owned version identity and topology checks are prerequisites,
not new parser coverage. These profiles authorize no test retirement and make
no claim of complete ledger equivalence or cross-platform qualification.
