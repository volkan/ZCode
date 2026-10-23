# Project token cache

This module owns the existing in-memory project access token cache. Host and standalone callers retain separate instances.
The existing `project-access-token.ts` exports remain the public runtime entrypoint. No facade or second cache is introduced.

The full scope includes origin, account family, account, organization, project, API key, usage scene, and login generation.
One pending issuance belongs to each scope. Callers inject issuance I/O; the cache performs no network or persistence operations.
Invalidation removes that scope. A late issuance result cannot restore an invalidated entry.
Only an explicitly transient failure can reuse an unexpired, unrejected token. Reuse never extends expiry.
Fingerprints identify rejected token generations. They are not account identities and must not reach model upstreams.

Sequence: caller -> scope cache -> injected issuer -> scope check -> cache result.
Invalidation before the final scope check rejects the result. Concurrent callers share the pending result.

`contract.ts` describes the existing exports. The example accepts a caller-owned cache and issuer.
Its contract test checks consumer compatibility without constructing a second owner.
Detailed concurrency, expiry, rejection, and recovery coverage remains in `packages/shared/test/projectAccessTokenCache.test.ts`.
