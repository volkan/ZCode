# Fork Node security validation, 2026-10-23

This fork uses Node 24.22.1 for development, CLI builds, SEA builds, and repository E2E containers.
Node identifies this version as a [security release](https://nodejs.org/en/blog/release/v24.22.1).
The release is listed in the [October security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

The runtime update is commit `82f42c7ad01835b64e914dbd10b0e3703f9f62a0`.
The separate MCP fix is commit `5fea22cc5c21ed7b3faa754ff5df3f443072feb0`.

## Changes

- Active Node 24 pins, minimum versions, current setup docs, and three Dockerfiles use 24.22.1.
- The CI version check reads the root engine minimum and rejects older patch versions.
- The exact Node license is registered with its source and SHA-256.
- The MCP authorization lease owner creates its credentials parent before acquiring the exclusive lock.

The MCP defect also reproduced under Node 24.14.0. A missing credentials parent caused `ENOENT` before authorization.
The fix preserves contention, dead-owner recovery, release, and filesystem error propagation.
The regression test failed before the fix. Lease and MCP tests then passed with an empty HOME: 43 tests.

The existing login persistence behavior remains unchanged. Separate remote Node 22 and Electron runtimes retain their existing release ownership.

## Commands and results

These commands ran from the repository root with Node 24.22.1 and pnpm 10.33.2.
The installed workspace tool directory was available through PATH. Tests used isolated user data.

| Command | Result |
| --- | --- |
| `pnpm --dir apps/zcode-cli build --force` | Passed. |
| `pnpm --dir apps/zcode-cli test --force --continue=always` | 41/42 tasks passed; two bootstrap tests exceeded their unchanged 5-second budgets. |
| `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap test --run` | 3,067 passed, 15 skipped. Both timeout cases passed. |
| `pnpm --dir apps/zcode-cli test --force --continue=always --concurrency=1` | All 42 tasks passed without cache: 12,897 tests passed, 40 skipped. |
| `pnpm typecheck` | Passed. |
| `pnpm --dir apps/zcode-cli typecheck --force` | Passed, 32 tasks. |
| `pnpm lint` | Zero errors, 96 warnings. |
| `pnpm --dir apps/zcode-cli lint` | Zero errors, 69 warnings; existing policy accepted 13 pristine upstream line-count diagnostics. |
| `pnpm verify:pre-push` | Passed against fork main. Schema and architecture checks passed; affected root selection contained zero tests. |

The bounded run changed only Turbo task concurrency. Assertions and test timeouts stayed unchanged.
Resource contention is a hypothesis for the default-profile timeouts; its precise cause remains unconfirmed.
The failed run remains part of the validation evidence.

The final CLI bundle was rebuilt after tests. Server and Web builds also passed.
The distribution used `scripts/build-zcode.mjs --skip-build` with version `3.16.2-fork.node24.22.1`.
No release artifact was uploaded by this validation.

## Packaged runtime and copied-account E2E

`node scripts/zcode-distribution-smoke.mjs <archive>` passed outside the repository:

- Native TUI import, initial rendering, and keyboard exit.
- Web HTML, server information, workspace identity, WebSocket, and clean shutdown.

The copied-account probe decrypted existing credentials and loaded all 104 sessions and 3,835 messages.
Reopening preserved counts and database integrity.
A fresh synthetic prompt succeeded. A second process resumed that synthetic session successfully.
Each process issued one project access token and one model request. All four requests returned HTTP 200.
Neither process exchanged the saved business JWT through the raw OAuth login path.
Existing conversation content was not sent to the model.

The final tested artifact fingerprints are:

| Artifact | SHA-256 |
| --- | --- |
| Agent bundle | `3d21ee3af0ebc04f1baebb6424ced627005e5a77331f6d4d475657a642cc9a31` |
| Distribution archive | `1be8cfc99b5d4bd8d0065c1c05c6d9649d6ab3a8ef47e322c06f3572cc6d04bd` |
| Official Node macOS arm64 archive | `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7` |

Independent source and evidence review found no actionable findings.
This record covers the macOS arm64 CLI and local Web distribution. Linux containers, Windows, and desktop/mobile application E2E were not executed.
