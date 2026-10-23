import { expect, it } from "vitest";
import * as implementation from "../project-access-token.js";
import type { ProjectTokenCacheContract, ProjectAccessTokenScope } from "./contract.js";
import { resolveProjectToken } from "./contract.example.js";

it("the consumer example reuses its caller's existing cache owner", async () => {
  const contract: ProjectTokenCacheContract = implementation;
  const cache = new contract.ProjectAccessTokenCache({ now: () => 1_000, random: () => 0 });
  const scope: ProjectAccessTokenScope = {
    origin: "https://example.invalid",
    family: "zai",
    accountId: "test-account",
    organizationId: "test-organization",
    projectId: "test-project",
    apiKeyId: "test-key",
    usageScene: 1,
    loginGeneration: "test-login",
  };
  const existing = await cache.resolve(scope, async () => ({
    code: 200,
    data: {
      enable: true,
      accessToken: "test-token",
      tokenType: "Bearer",
      expiresIn: 600,
      expiresAt: 601,
    },
  }));
  await expect(
    resolveProjectToken(cache, scope, async () => {
      throw new Error("The example must reuse the supplied cache");
    }),
  ).resolves.toBe(existing);
});
