import { afterEach, expect, it, vi } from "vitest";
import { ProjectAccessTokenTransientError } from "@zcode/shared";
import { ZaiBusinessTokenCache } from "../src/auth/zai-business-token-cache.js";
afterEach(() => vi.useRealTimers());
it("无 TTL 的成功响应只做有限缓存", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const exchange = vi.fn(async () => ({ data: { access_token: "opaque-token" } }));
  await cache.resolve("oauth", exchange);
  await cache.resolve("oauth", exchange);
  expect(exchange).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 300_000);
  await cache.resolve("oauth", exchange);
  expect(exchange).toHaveBeenCalledTimes(2);
});

it("提前刷新临时失败并发共享原值、短退避、按原期限失效", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const cache = new ZaiBusinessTokenCache();
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: "business-token", expires_in: 600 },
  }));
  const exchange = vi.fn(async () => {
    throw new ProjectAccessTokenTransientError();
  });
  vi.setSystemTime(start + 481_000);
  const values = await Promise.all([
    cache.resolve("oauth", exchange),
    cache.resolve("oauth", exchange),
  ]);
  expect(values[0]).toBe(original);
  expect(values[1]).toBe(original);
  await expect(cache.resolve("oauth", exchange)).resolves.toBe(original);
  expect(exchange).toHaveBeenCalledTimes(1);
  vi.setSystemTime(start + 486_000);
  await expect(cache.resolve("oauth", exchange)).resolves.toBe(original);
  expect(exchange).toHaveBeenCalledTimes(2);
  vi.setSystemTime(start + 600_000);
  await expect(cache.resolve("oauth", exchange)).rejects.toThrow("transient_failure");
});

it.each(["clear", "invalidate", "matching-token", "switch", "expire"])(
  "在途临时故障遇到 %s 不降级",
  async (action) => {
    vi.useFakeTimers();
    const start = Date.now();
    const cache = new ZaiBusinessTokenCache();
    const original = await cache.resolve("oauth", async () => ({
      data: { access_token: "business-token", expires_in: 600 },
    }));
    vi.setSystemTime(start + 481_000);
    let reject!: (error: Error) => void;
    const pending = cache.resolve(
      "oauth",
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await Promise.resolve();
    if (action === "clear") cache.clear();
    if (action === "invalidate") cache.invalidate(original);
    if (action === "matching-token") cache.invalidateMatchingToken(original.token);
    if (action === "expire") vi.setSystemTime(start + 600_000);
    if (action === "switch")
      await cache.resolve("other", async () => ({ data: { access_token: "other-token" } }));
    reject(new ProjectAccessTokenTransientError());
    await expect(pending).rejects.toThrow();
  },
);

it("未知有效期不能把本地缓存上限当作可降级期限", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  await cache.resolve("oauth", async () => ({ data: { access_token: "opaque-token" } }));
  vi.setSystemTime(Date.now() + 181_000);
  await expect(
    cache.resolve("oauth", async () => {
      throw new ProjectAccessTokenTransientError();
    }),
  ).rejects.toThrow();
});

it("降级保留 JWT 对象身份，迟到 401 仍能阻止退避期内复用", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: "token", expires_in: 600 },
  }));
  vi.setSystemTime(Date.now() + 481_000);
  const fail = async () => {
    throw new ProjectAccessTokenTransientError();
  };
  await expect(cache.resolve("oauth", fail)).resolves.toBe(original);
  cache.invalidate(original);
  expect(cache.wasRejected(original)).toBe(true);
  await expect(cache.resolve("oauth", fail)).rejects.toThrow();
});

