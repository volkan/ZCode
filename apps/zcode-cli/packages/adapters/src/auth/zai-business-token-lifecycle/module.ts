export const zaiBusinessTokenLifecycleModule = {
  id: "zai-business-token-lifecycle",
  requires: ["shared"],
  provides: ["zai-business-token-lifecycle"],
  publicEntrypoints: ["../zai-business-token-cache.ts", "contract.ts"],
} as const;
