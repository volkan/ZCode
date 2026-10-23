export const projectTokenCacheModule = {
  id: "project-token-cache",
  requires: ["shared"],
  provides: ["project-token-cache"],
  publicEntrypoints: ["../project-access-token.ts", "contract.ts"],
} as const;
