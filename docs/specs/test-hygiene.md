# Test hygiene

Fixture subprocesses must not write disposable project names into the developer
checkout's `known-test-targets.txt` or `forbidden-tokens` files. In-process tests
use the existing `writeProjectCodenames: false` factory option. Subprocess tests
that attach fixtures use `server/fixtures/stdio-test-server.mjs`: it runs the
production factory and stdio transport with only codename registration disabled.
The production `server.mjs` retains registration; there is no environment flag
to bypass it. Registration itself is tested with disposable metadata directories,
including real short project names and Windows drive roots.

Owned material/isolation runners use the same isolated launcher. Their UE source,
transport ownership checks, schemas and native tools are unchanged. No editor
launch is required to test metadata isolation: the official SDK stdio regression
attaches a synthetic project and compares the developer ledger byte-for-byte.

Windows hook syntax checks resolve Bash from the installed Git executable or a
standard Git installation. They do not launch the WSL shim on PATH or rewrite
PATH globally. Missing Git Bash fails the Windows syntax check. POSIX continues
to use its native Bash.

Both hooks accept LF and CRLF token files. Regression tests require clean commits
and pushes to pass and protected names to remain blocked. This does not remove
existing manually configured protection entries or automatically repair older
pollution; inspect and correct historical local entries separately.

The commit hook reads the Git index. The push hook checks each outgoing
commit, including its message and any edits made during a merge. Both check
added text and new paths, including rename destinations. Removed text and
unchanged context often refer to material already present on the destination.

For the generated deployment manifest, both hooks compare package and source
records. They check a changed checksum against the corresponding Git blob or
the manifest's calculated aggregate. New names and paths go through the normal
literal and regular-expression rules. A malformed manifest or a checksum the
hook cannot verify receives the ordinary text scan. Without Node, the hooks
use the more conservative Git patch scan.

Run from `server/`:

```text
node test-project-hygiene.mjs
node test-connection-info-client.mjs
node test-shell-selection.mjs
node test-pre-push-gate.mjs
npm run lint
npm test
```

Use the normal environment for the final rotation: do not prepend Git Bash to
PATH to hide a shell-selection regression. Keep scratch roots bounded and remove
them in `finally`; retain only intentional evidence reports. Do not delete other
sessions' worktrees, processes or project files during cleanup.
