import type { ZaiBusinessTokenLifecycleContract, ZaiBusinessToken } from "./contract.js";

export async function withZaiBusinessToken<T>(
  cache: InstanceType<ZaiBusinessTokenLifecycleContract["ZaiBusinessTokenCache"]>,
  oauth: string,
  exchange: () => Promise<unknown>,
  use: (token: ZaiBusinessToken) => Promise<T>,
): Promise<T> {
  const lease = await cache.acquire(oauth, exchange);
  try {
    lease.assertCurrent();
    return await use(lease.value);
  } finally {
    lease.release();
  }
}
