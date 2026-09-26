export type ProjectRole = "maintainer" | "developer" | "reviewer" | "viewer";
export type Capability = "project.read" | "project.members" | "task.create" | "task.update" | "run.start" | "run.stop" | "review.submit" | "git.push" | "git.merge";

const capabilities: Record<ProjectRole, ReadonlySet<Capability>> = {
  maintainer: new Set(["project.read", "project.members", "task.create", "task.update", "run.start", "run.stop", "review.submit", "git.push", "git.merge"]),
  developer: new Set(["project.read", "task.create", "task.update", "run.start", "run.stop", "review.submit", "git.push"]),
  reviewer: new Set(["project.read", "review.submit"]),
  viewer: new Set(["project.read"]),
};

export function permits(role: ProjectRole | null, capability: Capability): boolean {
  return role !== null && capabilities[role]?.has(capability) === true;
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

export function requireCapability(role: ProjectRole | null, capability: Capability) {
  if (!permits(role, capability)) throw new DomainError("forbidden", "You do not have permission for this operation", 403);
}
