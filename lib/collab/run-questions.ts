import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { answerInput } from "./question-schema";
export function runQuestions(user: string, run: string) {
  uuid.parse(run);
  return asUser(user, async db => {
    const r = (await db.query("SELECT id,status,collab.control_state(id) AS control FROM collab.runs WHERE id=$1", [run])).rows[0];
    if (!r) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    const questions = (await db.query("SELECT q.id,q.payload->>'question' AS question,q.payload->'choices' AS choices,q.status,q.created_at,q.answered_at,q.answer,q.answered_by,u.name AS author_name,q.control_version::text FROM collab.run_questions q LEFT JOIN public.\"user\" u ON u.id=q.answered_by WHERE q.run_id=$1 ORDER BY q.created_at,q.id", [run])).rows;
    return { run: r, questions };
  });
}
export function answerQuestion(user: string, question: string, raw: unknown) {
  uuid.parse(question); const input = answerInput.parse(raw);
  return asUser(user, async db => (await db.query("SELECT collab.answer_run_question($1,$2,$3,$4) AS result", [question, input.expectedVersion, input.idempotencyKey, input.answer])).rows[0].result);
}
