# Owned text-project reads and MCP wire

Run from `server/`:

```powershell
node run-rotation.mjs --test-profile owned-project-reads --json
```

This additive engine-free profile requires all 22 named witnesses in
`test-owned-project-reads.mjs`. It reads the committed `UEMCPFixture` text
project explicitly and pins normalized SHA-256 hashes of its descriptor,
`DefaultGameplayTags.ini`, and `DefaultEngine.ini`. No environment-selected
consumer project, Unreal process, or saved asset is required.

The expectations are authored constants: project/module identity, the four
plugin declarations and their enablement, four tags with comments and complete
hierarchy, exact glob membership (including single-segment, case-insensitive,
and no-match controls), and selected config sections/value arrays. Declared
plugins are separate from the fixture's empty local plugin installation list.

MCP witnesses use `createUemcpServer`, production tool registration and real
offline handlers behind `FakeMcpTransport`. They initialize, manually attach
an explicit project with `env: {}`, and check content shape and `isError`
before parsing successful text. Missing config and a disposable project root
removed after attachment produce actual handler error envelopes. Subsequent
successful calls demonstrate that error handling did not abort the session.
Servers close in `finally`; all disposable roots use guarded scratch helpers.
No production behavior is changed by this profile.

## Bounded migration map

| Legacy obligation retained | Added named witness family |
| --- | --- |
| `test-phase1`: generic project info | direct exact identity/modules/plugins; wire exact project payload |
| `test-phase1`: gameplay tag listing | direct exact count/comments/hierarchy; wire exact hierarchy |
| `test-phase1`: all-tags and descendant globs | six direct patterns; real wire descendants and no-match control |
| `test-phase1`: plugin listing | exact declarations/enablement versus local installation |
| `test-phase1`: config read | exact section/key values; missing key/file controls |
| `test-mcp-wire`: real-handler happy path and error text | real project/tag/glob tools/call, missing-root/config envelopes, recovery, decoder rejection controls |

This is fresh bounded coverage, not equivalence approval or test retirement.
Existing phase1, MCP wire and consumer-contract suites remain unchanged.
Their broader schema/coercion, notifications, truncation, consumer assets,
compatibility, and scale obligations are retained. Invalid ambient roots still
expose their separately inventoried assumptions; this profile does not silently
skip those failures or fix the legacy MCP wire test's unconditional JSON parse.
It also does not qualify the separate explicit-env startup fix, toolset lifecycle,
registry budget/cache, or metadata isolation units.