it("短退避结束后可恢复换证，并仍采用 JWT 与响应 TTL 的最早期限", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const cache = new ZaiBusinessTokenCache();
  const token = `header.${Buffer.from(JSON.stringify({ exp: start / 1000 + 600 })).toString("base64url")}.sig`;
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: token, expires_in: 3600 },
  }));
  vi.setSystemTime(start + 481_000);
  const exchange = vi
    .fn()
    .mockRejectedValueOnce(new ProjectAccessTokenTransientError())
    .mockResolvedValue({ data: { access_token: "new-token", expires_in: 600 } });
  await expect(cache.resolve("oauth", exchange)).resolves.toBe(original);
  expect(original.expiresAt).toBe(start + 600_000);
  vi.setSystemTime(start + 486_000);
  expect((await cache.resolve("oauth", exchange)).token).toBe("new-token");
});
it("clear 后不发送尚未发出的旧交换", async () => {
  const cache = new ZaiBusinessTokenCache();
  const exchange = vi.fn();
  const pending = cache.resolve("oauth", exchange);
  cache.clear();
  await expect(pending).rejects.toThrow("scope_invalidated");
  expect(exchange).not.toHaveBeenCalled();
});
it("退出和换登录拒绝迟到响应，旧 401 不影响新结果", async () => {
  const cache = new ZaiBusinessTokenCache();
  let finish!: (value: unknown) => void;
  const pending = cache.resolve(
    "old",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  cache.clear();
  const next = await cache.resolve("new", async () => ({ data: { access_token: "new-token" } }));
  finish({ data: { access_token: "old-token" } });
  await expect(pending).rejects.toThrow("scope_invalidated");
  cache.invalidate({ token: "old-token", refreshAt: Date.now() });
  expect(
    await cache.resolve("new", async () => {
      throw Error("unexpected exchange");
    }),
  ).toBe(next);
});

it("matching token rejection marks the cached object and forces a new exchange", async () => {
  const cache = new ZaiBusinessTokenCache();
  const original = await cache.resolve("oauth", async () => ({
    data: { access_token: "old-token" },
  }));
  cache.invalidateMatchingToken("old-token");
  expect(cache.wasRejected(original)).toBe(true);
  const exchange = vi.fn(async () => ({ data: { access_token: "new-token" } }));
  expect((await cache.resolve("oauth", exchange)).token).toBe("new-token");
  expect(exchange).toHaveBeenCalledTimes(1);
});

it.each(["refresh", "account-switch"])(
  "late old token rejection preserves a different JWT after %s",
  async (action) => {
    vi.useFakeTimers();
    const cache = new ZaiBusinessTokenCache();
    const original = await cache.resolve("oauth", async () => ({
      data: { access_token: "old-token", expires_in: 600 },
    }));
    vi.setSystemTime(Date.now() + 481_000);
    const oauth = action === "refresh" ? "oauth" : "other-oauth";
    const current = await cache.resolve(oauth, async () => ({
      data: { access_token: "new-token", expires_in: 600 },
    }));
    cache.invalidateMatchingToken("old-token");
    cache.invalidate(original);
    expect(cache.wasRejected(current)).toBe(false);
    const unexpected = vi.fn(async () => {
      throw new Error("unexpected exchange");
    });
    await expect(cache.resolve(oauth, unexpected)).resolves.toBe(current);
    expect(unexpected).not.toHaveBeenCalled();
  },
);

it("active leases retain old rejection targets with idempotent reference-counted release", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const first = await cache.acquire("oauth", async () => ({
    data: { access_token: "old-token", expires_in: 600 },
  }));
  const second = await cache.acquire("oauth", async () => {
    throw new Error("unexpected exchange");
  });
  expect(second.value).toBe(first.value);
  vi.setSystemTime(Date.now() + 481_000);
  const current = await cache.resolve("oauth", async () => ({
    data: { access_token: "new-token", expires_in: 600 },
  }));
  first.release();
  first.release();
  cache.invalidateMatchingToken("old-token");
  expect(cache.wasRejected(second.value)).toBe(true);
  expect(cache.wasRejected(current)).toBe(false);
  second.assertCurrent();
  second.release();
  await expect(
    cache.resolve("oauth", async () => {
      throw new Error("unexpected exchange");
    }),
  ).resolves.toBe(current);
});

it("released leases do not create a retained token history", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const released = [];
  for (let index = 0; index < 3; index++) {
    const lease = await cache.acquire("oauth", async () => ({
      data: { access_token: `old-${index}`, expires_in: 600 },
    }));
    released.push(lease.value);
    lease.release();
    vi.setSystemTime(Date.now() + 481_000);
  }
  const current = await cache.resolve("oauth", async () => ({
    data: { access_token: "current", expires_in: 600 },
  }));
  for (const value of released) {
    cache.invalidateMatchingToken(value.token);
    expect(cache.wasRejected(value)).toBe(false);
  }
  expect(cache.wasRejected(current)).toBe(false);
});

it("a rejection captured with an empty cache can target its first active credential", async () => {
  vi.useFakeTimers();
  const cache = new ZaiBusinessTokenCache();
  const reject = cache.captureMatchingRejection();
  const lease = await cache.acquire("oauth", async () => ({
    data: { access_token: "old-token", expires_in: 600 },
  }));
  vi.setSystemTime(Date.now() + 481_000);
  const current = await cache.resolve("oauth", async () => ({
    data: { access_token: "new-token", expires_in: 600 },
  }));
  reject(lease.value.token);
  expect(cache.wasRejected(lease.value)).toBe(true);
  expect(cache.wasRejected(current)).toBe(false);
  lease.release();
});

it.each(["clear", "account-switch"])(
  "rejection scopes and active leases cannot cross %s with the same JWT",
  async (action) => {
    const cache = new ZaiBusinessTokenCache();
    const exchange = async () => ({ data: { access_token: "same-token", expires_in: 600 } });
    const old = await cache.acquire("oauth", exchange);
    const reject = cache.captureMatchingRejection();
    if (action === "clear") cache.clear();
    const oauth = action === "clear" ? "oauth" : "other-oauth";
    const current = await cache.acquire(oauth, exchange);
    expect(() => old.assertCurrent()).toThrow("project_token_scope_invalidated");
    old.release();
    reject("same-token");
    expect(cache.wasRejected(current.value)).toBe(false);
    expect(cache.wasRejected(old.value)).toBe(false);
    current.assertCurrent();
    current.release();
  },
);
