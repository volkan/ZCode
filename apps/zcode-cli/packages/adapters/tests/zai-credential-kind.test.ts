import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionContext,
  HttpClientPort,
  HttpClientRequest,
  HttpClientResponse,
} from "@zcode/contracts";
import { projectAccessTokenFingerprint } from "@zcode/shared";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture() {
  const entered = gate();
  const response = gate();
  let hold = "";
  let fail = false;
  let rejection = 0;
  let issues = 0;
  const request = vi.fn(async (req: HttpClientRequest): Promise<HttpClientResponse> => {
    let data: unknown;
    let status = 200;
    const phase = req.url.endsWith("/api/auth/z/login")
      ? "normalize"
      : req.url.endsWith("access_tokens")
        ? "pat"
        : "";
    if (phase && phase === hold) {
      entered.release();
      await response.promise;
    }
    if (phase === "normalize") {
      if (fail) throw new Error("fake exchange failed");
      data = { access_token: "returned-business", expires_in: 3600 };
    } else {
      status = rejection || 200;
      if (req.url.endsWith("getCustomerInfo"))
        data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
      else if (req.url.endsWith("api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
      else if (req.url.endsWith("access_tokens")) {
        issues++;
        data = {
          accessToken: `pat-${issues}`,
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        };
      } else throw new Error(`Unexpected fake request: ${req.url}`);
    }
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
  const resolver = createCodingPlanApiKeyResolver({ httpClient });
  return {
    resolver,
    request,
    entered,
    response,
    hold: (phase = "normalize") => {
      hold = phase;
    },
    fail: () => {
      fail = true;
    },
    reject: (status: number) => {
      rejection = status;
    },
    logins: () => request.mock.calls.filter(([r]) => r.url.endsWith("/api/auth/z/login")),
  };
}
const rawInput = {
  family: "zai",
  credentialKind: "oauth",
  accessToken: "raw-oauth",
  accountIdentity: "user",
} as const;
const businessInput = {
  ...rawInput,
  credentialKind: "business",
  accessToken: "returned-business",
} as const;

describe("explicit ZAI credential contract", () => {
  it("normalizes once and shares the existing raw-owner cache", async () => {
    const f = fixture();
    const input = { accessToken: rawInput.accessToken };
    await expect(
      Promise.all([f.resolver.normalizeZaiOAuth(input), f.resolver.normalizeZaiOAuth(input)]),
    ).resolves.toEqual(["returned-business", "returned-business"]);
    await expect(f.resolver.resolve(rawInput)).resolves.toBe("pat-1");
    await expect(f.resolver.resolve(businessInput)).resolves.toBe("pat-1");
    expect(f.logins()).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(f.logins()[0]![0].body))).toEqual({
      token: "raw-oauth",
    });
  });

  it.each([401, 403])("business HTTP %s requires login without raw retry", async (status) => {
    const f = fixture();
    f.reject(status);
    await expect(f.resolver.resolve(businessInput)).rejects.toThrow("project_token_login_required");
    expect(f.logins()).toHaveLength(0);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("business PAT recovery retains rejected fingerprints and account isolation", async () => {
    const f = fixture();
    await expect(f.resolver.resolve(businessInput)).resolves.toBe("pat-1");
    await expect(
      f.resolver.resolve({
        ...businessInput,
        rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint("pat-1"),
      }),
    ).resolves.toBe("pat-2");
    await expect(
      f.resolver.resolve({ ...businessInput, accountIdentity: "other-user" }),
    ).resolves.toBe("pat-3");
    expect(f.logins()).toHaveLength(0);
    expect(
      f.request.mock.calls.every(
        ([req]) => new Headers(req.headers).get("Authorization") === "Bearer returned-business",
      ),
    ).toBe(true);
  });

  it("missing kind fails closed rather than guessing the token shape", async () => {
    const f = fixture();
    // @ts-expect-error ZAI callers must explicitly declare the credential contract.
    await expect(
      f.resolver.resolve({ family: "zai", accessToken: "unknown-token" }),
    ).rejects.toThrow("project_token_login_required");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("normalization preserves ALS trace and strips caller cancellation from owner IO", async () => {
    const f = fixture();
    const controller = new AbortController();
    const trace = { traceId: "normalization-trace" } as ExecutionContext["trace"];
    const context = { trace, logger: {}, abortSignal: controller.signal } as ExecutionContext;
    await f.resolver.normalizeZaiOAuth(
      { accessToken: "raw-oauth" },
      { signal: controller.signal, context },
    );
    const [req, options] = f.request.mock.calls[0]! as unknown as [
      HttpClientRequest,
      { context?: ExecutionContext; signal?: AbortSignal },
    ];
    expect(req.trace).toEqual(trace);
    expect(req.timeoutMs).toBe(15_000);
    expect(options).toEqual({ context: { trace, logger: {} } });
  });

  it("pre-cancelled normalization sends no request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.resolver.normalizeZaiOAuth({ accessToken: "raw" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])(
    "cancelled normalization waiter leaves shared %s handled",
    async (outcome) => {
      const f = fixture();
      f.hold();
      const controller = new AbortController();
      const cleanup = vi.spyOn(controller.signal, "removeEventListener");
      const first = f.resolver.normalizeZaiOAuth(
        { accessToken: "raw" },
        { signal: controller.signal },
      );
      const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
      await f.entered.promise;
      const second = f.resolver.normalizeZaiOAuth({ accessToken: "raw" });
      controller.abort();
      await cancelled;
      expect(cleanup).toHaveBeenCalledWith("abort", expect.any(Function));
      if (outcome === "failure") f.fail();
      const result =
        outcome === "failure"
          ? expect(second).rejects.toThrow("project_token_login_failed")
          : expect(second).resolves.toBe("returned-business");
      f.response.release();
      await result;
      expect(f.logins()).toHaveLength(1);
    },
  );

  it("business PAT refresh stays shared and never normalizes again", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await expect(f.resolver.resolve(businessInput)).resolves.toBe("pat-1");
      vi.setSystemTime(Date.now() + 481_000);
      await expect(
        Promise.all([f.resolver.resolve(businessInput), f.resolver.resolve(businessInput)]),
      ).resolves.toEqual(["pat-2", "pat-2"]);
      vi.setSystemTime(Date.now() + 481_000);
      f.reject(401);
      await expect(f.resolver.resolve(businessInput)).rejects.toThrow(
        "project_token_login_required",
      );
      expect(f.logins()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "business waiter cancellation preserves shared owner; clear=%s",
    async (clear) => {
      const f = fixture();
      f.hold("pat");
      const controller = new AbortController();
      const first = f.resolver.resolve(businessInput, { signal: controller.signal });
      const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
      await f.entered.promise;
      const second = f.resolver.resolve(businessInput);
      const result = clear
        ? expect(second).rejects.toThrow("project_token_scope_invalidated")
        : expect(second).resolves.toBe("pat-1");
      controller.abort();
      await cancelled;
      if (clear) f.resolver.clear();
      f.response.release();
      await result;
      expect(f.logins()).toHaveLength(0);
    },
  );

  it("clear rejects late normalization without publishing stale cache material", async () => {
    const f = fixture();
    f.hold();
    const pending = f.resolver.normalizeZaiOAuth({ accessToken: "raw" });
    const rejected = expect(pending).rejects.toThrow("project_token_scope_invalidated");
    await f.entered.promise;
    f.resolver.clear();
    f.response.release();
    await rejected;
    await expect(f.resolver.normalizeZaiOAuth({ accessToken: "raw" })).resolves.toBe(
      "returned-business",
    );
    expect(f.logins()).toHaveLength(2);
  });
});
