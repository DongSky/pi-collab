import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';

export async function verifyProjectMap({ base, config, projectId, ownerContext, memberContext, owner, member }) {
 const databaseName = process.env.PI_COLLAB_E2E_DATABASE;
 if (!/^pi_collab_test_[a-f0-9]+$/.test(databaseName ?? '')) throw new Error('Isolated database required');
 const admin = new Pool({ connectionString: `postgresql://pi_collab_admin:${encodeURIComponent(config.adminPassword)}@127.0.0.1:${config.databasePort}/${databaseName}` });
 const post = async (context, path, data) => {
  const response = await context.request.post(`${base}/api/collab/${path}`, { headers: { Origin: base }, data });
  assert.ok(response.ok(), `Map fixture ${path}: HTTP ${response.status()}`); return response.json();
 };
 try {
  const repositories = await (await ownerContext.request.get(`${base}/api/collab/projects/${projectId}/repositories`)).json();
  const repo = repositories.repositories[0];
  const a = await post(ownerContext, `projects/${projectId}/tasks`, { title: '全景：后端接口', description: '接口与范围声明', acceptance: '固定契约' });
  const b = await post(memberContext, `projects/${projectId}/tasks`, { title: '全景：前端页面', description: '并行界面开发', acceptance: '集成通过' });
  await post(memberContext, `tasks/${b.id}/dependencies`, { dependsOn: a.id, kind: 'soft' });
  const current = await (await memberContext.request.get(`${base}/api/collab/projects/${projectId}`)).json();
  b.version = current.tasks.find(t => t.id === b.id).version;
  for (const [context, task, paths] of [[ownerContext, a, ['src/api/']], [memberContext, b, ['src/api/client.ts']]]) {
   const run = await post(context, `tasks/${task.id}/runs`, { repositoryId: repo.id, baseSha: repo.base_sha, expectedVersion: task.version, idempotencyKey: randomUUID(), prompt: 'Project map protocol fixture, no inference' });
   await post(context, `runs/${run.runId}/intents`, { expectedRevision: 0, idempotencyKey: randomUUID(), declaration: { paths, symbols: ['Order'], changeType: 'feature', summary: '协作接口范围', expectedCompletion: null } });
  }
  for (const page of [owner, member]) {
   await page.goto(`${base}/`);
   await page.getByRole('button', { name: '任务与 AI 全景', exact: true }).click();
   await page.locator('.collab-map-card').filter({ hasText: '全景：后端接口' }).waitFor();
   await page.locator('.collab-map-card').filter({ hasText: '全景：前端页面' }).waitFor();
  }
  const map = await (await memberContext.request.get(`${base}/api/collab/projects/${projectId}/map`)).json();
  assert.ok(map.conflicts.some(c => [c.left, c.right].includes(a.id) && [c.left, c.right].includes(b.id)));
  await member.getByLabel('关注范围', { exact: true }).selectOption('conflicts');
  assert.equal(await member.locator('.collab-map-card').count(), 2);
  await member.locator('.collab-map-card').filter({ hasText: '全景：前端页面' }).click();
  await member.getByLabel('全景任务详情').getByText('软依赖 · 可先按约定开发', { exact: true }).waitFor();
  await member.getByLabel('全景任务详情').getByText('src/api/client.ts', { exact: true }).waitFor();
  await member.getByLabel('排列方式', { exact: true }).selectOption('owner');
  assert.equal(await member.locator('.collab-map-lane').count(), 2);
  await mkdir('test-results/collab', { recursive: true });
  await member.setViewportSize({ width: 1440, height: 1000 });
  await member.screenshot({ path: 'test-results/collab/project-map-desktop.png', fullPage: true });
  await member.setViewportSize({ width: 390, height: 844 });
  assert.equal(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await member.screenshot({ path: 'test-results/collab/project-map-mobile.png', fullPage: true });
  await member.getByRole('button', { name: '打开任务与运行', exact: true }).click();
  await member.getByRole('heading', { name: '全景：前端页面', exact: true }).waitFor();
  await member.getByRole('button', { name: '任务与 AI 全景', exact: true }).click();
  const c = await post(ownerContext, `projects/${projectId}/tasks`, { title: '全景：自动同步的新任务', description: '', acceptance: '' });
  await member.locator('.collab-map-card').filter({ hasText: c.title }).waitFor({ timeout: 15000 });
  await member.getByLabel('搜索任务', { exact: true }).fill(c.title);
  assert.equal(await member.locator('.collab-map-card').count(), 1);
  await member.locator('.collab-map-card').click();
  await member.getByRole('button', { name: '打开任务与运行', exact: true }).click();
  await member.getByRole('heading', { name: c.title, exact: true }).waitFor();
  assert.equal(await member.getByRole('button', { name: '编辑任务与状态', exact: true }).count(), 0);
  const editable = await post(memberContext, `projects/${projectId}/tasks`, { title: '全景：可维护的任务', description: '原始目标', acceptance: '原始验收' });
  await member.getByRole('button', { name: '刷新', exact: true }).click();
  await member.locator('.collab-task-row').filter({ hasText: editable.title }).click();
  await member.getByRole('button', { name: '编辑任务与状态', exact: true }).click();
  await member.getByLabel('任务标题', { exact: true }).fill('全景：目标已更新');
  await member.getByLabel('任务目标', { exact: true }).fill('已经明确的新目标');
  await member.getByLabel('任务验收', { exact: true }).fill('验证新目标对应的行为');
  await member.getByLabel('任务状态', { exact: true }).selectOption('ready');
  await member.getByLabel('修改原因', { exact: true }).fill('团队讨论后更新目标与验收标准');
  await member.getByRole('button', { name: '保存任务', exact: true }).click();
  await member.getByText('任务已更新；原成果和验证不再适用于新目标，请重新运行与验证。', { exact: true }).waitFor();
  await owner.locator('.collab-map-card').filter({ hasText: '全景：目标已更新' }).waitFor({ timeout: 15000 });
  await member.getByRole('button', { name: '编辑任务与状态', exact: true }).click();
  await member.getByLabel('任务状态', { exact: true }).selectOption('done');
  await member.getByRole('checkbox', { name: '我已核对验收标准；标记完成不会批准或合并代码。', exact: true }).check();
  await member.getByLabel('修改原因', { exact: true }).fill('已人工核对任务目标与验收标准');
  await member.getByRole('button', { name: '保存任务', exact: true }).click();
  await member.getByText('任务已更新。', { exact: true }).waitFor();
  await member.locator('.collab-task-edit-history details').filter({ hasText: '现：已完成' }).locator('summary').click();
  await member.getByText('现：已完成', { exact: true }).waitFor();
  await member.screenshot({ path: 'test-results/collab/task-lifecycle-mobile.png', fullPage: true });
  const latest = (await (await memberContext.request.get(`${base}/api/collab/projects/${projectId}`)).json()).tasks.find(t => t.id === editable.id);
  assert.equal(latest.status, 'done');
  const stale = await memberContext.request.patch(`${base}/api/collab/tasks/${editable.id}`, { headers: { Origin: base }, data: { title: 'Old window', description: '', acceptance: '', status: 'draft', reason: 'An older browser attempting to overwrite', expectedVersion: editable.version, idempotencyKey: randomUUID(), acknowledgeCompletion: false } });
  assert.equal(stale.status(), 409);
  await member.getByRole('button', { name: '任务与 AI 全景', exact: true }).click();
  await member.locator('.collab-map-card').filter({ hasText: '全景：目标已更新' }).waitFor();
  const membership = (await admin.query('SELECT pm.user_id FROM collab.project_memberships pm JOIN public."user" u ON u.id=pm.user_id WHERE pm.project_id=$1 AND u.email=$2', [projectId, 'browser-member@pi-collab.test'])).rows[0];
  await admin.query('UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2', [projectId, membership.user_id]);
  try {
   await member.getByText('项目访问权限已失效，请返回项目列表。', { exact: true }).waitFor({ timeout: 15000 });
   assert.equal(await member.locator('.collab-map-card').count(), 0);
   assert.equal((await memberContext.request.get(`${base}/api/collab/projects/${projectId}/map`)).status(), 404);
  } finally { await admin.query('UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2', [projectId, membership.user_id]); }
  console.log('PASS: project map shared runs/dependencies/conflicts, member grouping, filters, task editing/completion/history, stale update rejection, live refresh, revocation and desktop/mobile layout; no model inference.');
 } finally { await admin.end(); }
}
