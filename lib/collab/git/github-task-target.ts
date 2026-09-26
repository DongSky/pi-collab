import { z } from "zod";
import { GitHubHttp } from "./github-http";
import { GitHubError } from "./github-credentials";
import { githubId, githubBranch, repositoryResponse, repositoriesResponse, branchResponse, type GitHubInstallationEvidence } from "./github-schema";

export const githubPushBinding = z.object({ repositoryId: z.uuid(), githubRepositoryId: githubId,
  nodeId: repositoryResponse.shape.node_id, ownerId: githubId, ownerLogin: repositoryResponse.shape.owner.shape.login,
  name: repositoryResponse.shape.name, defaultBranch: githubBranch, private: z.boolean(), visibility: z.enum(["public", "private", "internal"]),
  integrationBranches: z.array(githubBranch).min(1).max(20),
}).strict().refine(value => value.private === (value.visibility !== "public"));
export type GitHubPushBinding = z.infer<typeof githubPushBinding>;
const directRef = z.object({ ref: z.string(), object: z.object({ type: z.literal("commit"), sha: z.string().regex(/^[a-f0-9]{40}$/) }) });
const rules = z.array(z.object({ type: z.string().min(1).max(100) })).max(100);
export type GitHubPushObservation = { version: 1; installation: GitHubInstallationEvidence; repository: GitHubPushBinding;
  defaultSha: string; ref: string; observedOld: string | null; protected: false; activeRules: 0; verifiedAt: string };
const fail = (code: string): never => { throw new GitHubError(code); };
function checkRepository(raw: unknown, binding: GitHubPushBinding) {
  const repo = repositoryResponse.parse(raw);
  if (repo.id !== binding.githubRepositoryId || repo.node_id !== binding.nodeId || repo.owner.id !== binding.ownerId || repo.owner.login !== binding.ownerLogin
    || repo.name !== binding.name || repo.default_branch !== binding.defaultBranch || repo.private !== binding.private || repo.visibility !== binding.visibility) fail("github_push_repository_changed");
  if (repo.archived || repo.disabled) fail("github_repository_inactive");
}

/** Internal metadata policy shared by read-only preview and write preflight.
 * The bearer is retained by provider clients; the returned observation is not
 * a write capability or evidence of platform membership/confirmation. */
export async function inspectGitHubTaskTarget(http: GitHubHttp, binding: GitHubPushBinding, ref: string,
  bearer: string, installation: GitHubInstallationEvidence, signal: AbortSignal): Promise<GitHubPushObservation> {
  if (installation.permissions.contents !== "write" || installation.accountId !== binding.ownerId) fail("github_contents_write_required");
  const listing = repositoriesResponse.parse(await http.request("GET", "/installation/repositories?per_page=2&page=1", bearer, signal));
  checkRepository(listing.repositories[0], binding);
  checkRepository(await http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer, signal), binding);
  const branch = ref.slice("refs/heads/".length), route = `/repos/${binding.ownerLogin}/${binding.name}`;
  if (branch === binding.defaultBranch || binding.integrationBranches.includes(branch)) fail("github_push_protected_destination");
  const baseline = branchResponse.parse(await http.request("GET", `${route}/branches/${encodeURIComponent(binding.defaultBranch)}`, bearer, signal));
  if (baseline.name !== binding.defaultBranch) fail("github_repository_mismatch");
  const rawRef = await http.request("GET", `${route}/git/ref/heads/${encodeURIComponent(branch)}`, bearer, signal, undefined, true);
  const rawBranch = await http.request("GET", `${route}/branches/${encodeURIComponent(branch)}`, bearer, signal, undefined, true);
  let observedOld: string | null = null;
  if (rawRef !== null || rawBranch !== null) {
    const pointer = directRef.parse(rawRef), state = branchResponse.parse(rawBranch);
    if (pointer.ref !== ref || state.name !== branch || state.commit.sha !== pointer.object.sha) fail("github_push_ref_changed");
    if (state.protected) fail("github_push_protected_destination"); observedOld = pointer.object.sha;
  }
  // Includes active inherited rules and names which do not exist yet. Any rule
  // means no bypass, including rules whose semantics are not implemented here.
  if (rules.parse(await http.request("GET", `${route}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=1`, bearer, signal)).length) fail("github_push_protected_destination");
  checkRepository(await http.request("GET", `/repositories/${binding.githubRepositoryId}`, bearer, signal), binding);
  return { version: 1, installation, repository: structuredClone(binding), defaultSha: baseline.commit.sha, ref, observedOld, protected: false, activeRules: 0, verifiedAt: new Date().toISOString() };
}
