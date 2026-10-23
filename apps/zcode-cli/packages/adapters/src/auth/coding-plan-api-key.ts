import { AsyncLocalStorage } from "node:async_hooks";
import {
  isHttpClientPortError,
  type HttpClientPort,
  type HttpClientRunOptions,
  type TraceContext,
} from "@zcode/contracts";
import {
  ProjectAccessTokenClient,
  ProjectAccessTokenError,
  ProjectAccessTokenTransientError,
  resolveBigModelApiOrigin,
  type ProjectAccessTokenMaterial,
} from "@zcode/shared";
import { ZaiBusinessTokenCache, type ZaiBusinessTokenLease } from "./zai-business-token-cache.js";

const BUSINESS_AUTH_MAX_ATTEMPTS = 2;
const SINGLE_ATTEMPT = 1;
const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const ZAI_API_HOST = "https://api.z.ai";
const BEARER_PREFIX = "Bearer ";
export type CodingPlanFamily = "bigmodel" | "zai";
export interface CodingPlanApiKeyResolverOptions {
  httpClient: HttpClientPort;
  trace?: TraceContext;
  locationStore?: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  observe?(event: { family: string; stage: "resolve"; code: string }): void;
}
export type ZaiCredentialKind = "oauth" | "business";
export interface NormalizeZaiOAuthInput {
  accessToken: string;
  trace?: TraceContext;
}
export type ResolveCodingPlanApiKeyInput = {
  accessToken: string;
  accountIdentity?: string;
  rejectedProjectTokenFingerprint?: string;
  trace?: TraceContext;
} & (
  | { family: "zai"; credentialKind: ZaiCredentialKind }
  | { family: "bigmodel"; credentialKind?: "oauth" }
);
export interface CodingPlanApiKeyResolver {
  normalizeZaiOAuth(input: NormalizeZaiOAuthInput, options?: HttpClientRunOptions): Promise<string>;
  resolve(input: ResolveCodingPlanApiKeyInput, options?: HttpClientRunOptions): Promise<string>;
  resolveMaterial(
    input: ResolveCodingPlanApiKeyInput,
    options?: HttpClientRunOptions,
  ): Promise<ProjectAccessTokenMaterial>;
  clear(): void;
}
export class CodingPlanApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingPlanApiKeyError";
  }
}

