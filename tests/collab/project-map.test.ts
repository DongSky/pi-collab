import test from "node:test";
import assert from "node:assert/strict";
import { dependencyLayers, mapConflicts, taskAttention, type MapTask } from "../../lib/collab/project-map-model";

const task = (id: string, repository = "repo"): MapTask => ({ id, title: id, status: "in_progress", owner_id: id, owner_name: id, owner_active: true,
  run: { id, status: "running", dependency_state: "current", requested_by: id, requested_name: id, workspace_status: "busy", repository_id: repository,
    repository_name: repository, model_id: "model", model_name: "Model", started_at: null, created_at: new Date().toISOString() },
  result: null, resources: [], intent: { paths: ["src/"], symbols: [], changeType: "feature", summary: "Changes", expectedCompletion: null } });

test("dependency map lays out diamonds and independent tasks, without turning a cycle into runnable roots", () => {
  const tasks = ["a", "b", "c", "d", "e", "f", "g"].map(taskId => task(taskId));
  const edges = [["b", "a"], ["c", "a"], ["d", "b"], ["d", "c"], ["f", "g"], ["g", "f"]].map(([task_id, depends_on]) => ({ task_id, depends_on, kind: "strict" }));
  const { depths, unresolved } = dependencyLayers(tasks, edges);
  assert.deepEqual([...depths.entries()].sort(), [["a", 0], ["b", 1], ["c", 1], ["d", 2], ["e", 0]]);
  assert.deepEqual(unresolved, ["f", "g"]);
});
test("scope radar excludes other repositories, closed tasks and undeclared runs, and discloses bounded coverage", () => {
  const a = task("a"), b = task("b"), other = task("other", "another-repo"), done = { ...task("done"), status: "done" }, undeclared = { ...task("none"), intent: null };
  assert.deepEqual(mapConflicts([a, b, other, done, undeclared]).conflicts.map(c => [c.left, c.right]), [["a", "b"]]);
  const many = Array.from({ length: 201 }, (_, i) => task(String(i), String(i)));
  assert.equal(mapConflicts(many).conflictsLimited, true);
});
test("attention distinguishes missing strict results, advisory soft dependencies, stale evidence and completed inference", () => {
  const a = task("a"), b = task("b");
  a.run!.status = "completed";
  const edges = [{ task_id: "a", depends_on: "b", kind: "strict" }];
  assert.deepEqual(taskAttention(a, [a, b], edges), ["等待 1 项有效上游成果"]);
  assert.deepEqual(taskAttention(a, [a, b], [{ ...edges[0], kind: "soft" }]), []);
  b.result = { id: "result", version: 1, current: true };
  assert.deepEqual(taskAttention(a, [a, b], edges), []);
  a.run!.dependency_state = "needs_revalidation";
  assert.deepEqual(taskAttention(a, [a, b], edges), ["依赖或契约已变化，需重新验证"]);
  a.status = "done";
  assert.deepEqual(taskAttention(a, [a, b], edges), []);
});
