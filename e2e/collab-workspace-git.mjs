import { openTask, resizeWorkspace } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
const exec = promisify(execFile);

export async function verifyWorkspaceGitUi({ base, config, projectId, ownerContext, memberContext, owner, member }) {
  const dbName = process.env.PI_COLLAB_E2E_DATABASE;
  if (!/^pi_collab_test_[a-f0-9]+$/.test(dbName ?? '')) throw new Error('Isolated database required');
  const admin = new Pool({ connectionString: `postgresql://pi_collab_admin:${encodeURIComponent(config.adminPassword)}@127.0.0.1:${config.databasePort}/${dbName}` });
  const worker = async (mode, id) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'scripts/e2e-workspace-git-worker.ts', mode, id], { timeout: 60000 })).stdout.trim());
  const headers = { Origin: base }, title = '双成员 Git 暂存提交验收', original = owner.url();
  const memberId = (await (await memberContext.request.get(`${base}/api/collab/me`)).json()).user.id;
  const open = async page => { await page.goto(base); await openTask(page, title, 'Git 变更'); };
  const panel = page => page.getByRole('region', { name: '工作区 Git', exact: true });
  const query = (revision, layer, path) => new URLSearchParams({ revision, layer, path });
  try {
    const repo = await worker('init', projectId);
    const taskResponse = await memberContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`, { headers, data: { title, description: '真实 Pi 工具草稿、浏览器选择与原生 Git 写入', acceptance: '并发隔离和响应丢失不重复写入' } }); assert.equal(taskResponse.status(), 200); const task = await taskResponse.json();
    const accepted = await memberContext.request.post(`${base}/api/collab/tasks/${task.id}/runs`, { headers, data: { repositoryId: repo.id, baseSha: repo.baseSha, prompt: 'Native Pi tool diagnostic, no model inference', expectedVersion: task.version, idempotencyKey: randomUUID() } }); assert.equal(accepted.status(), 202);
    const run = await worker('run', task.id), runId = run.runId;
    for (const page of [owner, member]) await open(page);
    const ui = panel(member), peer = panel(owner), endpoint = `${base}/api/collab/runs/${runId}/git`;
    await ui.getByRole('button', { name: '读取 Git 差异', exact: true }).click(); await ui.getByRole('button', { name: '工作文件 code.txt', exact: true }).click();
    const file = ui.getByRole('article', { name: 'Git 文件 code.txt', exact: true });
    await file.getByRole('checkbox', { name: '暂存片段 1', exact: true }).check(); assert.equal(await file.getByRole('checkbox', { name: '暂存片段 2', exact: true }).isChecked(), false);
    await ui.getByRole('checkbox', { name: '暂存整文件 binary.bin', exact: true }).check();
    await ui.getByRole('checkbox', { name: '确认本次暂存选择', exact: true }).check();
    const oldResponse = await memberContext.request.get(`${endpoint}/preview`); assert.equal(oldResponse.status(), 200); const old = await oldResponse.json();
    assert.equal(oldResponse.headers()['cache-control'], 'no-store'); assert.ok(old.exclusions.some(f => f.path === '.env'));
    assert.equal((await memberContext.request.get(`${endpoint}/file?${query(old.revision, 'working', '.env')}`)).status(), 409);
    assert.equal((await memberContext.request.get(`${endpoint}/file?${query(old.revision, 'working', '../source/code.txt')}`)).status(), 400);
    const body = { kind: 'stage', revision: old.revision, expectedRunRevision: old.runRevision, selections: [{ path: 'code.txt', direction: 'stage', hunks: 'file' }], acknowledge: true, idempotencyKey: randomUUID() };
    assert.equal((await memberContext.request.post(endpoint, { headers: { Origin: 'https://untrusted.invalid' }, data: body })).status(), 403);
    assert.equal((await memberContext.request.post(endpoint, { headers, data: { ...body, actorId: memberId } })).status(), 400);
    let lost = true;
    await member.route(`**/api/collab/runs/${runId}/git`, async route => {
      if (route.request().method() === 'POST' && lost) { lost = false; assert.equal((await route.fetch()).status(), 202); await route.abort('failed'); } else await route.continue();
    });
    await ui.getByRole('button', { name: '应用暂存选择', exact: true }).click(); await ui.getByRole('button', { name: '重试同一 Git 请求', exact: true }).waitFor();
    await member.reload(); await openTask(member, title, 'Git 变更');
    await ui.getByRole('button', { name: '重试同一 Git 请求', exact: true }).click(); await ui.getByText('请求已接纳。请等待下方操作记录确认，然后重新读取差异。', { exact: true }).waitFor();
    const jobs = async () => (await admin.query('SELECT id,status FROM collab_git.workspace_operations WHERE run_id=$1 ORDER BY created_at,id', [runId])).rows;
    assert.equal((await jobs()).length, 1); const stage = (await jobs())[0].id;
    await peer.getByRole('article', { name: `Git 操作 ${stage}`, exact: true }).getByRole('status').filter({ hasText: '等待 Git 服务' }).waitFor();
    assert.equal((await ownerContext.request.post(endpoint, { headers, data: body })).status(), 409);
    assert.equal((await worker('process', stage)).status, 'applied'); await ui.getByRole('article', { name: `Git 操作 ${stage}`, exact: true }).getByRole('status').filter({ hasText: '操作已应用' }).waitFor();
    const staged = await worker('inspect', runId); assert.equal(staged.head, repo.baseSha); assert.ok(staged.staged.includes('chosen first change')); assert.ok(!staged.staged.includes('remaining second change'));
    assert.equal((await ownerContext.request.get(`${endpoint}/file?${query(old.revision, 'working', 'code.txt')}`)).status(), 409);

    await ui.getByRole('button', { name: '读取 Git 差异', exact: true }).click();
    await ui.getByLabel('Git 提交说明', { exact: true }).fill('只提交已核对的第一个片段与二进制 fixture');
    assert.equal(await ui.getByRole('button', { name: '提交已暂存内容', exact: true }).isDisabled(), true);
    await ui.getByRole('button', { name: '暂存文件 code.txt', exact: true }).click();
    await file.getByRole('checkbox', { name: '已核对暂存文件 code.txt', exact: true }).check();
    await ui.getByRole('button', { name: '暂存文件 binary.bin', exact: true }).click();
    const binary = ui.getByRole('article', { name: 'Git 文件 binary.bin', exact: true }); await binary.getByText(/此文件包含二进制/).waitFor();
    assert.equal(await binary.getByRole('checkbox', { name: /暂存片段/ }).count(), 0); await binary.getByRole('checkbox', { name: '已核对暂存文件 binary.bin', exact: true }).check();
    await ui.getByRole('checkbox', { name: '确认全部暂存内容与提交说明', exact: true }).check();
    await ui.screenshot({ path: 'test-results/collab/workspace-git-confirmation.png' });
    await resizeWorkspace(member, { width: 390, height: 844 }); await ui.screenshot({ path: 'test-results/collab/workspace-git-confirmation-mobile.png' });
    assert.ok(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await resizeWorkspace(member, { width: 1440, height: 1000 });
    await Promise.all([member.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST'), ui.getByRole('button', { name: '提交已暂存内容', exact: true }).click()]);
    const commit = (await jobs()).at(-1).id; assert.notEqual(commit, stage);
    assert.equal((await worker('crash', commit)).status, 'attention');
    const card = ui.getByRole('article', { name: `Git 操作 ${commit}`, exact: true }); await card.getByRole('status').filter({ hasText: '结果待核查' }).waitFor();
    const committed = await worker('inspect', runId); assert.equal(committed.count, '2');
    await card.getByLabel('Git 操作处理原因', { exact: true }).fill('核查已经落盘的提交，不创建第二次提交。');
    await Promise.all([member.waitForResponse(r => r.url().endsWith(`/workspace-git/${commit}/actions`) && r.request().method() === 'POST'), card.getByRole('button', { name: '核查原 Git 操作', exact: true }).click()]);
    assert.equal((await worker('process', commit)).status, 'applied'); await card.getByRole('status').filter({ hasText: '操作已应用' }).waitFor();
    assert.equal((await worker('inspect', runId)).head, committed.head);
    await peer.getByRole('article', { name: `Git 操作 ${commit}`, exact: true }).getByRole('status').filter({ hasText: '操作已应用' }).waitFor();

    // A staged excluded path is explicit and blocks a commit; only whole-file
    // unstage is offered and never returns its content to either browser.
    await worker('secret', runId); await ui.getByRole('button', { name: '读取 Git 差异', exact: true }).click();
    await ui.getByText('存在被排除的暂存内容，请先取消其暂存后重新检查。', { exact: true }).waitFor();
    assert.equal(await ui.getByRole('button', { name: '暂存文件 .env', exact: true }).isDisabled(), true);
    await ui.getByRole('checkbox', { name: '取消暂存整文件 .env', exact: true }).check(); await ui.getByRole('checkbox', { name: '确认本次暂存选择', exact: true }).check();
    await Promise.all([member.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST'), ui.getByRole('button', { name: '应用暂存选择', exact: true }).click()]); const unstage = (await jobs()).at(-1).id;
    assert.equal((await worker('process', unstage)).status, 'applied'); await ui.getByRole('article', { name: `Git 操作 ${unstage}`, exact: true }).getByRole('status').filter({ hasText: '操作已应用' }).waitFor();
    await ui.getByRole('button', { name: '读取 Git 差异', exact: true }).click(); await ui.getByRole('checkbox', { name: '暂存整文件 code.txt', exact: true }).check();
    await ui.getByRole('checkbox', { name: '确认本次暂存选择', exact: true }).check(); await worker('edit', runId);
    await Promise.all([member.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST'), ui.getByRole('button', { name: '应用暂存选择', exact: true }).click()]); const stale = (await jobs()).at(-1).id;
    assert.equal((await worker('process', stale)).status, 'aborted'); await ui.getByRole('article', { name: `Git 操作 ${stale}`, exact: true }).getByText('代码版本或片段已经变化，请重新读取差异。', { exact: true }).waitFor();

    // Current permission checks apply to already-open views and direct requests.
    await admin.query("UPDATE collab.project_memberships SET role='reviewer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    await ui.getByRole('button', { name: '刷新 Git 记录', exact: true }).click();
    await ui.getByRole('button', { name: '读取 Git 差异', exact: true }).click();
    await ui.getByRole('button', { name: '提交已暂存内容', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await memberContext.request.post(endpoint, { headers, data: { ...body, idempotencyKey: randomUUID() } })).status(), 403);
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    assert.equal((await memberContext.request.get(`${endpoint}/preview`)).status(), 404);
    await admin.query("UPDATE collab.project_memberships SET active=true,role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    await open(member); await ui.getByRole('article', { name: `Git 操作 ${commit}`, exact: true }).getByRole('status').filter({ hasText: '操作已应用' }).waitFor();
    await ui.screenshot({ path: 'test-results/collab/workspace-git-history.png' });
    console.log('PASS: two-browser native Git hunk/whole-file selection, excluded/binary visibility, complete staged confirmation, refresh-safe lost-response retry, contention, stale revisions, actual committed effect with SQL loss and recovery, role revocation and desktop/mobile layouts.');
  } finally { await admin.query("UPDATE collab.project_memberships SET active=true,role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]); await owner.goto(original).catch(() => {}); await admin.end(); }
}