/** CLI 进程内唯一换证入口；保留旧导出名兼容调用方，返回值已是短期 Token。 */
export function createCodingPlanApiKeyResolver(
  options: CodingPlanApiKeyResolverOptions,
): CodingPlanApiKeyResolver {
  const execution = new AsyncLocalStorage<{
    context?: HttpClientRunOptions["context"];
    trace?: TraceContext;
    credentialKind?: ZaiCredentialKind;
  }>();
  const businessTokens = new ZaiBusinessTokenCache(() =>
    options.observe?.({
      family: "zai",
      stage: "resolve",
      code: "project_token_business_login_refresh_deferred",
    }),
  );
  let generation = 0;
  const request = async (url: string, init: RequestInit) => {
    const capturedGeneration = generation;
    const rejectMatchingBusiness = businessTokens.captureMatchingRejection();
    const response = await options.httpClient
      .request(
        {
          url,
          method: init.method === "POST" ? "POST" : "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(typeof init.body === "string" ? { body: new TextEncoder().encode(init.body) } : {}),
          maxResponseBytes: 64 * 1024,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
          trace: execution.getStore()?.trace ?? options.trace,
        },
        { context: execution.getStore()?.context },
      )
      .catch((error: unknown) => {
        if (
          isHttpClientPortError(error) &&
          (error.code === "network_error" || error.code === "timeout")
        )
          throw new ProjectAccessTokenTransientError();
        throw error;
      });
    if ([401, 403].includes(response.status) && new URL(url).pathname.startsWith("/api/biz/")) {
      const run = execution.getStore();
      if (
        response.status === 401 &&
        generation === capturedGeneration &&
        new URL(url).origin === ZAI_API_HOST
      ) {
        // 共享请求的首个调用者可能没有 raw 上下文；先记录匹配 JWT 的拒绝，供 raw 等待者恢复。
        const authorization = new Headers(init.headers).get("Authorization");
        if (authorization?.startsWith(BEARER_PREFIX))
          rejectMatchingBusiness(authorization.slice(BEARER_PREFIX.length));
      }
      // 共享键保存业务 JWT，拒绝后只能重新登录，不能当作 raw OAuth 再次换证。
      if (run?.credentialKind === "business")
        throw new ProjectAccessTokenError("project_token_login_required");
    }
    if (response.status === 404) return { code: 404 };
    if (response.status === 429 || (response.status >= 500 && response.status < 600))
      throw new ProjectAccessTokenTransientError();
    if (response.status < 200 || response.status >= 300)
      throw new CodingPlanApiKeyError("project_token_request_failed");
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  };
  const client = new ProjectAccessTokenClient({
    request,
    observe: options.observe,
    locationStore: options.locationStore,
  });
  const normalizeZaiOAuth = async (
    input: NormalizeZaiOAuthInput,
  ): Promise<ZaiBusinessTokenLease> => {
    const oauth = input.accessToken.trim();
    if (!oauth) throw new CodingPlanApiKeyError("project_token_login_required");
    const capturedGeneration = generation;
    let lease: ZaiBusinessTokenLease | undefined;
    try {
      lease = await businessTokens.acquire(oauth, () =>
        request(`${ZAI_API_HOST}/api/auth/z/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: oauth }),
        }),
      );
      if (generation !== capturedGeneration)
        throw new CodingPlanApiKeyError("project_token_scope_invalidated");
      lease.assertCurrent();
      return lease;
    } catch {
      lease?.release();
      if (generation !== capturedGeneration)
        throw new CodingPlanApiKeyError("project_token_scope_invalidated");
      options.observe?.({ family: "zai", stage: "resolve", code: "project_token_login_failed" });
      throw new CodingPlanApiKeyError("project_token_login_failed");
    }
  };
  const resolveMaterial = async (
    input: ResolveCodingPlanApiKeyInput,
  ): Promise<ProjectAccessTokenMaterial> => {
    const credential = input.accessToken.trim();
    if (!credential) throw new CodingPlanApiKeyError("project_token_login_required");
    const capturedGeneration = generation;
    if (input.family === "zai" && !["oauth", "business"].includes(input.credentialKind))
      throw new CodingPlanApiKeyError("project_token_login_required");
    const rawZai = input.family === "zai" && input.credentialKind === "oauth";
    const maxAttempts = rawZai ? BUSINESS_AUTH_MAX_ATTEMPTS : SINGLE_ATTEMPT;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (generation !== capturedGeneration)
        throw new CodingPlanApiKeyError("project_token_scope_invalidated");
      const lease = rawZai ? await normalizeZaiOAuth(input) : undefined;
      const business = lease?.value;
      try {
        if (generation !== capturedGeneration)
          throw new CodingPlanApiKeyError("project_token_scope_invalidated");
        lease?.assertCurrent();
        const loginToken = business?.token ?? credential;
        const run = execution.getStore();
        if (run) run.credentialKind = input.family === "zai" ? input.credentialKind : undefined;
        const result = await client.resolve({
          origin: input.family === "zai" ? ZAI_API_HOST : resolveBigModelApiOrigin(process.env),
          family: input.family,
          loginToken,
          accountId: input.accountIdentity ?? input.family,
          personalProjectSelection: "default",
          rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
        });
        if (generation !== capturedGeneration)
          throw new CodingPlanApiKeyError("project_token_scope_invalidated");
        lease?.assertCurrent();
        return result;
      } catch (error) {
        lease?.assertCurrent();
        // 只恢复业务 JWT 的明确 HTTP 401；不把模型 401、403 或网络故障猜成过期。
        if (!business || !businessTokens.wasRejected(business)) throw error;
        businessTokens.invalidate(business);
        if (attempt + 1 === maxAttempts) throw error;
        options.observe?.({
          family: input.family,
          stage: "resolve",
          code: "project_token_business_login_refresh",
        });
      } finally {
        lease?.release();
      }
    }
    throw new CodingPlanApiKeyError("project_token_request_failed");
  };
  const forCaller = <T>(
    input: { trace?: TraceContext },
    runOptions: HttpClientRunOptions | undefined,
    run: () => Promise<T>,
  ) =>
    waitForProjectToken(
      () =>
        execution.run(
          {
            // 单飞属于鉴权 owner，不继承会话 signal 或 context.abortSignal；只保留观测上下文。
            context: runOptions?.context
              ? { trace: runOptions.context.trace, logger: runOptions.context.logger }
              : undefined,
            trace: input.trace ?? runOptions?.context?.trace,
          },
          run,
        ),
      runOptions?.signal,
    );
  const resolveForCaller = (
    input: ResolveCodingPlanApiKeyInput,
    runOptions?: HttpClientRunOptions,
  ) => forCaller(input, runOptions, () => resolveMaterial(input));
  return {
    normalizeZaiOAuth: (input, runOptions) =>
      forCaller(input, runOptions, async () => {
        const lease = await normalizeZaiOAuth(input);
        try {
          lease.assertCurrent();
          return lease.value.token;
        } finally {
          lease.release();
        }
      }),
    resolveMaterial: resolveForCaller,
    async resolve(input, runOptions) {
      const value = await resolveForCaller(input, runOptions);
      return value.token;
    },
    clear() {
      generation++;
      businessTokens.clear();
      client.clear();
    },
  };
}

/** 仅取消当前调用方的等待；底层 Promise 始终有拒绝处理器，不误伤共享换证。 */
async function waitForProjectToken<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  const value = await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
  signal.throwIfAborted();
  return value;
}
