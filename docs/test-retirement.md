# Test retirement protocol

Use this protocol when a migration proposes removing an existing test, assertion, fixture dependency, or required execution lane. Adding replacement coverage does not by itself authorize removal. Keep private fixture identities and evidence in the access-controlled coverage ledger; public records use stable IDs and non-sensitive descriptions.

## Classification

Project-dependent describes a prerequisite, not deprecation. A skipped test, inconvenient fixture, old engine, duplicate-looking name, or new suite with more assertions is not grounds for retirement.

Classify each proposed assertion/branch, not just its enclosing suite:

- **Retain unchanged:** already independent or still a unique witness.
- **Partially migrated:** owned cases prove a subset; list each remaining obligation.
- **Equivalent replacement demonstrated:** every scoped semantic and failure witness has reviewed required execution evidence; deletion remains unapproved.
- **Retain compatibility adapter:** project/version-specific behavior remains valuable, with an explicit owner, prerequisites, and command. Optional skips do not qualify a required run.
- **Approved for retirement / retired:** record the exact approved deletion and, later, its merged commit. Preserve the historical record.

Use *deprecated* only for a named contract or implementation with a recorded owner decision to withdraw support, or a duplicate whose full replacement has been demonstrated. Withdrawal of supported behavior is a separate product decision, never an implicit consequence of test migration.

## Required retirement record

For each candidate, record its stable inventory ID, source revision/path, assertion and conditional-branch identities, inherited gates, positive/negative/error expectations, and fixture/engine/consumer assumptions. Map each to exact replacement case IDs and any retained adapter. Record unmet obligations explicitly; do not turn partial rows into completed rows.

Evidence must include:

1. **Baseline and equivalence:** execute the original scoped witnesses with their real prerequisites and record actual branch execution. An unavailable original witness leaves a blocker unless an independently reviewed alternative establishes the same obligation. Compare semantics, boundaries, error envelopes, malformed inputs, empty cases, ordering, limits, and recovery behavior where applicable. Preserve unique consumer values, graph complexity, old saved formats and version-specific defects. Modern synthetic fixtures cannot discharge those obligations merely by passing.
2. **Failure sensitivity:** show replacement cases reject representative defects in each scoped behavior and reject missing/duplicate/skipped/failed required cases or absent/corrupt inputs. Negative controls must first establish a valid baseline. Reuse existing controls when they prove the obligation; do not demand artificial one-to-one assertion counts.
3. **Required independent execution:** run the replacement on the exact candidate source with active-project settings cleared and with a deliberately invalid ambient project value. It must execute the required names, not silently skip or fall back to a consumer project. Exercise retained adapters separately with their prerequisites. Native, live, rendered and installed-client claims require their actual lanes; a Node/mock pass cannot replace them. Run applicable lint, focused tests, aggregate and exact-head CI.
4. **Provenance:** retain source HEAD/dirty patch and raw input inventories/hashes, profile identity, fixture authoring/export/reload provenance, engine/platform/capability identity where relevant, command, report and execution errors. Explain any historical text normalization separately. Goldens must not regenerate during normal tests.
5. **Independent review and approval:** prepare a concrete proposed deletion diff for review; an independent reviewer verifies the mapping, uncovered branches, failure controls, retained compatibility and that diff. Obtain explicit maintainer/user retirement approval referencing that record and exact scope. Approval to build a replacement or publish its PR is not approval to delete the old witness. Changes that invalidate reviewed evidence require renewed validation and approval of the changed scope.
6. **Removal and recovery:** apply the reviewed deletion only within the explicit approved scope, preserve required enforcement, and verify the final diff removes only approved assertions/dependencies. Rerun affected checks and exact-head CI; log the retirement commit. Archive recoverable source/fixture references and reports under existing retention rules before deletion. Keep private assets private. If replacement coverage or provenance regresses, restore the old witness/dependency from the recorded commit, reopen its ledger obligation, and revalidate; do not paper over the gap by making the required lane optional.

## Migration acceptance workflow

Every future slice ends with a retirement decision, even when the decision is **retain: partial**. Extend its acceptance record with classification, scoped old-to-new witness map, residual obligations, evidence links/source identity, reviewer, approval reference, final retirement commit (or `not approved`), and recovery commit/artifact reference. Preserve all existing coverage IDs. No ledger schema rewrite or new runner is needed to adopt these fields in a companion record.

Replacement implementation and retirement can be separate commits/PRs. Keep the old witness until approval and proof are complete; do not leave retirement as an assumed consequence of a larger passing total. Report suites, named cases, internal assertions and inventory rows separately. The coverage ledger contains mixed kinds and aliases, so raw row counts do not establish a global migration percentage.

## Concrete next candidate: INV-160 pin inspection

Candidate scope: the `bp_show_node` pin-block section of `server/test-verb-surface.mjs`, rather than the whole suite. **Currently ineligible for retirement.** The required `owned-blueprint-query` profile supplies exact oracle-bound pin IDs/names/directions/links, availability/not-available field checks and an authored literal. It does not assert the original section's pin-kind classification, rejection of null object defaults, or distinct small-package default and autogenerated-default values. Its consumer/package diversity is not established by the two-node UE5.6 fixture. The original object-default assertion rejects null; it does not by itself prove property omission. The mapping must distinguish that predicate, any proposed stronger omission check, and the obligations already witnessed from these concrete gaps.

Before proposing removal, map and qualify those individual assertions and failure controls, establish the genuine consumer/legacy disposition, and review exact equivalence. Retain the original section meanwhile. INV-112/160/270 remain partial; this protocol changes no coverage status.

Related guidance: [owned Blueprint query coverage and limits](owned-blueprint-query.md), [fixture host](fixture-host.md), and [current repository testing guidance](../CLAUDE.md).
