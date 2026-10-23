import { describe, expect, it, vi } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import { ProjectAccessTokenClient } from "@zcode/shared";
import { ZaiBusinessTokenCache } from "../src/auth/zai-business-token-cache.js";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";

const RAW = "fake-raw-oauth";
const BUSINESS = "fake-business-jwt";
const FRESH_BUSINESS = "fake-fresh-business-jwt";
const RAW_TRACE = { traceId: "fake-raw-owner" };
const rawInput = {
  family: "zai",
  credentialKind: "oauth",
  accessToken: RAW,
  accountIdentity: "fake-account",
  trace: RAW_TRACE,
} as const;
const businessInput = {
  ...rawInput,
  credentialKind: "business",
  accessToken: BUSINESS,
  trace: { traceId: "fake-business-caller" },
} as const;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(
  options: { firstStatus?: number; secondStatus?: number; sameBusiness?: boolean } = {},
) {
  const entered = gate();
  const response = gate();
  let logins = 0;
  let issues = 0;
  const request = vi.fn(async (req: HttpClientRequest): Promise<HttpClientResponse> => {
    let data: unknown;
    let status = 200;
    if (req.url.endsWith("/api/auth/z/login")) {
      logins++;
      data = {
        access_token: logins === 1 || options.sameBusiness ? BUSINESS : FRESH_BUSINESS,
        expires_in: 3600,
      };
    } else if (req.url.endsWith("getCustomerInfo")) {
      data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
    } else if (req.url.endsWith("api_keys")) {
      data = [{ apiKey: "key", name: "zcode-api-key" }];
    } else if (req.url.endsWith("access_tokens")) {
      issues++;
      status = issues === 1 ? (options.firstStatus ?? 401) : (options.secondStatus ?? 200);
      if (issues === 1) {
        entered.release();
        await response.promise;
      }
      data = {
        accessToken: `fake-pat-${issues}`,
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Date.now() / 1000 + 600,
      };
    } else throw new Error(`Unexpected fake request: ${req.url}`);
    const body = new TextEncoder().encode(JSON.stringify({ code: status, data }));
    return {
      status,
      statusText: "fake",
      headers: {},
      body,
      bytes: body.length,
      durationMs: 0,
      url: req.url,
    };
  });
  const httpClient: HttpClientPort = { request };
  return {
    resolver: createCodingPlanApiKeyResolver({ httpClient }),
    request,
    entered,
    response,
    logins: () => logins,
    issues: () => issues,
  };
}

