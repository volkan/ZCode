import { expect, it, vi } from "vitest";
import * as implementation from "../zai-business-token-cache.js";
import type { ZaiBusinessTokenLifecycleContract, ZaiBusinessTokenLease } from "./contract.js";
import { withZaiBusinessToken } from "./contract.example.js";

it("the consumer example releases its caller-owned lease after a failed operation", async () => {
  const contract: ZaiBusinessTokenLifecycleContract = implementation;
  const cache = new contract.ZaiBusinessTokenCache();
  const exchange = async () => ({ data: { access_token: "test-token", expires_in: 600 } });
  const lease: ZaiBusinessTokenLease = await cache.acquire("test-oauth", exchange);
  const release = vi.spyOn(lease, "release");
  vi.spyOn(cache, "acquire").mockResolvedValueOnce(lease);
  const failure = new Error("test consumer failure");
  await expect(
    withZaiBusinessToken(cache, "test-oauth", exchange, async (token) => {
      expect(token).toBe(lease.value);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(release).toHaveBeenCalledOnce();
});
