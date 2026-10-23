# Fork CLI login validation: 2026-10-23

The fork keeps the Z.AI business JWT across CLI restarts, matching Desktop credential storage.
A restarted process uses that JWT to obtain a short-lived Project Access Token (PAT).
Server rejection of the stored JWT requires login again.

## Source and tools

| Input | Value |
| --- | --- |
| Upstream source | `3c5b227649371507ddc4eb46ac5133afe6db1cab` |
| Login change | `baf6bf15f1c0a30f2881ce374bc4ca53c7c57d5d` |
| CLI / application source version | `0.17.0` / `3.16.2` |
| Node.js / pnpm | `24.14.0` / `10.33.2` |
| Turbo | `2.9.14` |
| Platform | macOS arm64 |
| Lockfile SHA-256 | `fd40401fa31a01d21fff8e5cf11d816cc225d81f2e11994663c27cdd8fc0a1bd` |
| Tested CLI bundle SHA-256 | `187de65a393baf366d50c1f093b01b0f4ff7738669e6cebd25d2828bfac44969` |

The integration also registers both token caches as managed modules without changing their runtime code or public imports.
Endpoint-specific test expectations follow the current shared client's bare-JWT customer-info request and Bearer PAT requests.

## Results

| Check | Result |
| --- | --- |
| Frozen-lockfile installation | Passed |
| Complete CLI package build | Passed, 24 tasks |
| Root typecheck | Passed |
| CLI typecheck | Passed, 32 tasks |
| Root lint | Passed, 96 warnings and zero errors |
| CLI lint | Passed, 69 warnings and zero errors; 13 pristine upstream line-count diagnostics accepted by existing policy |
| Architecture | Passed, zero violations |
| CLI package suite | 518 passed |
| Adapter login and token suites | 125 passed |
| Adapter migration and session suites | 127 passed |
| Bootstrap login, startup, and rollback suites | 37 passed |
| Shared PAT and both module contract suites | 64 passed |
| Total tests above | 871 passed |
| CLI version and doctor | Passed |
| Existing data copy | Credentials decrypted; sessions and messages remained readable; restart preserved counts and database integrity |
| Live fresh session | Passed; one PAT issuance, one model request, zero raw OAuth exchanges |
| Separate-process resume | Passed with the new synthetic session; one PAT issuance, one model request, zero raw OAuth exchanges |

All four final live HTTP requests returned 200.
Existing conversations were not sent to the model during these checks.

## Commands

Run repository commands from the repository root with the pinned tool versions.
This installation had Turbo's package but no executable shim; the build and typecheck used its installed entrypoint directly.
No dependency versions or runtime configuration were changed for that invocation.

```sh
pnpm install --frozen-lockfile
pnpm --filter @zcode/cli... build
pnpm --dir apps/zcode-cli exec node ../../node_modules/turbo/bin/turbo run build
pnpm typecheck
pnpm --dir apps/zcode-cli exec node ../../node_modules/turbo/bin/turbo run typecheck
pnpm lint
pnpm --dir apps/zcode-cli lint
pnpm architecture:check --changed
pnpm --dir apps/zcode-cli --filter @zcode/cli test

pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run \
  tests/auth.test.ts tests/project-token-cancellation.test.ts tests/project-token-refresh.test.ts \
  tests/zai-business-token-cache.test.ts tests/zai-business-token-refresh.test.ts \
  tests/zai-credential-kind.test.ts tests/zai-mixed-credential-callers.test.ts

pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run \
  tests/frozen-migration-startup.test.ts tests/async-migration-startup.test.ts \
  tests/migration-crash-recovery.test.ts tests/session-database-identity-migration.test.ts \
  tests/session-migration-boundaries.test.ts tests/session-store.test.ts \
  tests/session-model-selection-migration.test.ts tests/session-reasoning-repair-migration.test.ts \
  tests/official-glm-selection-migration.test.ts

pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run \
  tests/auth-login.test.ts tests/standalone-project-token.test.ts \
  tests/zai-login-business-contract.test.ts tests/storage-startup.test.ts \
  tests/database-rollback-readability.test.ts tests/account-config-delivery.test.ts

pnpm exec vitest run \
  packages/shared/test/projectAccessTokenKeyContract.test.ts \
  packages/shared/test/projectAccessTokenClient.test.ts \
  packages/shared/test/projectAccessTokenCache.test.ts \
  packages/shared/src/project-token-cache/contract.test.ts \
  apps/zcode-cli/packages/adapters/src/auth/zai-business-token-lifecycle/contract.test.ts
```

The CLI probes used this built entrypoint:

```sh
node apps/zcode-cli/packages/cli/dist/zcode.cjs --version
node apps/zcode-cli/packages/cli/dist/zcode.cjs doctor --json
node apps/zcode-cli/packages/cli/dist/zcode.cjs --cwd "$VALIDATION_WORKSPACE" \
  --mode plan --output-format json --workflow-mode disabled --locale en-US --no-color \
  --prompt "Reply with exactly READY. Do not call any tools."
node apps/zcode-cli/packages/cli/dist/zcode.cjs --cwd "$VALIDATION_WORKSPACE" \
  --mode plan --output-format json --workflow-mode disabled --locale en-US --no-color \
  --resume "$VALIDATION_SESSION" --prompt "Reply with exactly RESUMED. Do not call any tools."
```

## Isolation and limits

SQLite backup API created consistent copies of the active databases through read-only source connections.
Credentials and configuration fingerprints stayed stable while the snapshot was made.
There was no global transaction across the databases and configuration files.

Child HOME, USERPROFILE, XDG, data, storage, database, provider, and log paths pointed at temporary test directories.
Copied credentials retained their original encryption key only in child process memory and environment.
Hooks, plugins, MCP, skills, memory, and subagents were disabled in the data copy.
The live checks used synthetic prompts and resumed only their newly created session.

The copied database already contained migrations 0023 and 0024.
Existing-data checks therefore prove readability and restart compatibility, not an upgrade from a pre-0023 production database.
Historical migration paths and rollback behavior were checked with isolated synthetic fixtures.

The live checks reused cached Key IDs and covered persisted-business authentication and model inference.
Native browser login, OAuth normalization, and metadata discovery were covered offline, not by a new live browser login.
No expiry-duration wait, Desktop E2E run, mobile check, or Windows/Linux execution was performed.