describe("mixed ZAI credential callers", () => {
  it.each([
    ["business", 200],
    ["oauth", 200],
    ["business", 401],
    ["oauth", 401],
  ] as const)(
    "mixed callers share rejection: first=%s, retry=%s",
    async (firstKind, secondStatus) => {
      const f = fixture({ secondStatus });
      await f.resolver.normalizeZaiOAuth({ accessToken: RAW, trace: RAW_TRACE });
      const joined = gate();
      const original = ProjectAccessTokenClient.prototype.resolve;
      let clientCalls = 0;
      const resolve = vi
        .spyOn(ProjectAccessTokenClient.prototype, "resolve")
        .mockImplementation(function (this: ProjectAccessTokenClient, input) {
          const pending = original.call(this, input);
          if (++clientCalls === 2) joined.release();
          return pending;
        });
      try {
        const first = f.resolver.resolve(firstKind === "business" ? businessInput : rawInput);
        await f.entered.promise;
        const second = f.resolver.resolve(firstKind === "business" ? rawInput : businessInput);
        const outcomes = Promise.allSettled(
          firstKind === "business" ? [first, second] : [second, first],
        );
        // The second public client call reaches the existing pending PAT before the HTTP gate opens.
        await joined.promise;
        expect(f.issues()).toBe(1);
        f.response.release();
        const [business, raw] = await outcomes;
        expect(f.logins()).toBe(2);
        expect(f.issues()).toBe(2);
        expect(business.status).toBe("rejected");
        if (business.status === "rejected")
          expect(business.reason.message).toBe(
            firstKind === "business"
              ? "project_token_login_required"
              : "project_token_request_failed",
          );
        if (secondStatus === 200) expect(raw).toEqual({ status: "fulfilled", value: "fake-pat-2" });
        else {
          expect(raw.status).toBe("rejected");
          if (raw.status === "rejected")
            expect(raw.reason.message).toBe("project_token_request_failed");
        }
        const exchanges = f.request.mock.calls.filter(([req]) =>
          req.url.endsWith("/api/auth/z/login"),
        );
        expect(exchanges.every(([req]) => req.trace?.traceId === RAW_TRACE.traceId)).toBe(true);
        expect(exchanges.map(([req]) => JSON.parse(new TextDecoder().decode(req.body)))).toEqual([
          { token: RAW },
          { token: RAW },
        ]);
        const issuance = f.request.mock.calls.filter(([req]) => req.url.endsWith("access_tokens"));
        expect(issuance.map(([req]) => new Headers(req.headers).get("Authorization"))).toEqual([
          `Bearer ${BUSINESS}`,
          `Bearer ${FRESH_BUSINESS}`,
        ]);
      } finally {
        resolve.mockRestore();
        f.response.release();
      }
    },
  );

  it.each([
    ["business", 200],
    ["oauth", 200],
    ["business", 401],
    ["oauth", 401],
  ] as const)(
    "cache advances before old 401: first=%s, retry=%s",
    async (firstKind, secondStatus) => {
      vi.useFakeTimers();
      const f = fixture({ secondStatus });
      const joined = gate();
      const original = ProjectAccessTokenClient.prototype.resolve;
      let clientCalls = 0;
      const resolve = vi
        .spyOn(ProjectAccessTokenClient.prototype, "resolve")
        .mockImplementation(function (this: ProjectAccessTokenClient, input) {
          const pending = original.call(this, input);
          if (++clientCalls === 2) joined.release();
          return pending;
        });
      try {
        // Business-first starts before raw normalization; both orders must join PAT A.
        const first = f.resolver.resolve(firstKind === "business" ? businessInput : rawInput);
        await f.entered.promise;
        const second = f.resolver.resolve(firstKind === "business" ? rawInput : businessInput);
        const outcomes = Promise.allSettled(
          firstKind === "business" ? [first, second] : [second, first],
        );
        await joined.promise;
        expect(f.issues()).toBe(1);
        expect(f.logins()).toBe(1);
        vi.setSystemTime(Date.now() + 3_481_000);
        await expect(
          f.resolver.normalizeZaiOAuth({ accessToken: RAW, trace: RAW_TRACE }),
        ).resolves.toBe(FRESH_BUSINESS);
        expect(f.logins()).toBe(2);
        f.response.release();
        const [business, raw] = await outcomes;
        expect(f.issues()).toBe(2);
        expect(f.logins()).toBe(2);
        expect(business.status).toBe("rejected");
        if (business.status === "rejected")
          expect(business.reason.message).toBe(
            firstKind === "business"
              ? "project_token_login_required"
              : "project_token_request_failed",
          );
        if (secondStatus === 200) expect(raw).toEqual({ status: "fulfilled", value: "fake-pat-2" });
        else {
          expect(raw.status).toBe("rejected");
          if (raw.status === "rejected")
            expect(raw.reason.message).toBe("project_token_request_failed");
        }
        const issuance = f.request.mock.calls.filter(([req]) => req.url.endsWith("access_tokens"));
        expect(issuance.map(([req]) => new Headers(req.headers).get("Authorization"))).toEqual([
          `Bearer ${BUSINESS}`,
          `Bearer ${FRESH_BUSINESS}`,
        ]);
        const exchanges = f.request.mock.calls.filter(([req]) =>
          req.url.endsWith("/api/auth/z/login"),
        );
        expect(exchanges.every(([req]) => req.trace?.traceId === RAW_TRACE.traceId)).toBe(true);
      } finally {
        f.response.release();
        resolve.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([200, 403])(
    "raw PAT HTTP %s releases its credential before later refresh",
    async (status) => {
      vi.useFakeTimers();
      const f = fixture({ firstStatus: status });
      let observed:
        | {
            cache: ZaiBusinessTokenCache;
            lease: Awaited<ReturnType<ZaiBusinessTokenCache["acquire"]>>;
            release: ReturnType<typeof vi.spyOn>;
          }
        | undefined;
      const original = ZaiBusinessTokenCache.prototype.acquire;
      const acquire = vi
        .spyOn(ZaiBusinessTokenCache.prototype, "acquire")
        .mockImplementation(async function (this: ZaiBusinessTokenCache, ...args) {
          const lease = await original.apply(this, args);
          if (!observed) observed = { cache: this, lease, release: vi.spyOn(lease, "release") };
          return lease;
        });
      try {
        const pending = f.resolver.resolve(rawInput);
        const result =
          status === 200
            ? expect(pending).resolves.toBe("fake-pat-1")
            : expect(pending).rejects.toThrow("project_token_request_failed");
        await f.entered.promise;
        f.response.release();
        await result;
        expect(observed!.release).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + 3_481_000);
        await expect(f.resolver.normalizeZaiOAuth({ accessToken: RAW })).resolves.toBe(
          FRESH_BUSINESS,
        );
        observed!.cache.invalidateMatchingToken(BUSINESS);
        expect(observed!.cache.wasRejected(observed!.lease.value)).toBe(false);
        expect(f.logins()).toBe(2);
      } finally {
        f.response.release();
        observed?.release.mockRestore();
        acquire.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["account-switch", "clear"] as const)(
    "late business 401 preserves a newer cache after %s",
    async (action) => {
      const f = fixture({ sameBusiness: action === "clear" });
      await f.resolver.normalizeZaiOAuth({ accessToken: RAW });
      const old = f.resolver.resolve(businessInput);
      const rejected = expect(old).rejects.toThrow(
        action === "clear" ? "project_token_scope_invalidated" : "project_token_login_required",
      );
      await f.entered.promise;
      if (action === "clear") f.resolver.clear();
      const nextRaw = action === "clear" ? RAW : "fake-other-raw-oauth";
      await f.resolver.normalizeZaiOAuth({ accessToken: nextRaw });
      f.response.release();
      await rejected;
      await expect(
        f.resolver.resolve({
          ...rawInput,
          accessToken: nextRaw,
          accountIdentity: action === "clear" ? rawInput.accountIdentity : "fake-other-account",
        }),
      ).resolves.toBe("fake-pat-2");
      expect(f.logins()).toBe(2);
      const last = f.request.mock.calls.at(-1)![0];
      expect(new Headers(last.headers).get("Authorization")).toBe(
        `Bearer ${action === "clear" ? BUSINESS : FRESH_BUSINESS}`,
      );
    },
  );

  it("BigModel rejection cannot invalidate a matching ZAI cached JWT", async () => {
    const f = fixture();
    await f.resolver.normalizeZaiOAuth({ accessToken: RAW });
    const pending = f.resolver.resolve({
      family: "bigmodel",
      accessToken: BUSINESS,
      accountIdentity: "fake-bigmodel-account",
    });
    const rejected = expect(pending).rejects.toThrow("project_token_request_failed");
    await f.entered.promise;
    f.response.release();
    await rejected;
    await expect(f.resolver.resolve(rawInput)).resolves.toBe("fake-pat-2");
    expect(f.logins()).toBe(1);
  });
});
