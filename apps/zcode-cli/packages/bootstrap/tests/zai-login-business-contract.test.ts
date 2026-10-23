import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
} from "@zcode/adapters/auth";
import { loginZCodeCli } from "../src/auth-login.js";
import {
  createStandaloneProviderRuntimeHeadersPort,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "offline-contract-test-secret",
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
};
const PROVIDER = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
const BUSINESS = "fake-maas-business-jwt";
const RAW = "fake-raw-oauth";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
// customerInfo 使用裸业务 JWT；个人 Key/PAT 端点仍要求 Bearer。
function expectedBusinessAuthorization(req: HttpClientRequest): string {
  return new URL(req.url).pathname.endsWith("/api/biz/customer/getCustomerInfo")
    ? BUSINESS
    : `Bearer ${BUSINESS}`;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zai-business-contract-"));
  dirs.push(dir);
  const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
  const entered = gate();
  const response = gate();
  let hold = "";
  let reject = "";
  let issues = 0;
  const request = vi.fn(async (req: HttpClientRequest): Promise<HttpClientResponse> => {
    const path = new URL(req.url).pathname;
    const phase = path.endsWith("/api/auth/z/login")
      ? "normalize"
      : path.endsWith("access_tokens")
        ? "pat"
        : "";
    if (phase && phase === hold) {
      entered.release();
      await response.promise;
    }
    const status = phase && phase === reject ? 401 : 200;
    let data: unknown;
    if (path.endsWith("/oauth/cli/init"))
      data = {
        flow_id: "fake-flow",
        authorize_url: "https://example.test/authorize",
        expires_at: 9999999999,
        poll_interval_sec: 1,
      };
    else if (path.includes("/oauth/cli/poll/"))
      data = {
        status: "ready",
        token: "fake-app-jwt",
        user: { user_id: "fake-user" },
        zai: { access_token: RAW },
      };
    else if (phase === "normalize") {
      expect(JSON.parse(new TextDecoder().decode(req.body))).toEqual({ token: RAW });
      data = { access_token: BUSINESS, expires_in: 3600 };
    } else {
      expect(new Headers(req.headers).get("Authorization")).toBe(
        expectedBusinessAuthorization(req),
      );
      if (path.endsWith("getCustomerInfo"))
        data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
      else if (path.endsWith("api_keys")) data = [{ apiKey: "key-id", name: "zcode-api-key" }];
      else if (phase === "pat") {
        issues++;
        data = {
          accessToken: `fake-pat-${issues}`,
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        };
      } else throw new Error(`Unexpected fake request: ${path}`);
    }
    const body = new TextEncoder().encode(
      JSON.stringify({ code: status === 200 ? 0 : status, data }),
    );
    return {
      body,
      bytes: body.length,
      durationMs: 0,
      headers: {},
      status,
      statusText: "fake",
      url: req.url,
    };
  });
  const httpClient: HttpClientPort = { request };
  const login = (abortSignal?: AbortSignal) =>
    loginZCodeCli({
      credentialStore: store,
      env: TEST_ENV,
      httpClient,
      noBrowser: true,
      pollToken: "fake-poll",
      personalProviderConfigPath: join(dir, "provider-config.json"),
      abortSignal,
    });
  const runtime = () => {
    // A new store and resolver model restart, using only this test's encrypted file.
    const restarted = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    return createStandaloneProviderRuntimeHeadersPort(
      restarted,
      TEST_ENV,
      createCodingPlanApiKeyResolver({ httpClient }),
    );
  };
  return {
    dir,
    store,
    login,
    runtime,
    request,
    entered,
    response,
    hold: (phase: string) => {
      hold = phase;
    },
    reject: (phase: string) => {
      reject = phase;
    },
    logins: () => request.mock.calls.filter(([r]) => r.url.endsWith("/api/auth/z/login")),
  };
}
function refresh(
  port: ReturnType<typeof createStandaloneProviderRuntimeHeadersPort>,
  abortSignal?: AbortSignal,
) {
  return port.refreshBeforeModelRequest({
    providerId: PROVIDER,
    modelId: "fake-model",
    accountAccess: {
      type: "zhipu-account",
      accountType: "zai",
      mode: "individual-coding-plan",
      entitled: true,
    },
    reason: "model-request",
    sessionId: "fake-session" as never,
    abortSignal,
  });
}

