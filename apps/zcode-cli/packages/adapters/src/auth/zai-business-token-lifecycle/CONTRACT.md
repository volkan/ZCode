# ZAI business token lifecycle

This module owns the existing CLI business JWT cache and active leases. Its lifetime differs from project access tokens.
The existing `zai-business-token-cache.ts` exports remain the public runtime entrypoint. The coding plan adapter retains its cache instance.

Callers inject exchange I/O. The cache performs no network or persistence operations.
An OAuth scope owns one pending exchange and its cached JWT. Scope changes and clear invalidate old results and leases.
Active leases retain token identity across refresh. Release is idempotent and removes only that lease reference.
A late 401 rejects its matching JWT generation. It cannot invalidate a replacement from another login generation.
Only an explicitly transient failure can reuse a known, unexpired, unrejected JWT. Reuse never extends expiry.
An opaque JWT with unknown expiry has bounded caching but cannot use transient-failure fallback.

Sequence: caller -> OAuth scope cache -> injected exchange -> scope check -> lease -> caller -> release.
Callers check lease currency before use and release it when their operation ends.

`contract.ts` describes the existing exports. The example accepts a caller-owned cache and releases its lease on failure or success.
Its contract test checks that consumer boundary. Detailed refresh and stale rejection coverage remains in
`apps/zcode-cli/packages/adapters/tests/zai-business-token-cache.test.ts` and `zai-business-token-refresh.test.ts`.
