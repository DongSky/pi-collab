import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), prefix = process.env.PI_COLLAB_RUNTIME === 'docker' ? 'container-evidence' : 'evidence';
export async function verifyEvidence({ base, projectId, owner, member, ownerContext, memberContext }) {
  const worker = async (mode, id) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'scripts/e2e-snapshot-worker.ts', mode, ...(id ? [id] : [])], { timeout: 60000 })).stdout.trim());
  const post = async (endpoint, data, context = memberContext) => { const r = await context.request.post(`${base}/api/collab/${endpoint}`, { headers: { Origin: base }, data }); assert.ok(r.ok(), `${endpoint}: ${r.status()}`); return r.json(); };
  const get = async endpoint => { const r = await memberContext.request.get(`${base}/api/collab/${endpoint}`); assert.ok(r.ok()); return r.json(); };
  const repository = await worker('init', projectId);
  const task = await post(`projects/${projectId}/tasks`, { title: '统一变更证据验收', description: '代码、验证、评论汇集在同一份记录中', acceptance: '可以下载并逐项核对受检版本，撤回后不能当作当前成果' });
  await post(`tasks/${task.id}/runs`, { repositoryId: repository.id, baseSha: repository.baseSha, prompt: 'Evidence fixture without inference', expectedVersion: task.version, idempotencyKey: randomUUID() });
  const run = await worker('preview', task.id), detail = await get(`runs/${run.runId}`);
  const snapshot = await post(`runs/${run.runId}/snapshots`, { expectedRevision: detail.run.revision, note: '统一变更证据的固定源文件', idempotencyKey: randomUUID() }); await worker('capture');
  const profile = await post(`projects/${projectId}/validation-profiles`, { repositoryId: repository.id, name: '证据命令检查', config: { version: 1, steps: [{ tool: 'node', args: ['check.cjs'], timeoutSeconds: 10 }] }, idempotencyKey: randomUUID() }, ownerContext);
  const validation = await post(`snapshots/${snapshot.snapshotId}/validations`, { profileId: profile.profileId, idempotencyKey: randomUUID() }); assert.equal((await worker('validate')).outcome, 'passed');
  const listing = await get(`tasks/${task.id}/results`);
  const result = await post(`tasks/${task.id}/results`, { validationId: validation.validationId, expectedVersion: listing.task.version, note: '固定代码与通过验证的成果', idempotencyKey: randomUUID() });
  await post(`tasks/${task.id}/discussions`, { action: 'create', title: '固定证据评审', body: '已经核对验收目标，请一起核对代码与命令。', anchor: null, replacement: null, mentions: [], idempotencyKey: randomUUID() }, ownerContext);
  for (const page of [owner, member]) { await page.goto(base); await page.locator('.collab-task-row').filter({ hasText: task.title }).click(); }
  const a = owner.getByRole('region', { name: '变更证据包 v1', exact: true }), b = member.getByRole('region', { name: '变更证据包 v1', exact: true });
  await a.getByRole('button', { name: '查看变更证据包', exact: true }).click();
  await a.getByText('汇集时成果与依赖有效；验证通过不等于允许合并。', { exact: true }).waitFor();
  await a.getByText('原始需求与验收', { exact: true }).click(); await a.getByText(task.acceptance, { exact: true }).waitFor();
  await a.getByText(/固定代码差异 ·/).click(); await a.getByText('preview/index.html · added', { exact: true }).click();
  await a.locator('pre').filter({ hasText: '<h1>已验证的固定页面</h1>' }).waitFor();
  const downloaded = member.waitForEvent('download'); await b.getByRole('button', { name: '下载证据包 JSON', exact: true }).click();
  const stream = await (await downloaded).createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const bundle = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(bundle.sha256, createHash('sha256').update(JSON.stringify(bundle.payload)).digest('hex'));
  assert.equal(bundle.payload.result.id, result.resultId); assert.equal(bundle.payload.discussions.length, 1); assert.equal(bundle.payload.validation.evidence.steps[0].exitCode, 0);
  await a.screenshot({ path: `test-results/collab/${prefix}-desktop.png` });
  await member.setViewportSize({ width: 390, height: 844 }); await b.scrollIntoViewIfNeeded(); assert.equal(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await b.screenshot({ path: `test-results/collab/${prefix}-mobile.png` });
  await post(`results/${result.resultId}/withdraw`, { reason: '证据已完成双成员核对，撤回后必须显示历史状态' });
  await a.getByText('记录已变化，请重新汇集证据。', { exact: true }).waitFor({ timeout: 15000 });
  await a.getByRole('button', { name: '重新汇集证据', exact: true }).click(); await a.getByText(/撤回原因：证据已完成双成员核对/).waitFor();
  assert.equal((await fetch(`${base}/api/collab/results/${result.resultId}/evidence`)).status, 401);
  console.log('PASS: real Pi snapshot and validation, two-member evidence UI/download/hash verification, exact diff, comments, withdrawal state, desktop/mobile; no inference.');
}