describe("native ZAI login and shared business credential", () => {
  it("persists the returned business JWT and restart obtains PAT without raw exchange", async () => {
    const f = await fixture();
    await f.login();
    expect(f.logins()).toHaveLength(1);
    expect(await f.store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe(BUSINESS);
    expect(await f.store.load(standaloneAccountIdentityCredentialKey(PROVIDER))).toBe("fake-user");
    expect(await f.store.load(standaloneAccountAuthSourceCredentialKey(PROVIDER))).toBe("oauth");
    const encrypted = await readFile(f.store.filePath, "utf8");
    expect(encrypted).toContain("enc:v1:");
    expect(encrypted).not.toContain(RAW);
    expect(encrypted).not.toContain(BUSINESS);
    expect(encrypted).not.toContain("fake-pat");
    const count = f.request.mock.calls.length;
    await expect(refresh(f.runtime())).resolves.toMatchObject({
      requestAuth: { apiKey: "fake-pat-2" },
    });
    expect(f.logins()).toHaveLength(1);
    expect(
      f.request.mock.calls.slice(count).every(([req]) => !req.url.includes("/api/auth/")),
    ).toBe(true);
  });

  it("reads a Desktop-style business value without auth/z/login", async () => {
    const f = await fixture();
    await f.store.saveZaiLoginCredentials({
      accessToken: BUSINESS,
      jwtToken: "fake-app-jwt",
      user: { user_id: "fake-user" },
    });
    await f.store.saveMany({
      [standaloneAccountIdentityCredentialKey(PROVIDER)]: "fake-user",
      [standaloneAccountAuthSourceCredentialKey(PROVIDER)]: "oauth",
    });
    await expect(refresh(f.runtime())).resolves.toMatchObject({
      requestAuth: { apiKey: "fake-pat-1" },
    });
    expect(f.logins()).toHaveLength(0);
  });

  it("rejected persisted business fails closed without private-Key fallback", async () => {
    const f = await fixture();
    await f.login();
    const legacyKey = standaloneAccountProviderCredentialKey({
      providerId: PROVIDER,
      accountIdentity: "fake-user",
    });
    await f.store.save(legacyKey, "unused-private-key");
    f.reject("pat");
    const count = f.request.mock.calls.length;
    await expect(refresh(f.runtime())).rejects.toThrow("project_token_login_required");
    expect(f.logins()).toHaveLength(1);
    expect(
      f.request.mock.calls
        .slice(count)
        .every(
          ([req]) =>
            new Headers(req.headers).get("Authorization") === expectedBusinessAuthorization(req),
        ),
    ).toBe(true);
    expect(await f.store.load(legacyKey)).toBe("unused-private-key");
  });

  it.each(["normalize", "pat"])("failed %s preserves previous credentials", async (phase) => {
    const f = await fixture();
    await f.store.saveZaiLoginCredentials({
      accessToken: "previous-business",
      jwtToken: "previous-app-jwt",
      user: { user_id: "previous-user" },
    });
    const before = await readFile(f.store.filePath, "utf8");
    const save = vi.spyOn(f.store, "saveZaiLoginCredentials");
    f.reject(phase);
    await expect(f.login()).rejects.toThrow(
      phase === "normalize" ? "project_token_login_failed" : "project_token_login_required",
    );
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(f.store.filePath, "utf8")).toBe(before);
  });

  it.each(["normalize", "pat"])(
    "cancelled %s never publishes a late successful result",
    async (phase) => {
      const f = await fixture();
      await f.store.saveZaiLoginCredentials({
        accessToken: "previous-business",
        jwtToken: "previous-app-jwt",
        user: { user_id: "previous-user" },
      });
      const before = await readFile(f.store.filePath, "utf8");
      const save = vi.spyOn(f.store, "saveZaiLoginCredentials");
      const controller = new AbortController();
      f.hold(phase);
      const pending = f.login(controller.signal);
      const cancelled = expect(pending).rejects.toThrow("fake login cancelled");
      await f.entered.promise;
      controller.abort(new Error("fake login cancelled"));
      await cancelled;
      f.response.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (phase === "normalize")
        expect(f.request.mock.calls.some(([req]) => req.url.endsWith("access_tokens"))).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(await readFile(f.store.filePath, "utf8")).toBe(before);
    },
  );
});
