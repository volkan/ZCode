export type ProjectTokenCacheContract = Pick<
  typeof import("../project-access-token.js"),
  | "ProjectAccessTokenCache"
  | "ProjectAccessTokenError"
  | "ProjectAccessTokenTransientError"
  | "projectAccessTokenFingerprint"
>;
export type { ProjectAccessTokenScope, ProjectAccessTokenResult } from "../project-access-token.js";
