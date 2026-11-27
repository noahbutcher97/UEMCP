# Saved RigVM model fixture

Unreal Editor 5.9.0-60738873 created `CR_SavedRig` in a fresh UEMCP fixture project. The fixture uses the engine’s Control Rig Blueprint factory and built-in float-add units. Its root graph connects `Upstream.Result` to `Sink.A` and sets `Sink.B` to `7.25`. The `Nested` collapse node contains another `Upstream`, whose `Result` feeds `Inner.A`.

After saving the package, the fixture author recorded `oracle.json` through Unreal's graph, node, pin and link APIs. The oracle includes the engine build and the SHA-256 digest of the saved package. Run `node server/test-rigvm-package.mjs` from the repository root to compare those observations with a direct read of the fixture.
