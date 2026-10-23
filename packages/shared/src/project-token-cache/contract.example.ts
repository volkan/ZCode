import type { ProjectTokenCacheContract, ProjectAccessTokenScope } from "./contract.js";

export function resolveProjectToken(
  cache: InstanceType<ProjectTokenCacheContract["ProjectAccessTokenCache"]>,
  scope: ProjectAccessTokenScope,
  issue: () => Promise<unknown>,
) {
  return cache.resolve(scope, issue);
}
