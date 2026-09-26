import { z } from "zod";

export const githubId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,15}$/)])
  .transform(String).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
export const githubAppConfig = z.object({ appId: githubId, installationId: githubId, accountId: githubId }).strict();
export type GitHubAppConfig = z.infer<typeof githubAppConfig>;
const login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(value => ![".", ".."].includes(value));
export const githubBranch = z.string().min(1).max(240).refine(value => !/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
  && !value.includes("..") && !value.includes("@{") && !value.endsWith(".") && value !== "@"
  && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")));
const permissions = z.record(z.string().max(100), z.enum(["read", "write", "admin"]));
export const appResponse = z.object({ id: githubId, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) });
export const installationResponse = z.object({
  id: githubId, app_id: githubId, account: z.object({ id: githubId, login, type: z.enum(["User", "Organization"]) }),
  suspended_at: z.string().nullable(), repository_selection: z.enum(["all", "selected"]), permissions,
});
export const repositoryResponse = z.object({
  id: githubId, node_id: z.string().min(1).max(200), name, owner: z.object({ id: githubId, login }),
  default_branch: githubBranch, archived: z.boolean(), disabled: z.boolean(), private: z.boolean(), visibility: z.enum(["public", "private", "internal"]).optional(),
});
export const repositoriesResponse = z.object({ total_count: z.literal(1), repositories: z.array(repositoryResponse).length(1) });
export const tokenResponse = z.object({ token: z.string().min(1).max(2048).refine(value => !/[\x00-\x20\x7f]/.test(value)), expires_at: z.iso.datetime(), permissions });
export const branchResponse = z.object({ name: githubBranch, protected: z.boolean(), commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) });
export interface GitHubInstallationEvidence {
  version: 1; appId: string; appSlug: string; installationId: string; accountId: string; accountLogin: string; accountType: "User" | "Organization";
  repositorySelection: "all" | "selected"; permissions: Record<string, "read" | "write" | "admin">; verifiedAt: string;
}
export interface GitHubRepositoryEvidence {
  version: 1; installation: GitHubInstallationEvidence; repositoryId: string; nodeId: string; ownerId: string; ownerLogin: string; name: string;
  defaultBranch: string; targetSha: string; visibility: "public" | "private" | "internal" | "unknown"; private: boolean; branchProtected: boolean; htmlUrl: string;
  verifiedAt: string; tokenExpiresAt: string; tokenRevoked: true;
  capabilities: { metadataRead: true; contentsRead: true; push: false; pullRequest: false; protectedMerge: false };
}
