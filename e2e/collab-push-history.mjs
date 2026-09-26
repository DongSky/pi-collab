import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { verifyPullProposalsUi } from './collab-pull-proposals.mjs';
const exec = promisify(execFile);

export async function verifyTaskPushPreviewsUi({ base, config, projectId, ownerContext, memberContext, owner, member }) {
  const dbName = process.env.PI_COLLAB_E2E_DATABASE;
  if (!/^pi_collab_test_[a-f0-9]+$/.test(dbName ?? '')) throw new Error('Isolated database required');
  const admin = new Pool({ connectionString: `postgresql://pi_collab_admin:${encodeURIComponent(config.adminPassword)}@127.0.0.1:${config.databasePort}/${dbName}` });
  const worker = async (mode, id) => JSON.parse((await exec(process.execPath, ['--import', 'tsx', 'scripts/e2e-push-history-worker.ts', mode, id], { timeout: 60000 })).stdout.trim());
  const headers = { Origin: base }, title = '完整出站历史审阅验收', original = owner.url();
  const memberId = (await (await memberContext.request.get(`${base}/api/collab/me`)).json()).user.id;
  const open = async page => { await page.goto(base); await page.getByRole('button').filter({ hasText: title }).click(); };
  const region = page => page.getByRole('region', { name: '任务推送预览', exact: true });
  try {
    const repo = await worker('init', projectId);
    const taskResponse = await memberContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`, { headers, data: { title, description: '全部出站版本与原始字节核验', acceptance: '历史固定、权限隔离、请求不重放' } }); assert.equal(taskResponse.status(), 200); const task = await taskResponse.json();
    assert.equal((await memberContext.request.post(`${base}/api/collab/tasks/${task.id}/runs`, { headers, data: { repositoryId: repo.id, baseSha: repo.baseSha, prompt: 'Native Pi diagnostic without model inference', expectedVersion: task.version, idempotencyKey: randomUUID() } })).status(), 202);
    const run = await worker('run', task.id), endpoint = `${base}/api/collab/runs/${run.runId}/push-previews`;
    const source = await (await memberContext.request.get(`${base}/api/collab/runs/${run.runId}/git/preview`)).json();
    const body = { idempotencyKey: randomUUID(), revision: source.revision, head: source.head, expectedRunRevision: source.runRevision };
    assert.equal((await memberContext.request.post(endpoint, { headers: { Origin: 'https://untrusted.invalid' }, data: body })).status(), 403);
    assert.equal((await memberContext.request.post(endpoint, { headers, data: { ...body, repositoryId: repo.id } })).status(), 400);
    for (const page of [owner, member]) await open(page);
    const ui = region(member), peer = region(owner); let lost = true;
    await member.route(`**/api/collab/runs/${run.runId}/push-previews`, async route => {
      if (route.request().method() === 'POST' && lost) { lost = false; assert.equal((await route.fetch()).status(), 202); await route.abort('failed'); } else await route.continue();
    });
    await ui.getByRole('button', { name: '生成推送预览', exact: true }).click();
    await ui.getByRole('button', { name: '重试同一预览请求', exact: true }).waitFor();
    await member.reload(); await member.getByRole('button').filter({ hasText: title }).click();
    await ui.getByRole('button', { name: '重试同一预览请求', exact: true }).click();
    await ui.getByRole('button', { name: '重试同一预览请求', exact: true }).waitFor({ state: 'hidden' });
    const jobs = async () => (await admin.query('SELECT id,status FROM collab_git.push_previews WHERE run_id=$1 ORDER BY created_at,id', [run.runId])).rows;
    assert.equal((await jobs()).length, 1); const id = (await jobs())[0].id;
    const card = ui.getByRole('article', { name: `推送预览 ${id}`, exact: true }), peerCard = peer.getByRole('article', { name: `推送预览 ${id}`, exact: true });
    await peerCard.getByRole('status').filter({ hasText: '等待生成预览' }).waitFor();
    assert.equal((await ownerContext.request.post(endpoint, { headers, data: body })).status(), 409);
    const prepared = await worker('process', id); assert.equal(prepared.status, 'ready'); assert.equal(prepared.commitCount, 2); assert.equal(prepared.readTokens, 1); assert.equal(prepared.receiveRequests, 0);
    const direct = await memberContext.request.get(`${base}/api/collab/push-previews/${id}/history?${new URLSearchParams({ kind: 'commits', manifestHash: prepared.manifestHash })}`);
    const directBody = await direct.json(); assert.equal(direct.status(), 200, `History API: ${directBody.error ?? 'success'}`); assert.equal(directBody.total, 2);
    await card.getByRole('status').filter({ hasText: '出站历史已固定' }).waitFor();
    for (const c of [card, peerCard]) await c.getByRole('button', { name: '审阅全部出站历史', exact: true }).click();
    const history = ui.getByRole('article', { name: '完整出站历史', exact: true });
    await history.getByRole('heading', { name: '新增提交：已加载 2 / 2', exact: true }).waitFor();
    await peer.getByRole('article', { name: '完整出站历史', exact: true }).getByText(new RegExp(prepared.manifestHash)).waitFor();
    const query = args => new URLSearchParams({ manifestHash: prepared.manifestHash, ...args });
    const api = `${base}/api/collab/push-previews/${id}`;
    assert.equal((await fetch(`${api}/history?${query({ kind: 'commits' })}`)).status, 401);
    const response = await memberContext.request.get(`${api}/history?${query({ kind: 'commits' })}`); assert.equal(response.status(), 200); assert.equal(response.headers()['cache-control'], 'no-store');
    const metadata = await response.json(); assert.equal(metadata.total, 2); assert.equal(metadata.identity.head, run.head);
    assert.equal(JSON.stringify(metadata).includes('PRIVATE KEY'), false); assert.equal(JSON.stringify(metadata).includes(process.env.PI_COLLAB_E2E_DATA), false);
    assert.equal((await memberContext.request.get(`${api}/history?${query({ kind: 'changes', commit: repo.baseSha })}`)).status(), 404);
    assert.equal((await memberContext.request.get(`${api}/history?${query({ kind: 'file', commit: run.head, path: '../manifest.json' })}`)).status(), 400);
    assert.equal((await memberContext.request.get(`${api}/history?${query({ kind: 'commits', manifestHash: '0'.repeat(64) })}`)).status(), 409);
    assert.equal((await memberContext.request.get(`${api}/download?${query({ kind: 'file', commit: run.head, path: '.env', side: 'before' })}`)).status(), 404);
    let readerBusy = true;
    await member.route(`**/api/collab/push-previews/${id}/history?**`, async route => {
      if (readerBusy && new URL(route.request().url()).searchParams.get('kind') === 'file') {
        readerBusy = false; await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'code_reader_busy', message: '读取通道暂忙，请稍后重试。' }) });
      } else await route.continue();
    });
    await history.getByRole('article', { name: `出站提交 ${run.intermediate}`, exact: true }).getByRole('button', { name: '查看本提交全部变更', exact: true }).click();
    await history.getByRole('button', { name: 'temporary.txt · 新增', exact: true }).click();
    const file = history.getByRole('article', { name: '出站文件内容', exact: true });
    await file.locator('.collab-git-line.added').filter({ hasText: 'intermediate historical content' }).waitFor();
    assert.equal(readerBusy, false);
    await file.getByRole('checkbox', { name: '本窗口已核对此文件版本', exact: true }).check();
    await history.getByRole('article', { name: `出站提交 ${run.head}`, exact: true }).getByRole('button', { name: '查看本提交全部变更', exact: true }).click();
    await history.getByRole('heading', { name: new RegExp(`^提交 ${run.head.slice(0, 12)} · 已加载`) }).waitFor();
    assert.equal(await history.getByRole('button', { name: 'temporary.txt · 新增', exact: true }).count(), 0);
    await history.getByRole('button', { name: 'binary.bin · 新增', exact: true }).click();
    const downloadEvent = member.waitForEvent('download'); await file.getByRole('button', { name: '下载此版本字节', exact: true }).click();
    const download = await downloadEvent, bytes = await readFile(await download.path()); assert.deepEqual(bytes, Buffer.from([0, 1, 255]));
    assert.match(await file.textContent(), new RegExp(createHash('sha256').update(bytes).digest('hex')));
    await history.getByRole('button', { name: 'code.txt · 修改', exact: true }).click();
    await file.getByText(/模式 100755/).waitFor(); await file.locator('.collab-git-line.added').filter({ hasText: 'final committed code' }).waitFor();
    await history.screenshot({ path: 'test-results/collab/push-history-desktop.png' });
    await member.setViewportSize({ width: 390, height: 844 }); await history.screenshot({ path: 'test-results/collab/push-history-mobile.png' });
    assert.ok(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await member.setViewportSize({ width: 1440, height: 1000 });
    const confirmation = history.getByRole('region', { name: '持久推送确认', exact: true });
    const confirmationsUrl = `${api}/confirmations`, confirmationContext = await (await memberContext.request.get(confirmationsUrl)).json();
    const confirmInput = { ...confirmationContext.scope, idempotencyKey: randomUUID(), acknowledgeHistory: true, acknowledgeDestination: true, acknowledgeDisclosure: true };
    assert.equal((await memberContext.request.post(confirmationsUrl, { headers: { Origin: 'https://untrusted.invalid' }, data: confirmInput })).status(), 403);
    assert.equal((await memberContext.request.post(confirmationsUrl, { headers, data: { ...confirmInput, commits: confirmInput.commits.slice(0, 1) } })).status(), 400);
    assert.equal(await confirmation.getByRole('button', { name: '保存确认并占用目标', exact: true }).isDisabled(), true);
    for (const commit of metadata.commits) {
      const commitCard = history.getByRole('article', { name: `出站提交 ${commit.oid}`, exact: true });
      await commitCard.locator('summary').click();
      await commitCard.getByRole('button', { name: '查看本提交全部变更', exact: true }).click();
      await history.getByRole('heading', { name: new RegExp(`^提交 ${commit.oid.slice(0, 12)} · 已加载`) }).waitFor();
      const changesResponse = await memberContext.request.get(`${api}/history?${query({ kind: 'changes', commit: commit.oid })}`); assert.equal(changesResponse.status(), 200);
      const changes = await changesResponse.json();
      for (const item of changes.files) {
        await history.getByRole('button', { name: `${item.path} · ${item.kind === 'added' ? '新增' : item.kind === 'deleted' ? '删除' : '修改'}`, exact: true }).click();
        await file.getByRole('heading', { name: item.path, exact: true }).waitFor();
        const outside = file.getByRole('checkbox', { name: '确认外部核对或排除范围', exact: true }); if (await outside.count()) await outside.check();
        await file.getByRole('checkbox', { name: '本窗口已核对此文件版本', exact: true }).check();
      }
      await commitCard.getByRole('checkbox', { name: `确认提交 ${commit.oid}`, exact: true }).check();
    }
    await confirmation.getByRole('checkbox', { name: '确认上述仓库、可见性、任务分支及旧/新提交', exact: true }).check();
    await confirmation.getByRole('checkbox', { name: '确认披露完整新增历史（包括中间版本），已核对原始字节和排除限制；不包含后续草稿', exact: true }).check();
    await confirmation.screenshot({ path: 'test-results/collab/push-confirmation-desktop.png' });
    await member.setViewportSize({ width: 390, height: 844 }); await confirmation.screenshot({ path: 'test-results/collab/push-confirmation-mobile.png' });
    assert.ok(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await member.setViewportSize({ width: 1440, height: 1000 });
    let loseConfirmation = true;
    await member.route(`**/api/collab/push-previews/${id}/confirmations`, async route => {
      if (route.request().method() === 'POST' && loseConfirmation) { loseConfirmation = false; assert.equal((await route.fetch()).status(), 200); await route.abort('failed'); } else await route.continue();
    });
    await confirmation.getByRole('button', { name: '保存确认并占用目标', exact: true }).click();
    await confirmation.getByRole('button', { name: '重试同一推送确认操作', exact: true }).waitFor();
    await member.reload(); await member.getByRole('button').filter({ hasText: title }).click();
    await card.getByRole('button', { name: '审阅全部出站历史', exact: true }).click(); await history.getByText(/本窗口已标记 0 个文件版本/).waitFor();
    await confirmation.getByRole('button', { name: '重试同一推送确认操作', exact: true }).click();
    await confirmation.getByRole('button', { name: '重试同一推送确认操作', exact: true }).waitFor({ state: 'hidden' });
    const confirmed = await (await memberContext.request.get(confirmationsUrl)).json(); assert.equal(confirmed.confirmations.length, 1); assert.equal(confirmed.occupied, true);
    const confirmationId = confirmed.confirmations[0].id;
    const peerConfirmation = peer.getByRole('region', { name: '持久推送确认', exact: true });
    await peerConfirmation.getByRole('status').filter({ hasText: '确认已保存，目标已占用' }).waitFor();
    assert.equal((await ownerContext.request.post(confirmationsUrl, { headers, data: confirmInput })).status(), 409);
    assert.equal((await fetch(confirmationsUrl)).status, 401);
    const withdrawalUrl = `${base}/api/collab/push-confirmations/${confirmationId}/withdraw`;
    assert.equal((await ownerContext.request.post(withdrawalUrl, { headers: { Origin: 'https://untrusted.invalid' }, data: { idempotencyKey: randomUUID(), reason: 'Do not accept a cross-origin withdrawal request' } })).status(), 403);
    // Revoking then restoring membership preserves the old confirmation's stale
    // authorization version and its destination until explicit withdrawal.
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    await peerConfirmation.getByRole('status').filter({ hasText: '确认已失效，目标仍占用' }).waitFor();
    assert.equal((await memberContext.request.get(confirmationsUrl)).status(), 404);
    await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    assert.equal((await (await memberContext.request.get(confirmationsUrl)).json()).confirmations[0].valid, false);
    let loseWithdrawal = true;
    await owner.route(`**/api/collab/push-confirmations/${confirmationId}/withdraw`, async route => {
      if (loseWithdrawal) { loseWithdrawal = false; assert.equal((await route.fetch()).status(), 200); await route.abort('failed'); } else await route.continue();
    });
    await peerConfirmation.getByLabel('推送确认撤回原因', { exact: true }).fill('撤回尚未发送的完整确认，由维护者释放任务分支。');
    await peerConfirmation.getByRole('button', { name: '撤回确认并释放目标', exact: true }).click();
    await peerConfirmation.getByRole('button', { name: '重试同一推送确认操作', exact: true }).click();
    await peerConfirmation.getByRole('status').filter({ hasText: '确认已撤回' }).waitFor();
    assert.equal((await (await ownerContext.request.get(confirmationsUrl)).json()).occupied, false);
    await member.reload(); await member.getByRole('button').filter({ hasText: title }).click(); await card.getByRole('button', { name: '审阅全部出站历史', exact: true }).click();
    await confirmation.getByRole('status').filter({ hasText: '确认已撤回' }).waitFor();
    // New read-only requests require a deliberate new ID; cancellation does not
    // download, request a read token or make any remote write.
    await ui.getByRole('button', { name: '生成推送预览', exact: true }).click();
    await ui.getByRole('button', { name: '取消生成预览', exact: true }).waitFor();
    const second = (await jobs()).at(-1).id; assert.notEqual(second, id);
    const next = ui.getByRole('article', { name: `推送预览 ${second}`, exact: true }); await next.getByLabel('推送预览取消原因', { exact: true }).fill('明确取消排队预览，保留此前原始历史证据。');
    assert.equal((await memberContext.request.post(`${base}/api/collab/push-previews/${second}/cancel`, { headers: { Origin: 'https://untrusted.invalid' }, data: { reason: 'Do not accept this cross-origin cancellation', idempotencyKey: randomUUID() } })).status(), 403);
    await Promise.all([member.waitForResponse(r => r.url().endsWith(`/${second}/cancel`) && r.request().method() === 'POST'), next.getByRole('button', { name: '取消生成预览', exact: true }).click()]);
    const cancelled = await worker('process', second); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.readTokens, 0);
    await admin.query("UPDATE collab.project_memberships SET role='reviewer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    await ui.getByRole('button', { name: '刷新推送预览', exact: true }).click(); await ui.getByRole('button', { name: '生成推送预览', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await memberContext.request.post(endpoint, { headers, data: { ...body, idempotencyKey: randomUUID() } })).status(), 403);
    assert.equal((await memberContext.request.get(`${api}/history?${query({ kind: 'commits' })}`)).status(), 200);
    await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    assert.equal((await memberContext.request.get(`${api}/history?${query({ kind: 'commits' })}`)).status(), 404);
    assert.equal((await memberContext.request.get(`${api}/download?${query({ kind: 'commit', commit: run.head })}`)).status(), 404);
    await history.waitFor({ state: 'hidden' });
    await worker('corrupt', id); assert.equal((await ownerContext.request.get(`${api}/history?${query({ kind: 'commits' })}`)).status(), 409);
    await owner.reload(); await owner.getByRole('button').filter({ hasText: title }).click(); await peerCard.getByRole('button', { name: '审阅全部出站历史', exact: true }).click();
    await peer.getByRole('alert').filter({ hasText: '固定出站历史读取失败' }).waitFor();
    await peerConfirmation.getByRole('status').filter({ hasText: '确认已撤回' }).waitFor();
    await admin.query("UPDATE collab.project_memberships SET active=true,role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
    await verifyPushDeliveryUi({ base, projectId, ownerContext, memberContext, owner, member, repo, worker, admin });
    console.log('PASS: two-browser immutable history and full confirmation; explicit durable delivery/retry/reload/cancel, actual loopback Git receive, unknown-result permanent quarantine and role boundaries, corruption/CSRF/stale authority, desktop/mobile. No external account or model inference.');
  } catch (error) { await region(member).screenshot({ path: 'test-results/collab/push-history-failure.png', timeout: 5000 }).catch(() => {}); throw error; }
  finally { await admin.query("UPDATE collab.project_memberships SET active=true,role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]); await owner.goto(original); await admin.end(); }
}

async function verifyPushDeliveryUi({ base, projectId, ownerContext, memberContext, owner, member, repo, worker, admin }) {
  const headers = { Origin: base };
  for (const mode of ['cancel', 'send', 'send-unknown']) {
    const title = `固定导出发送验收 ${mode}`;
    const taskResponse = await memberContext.request.post(`${base}/api/collab/projects/${projectId}/tasks`, { headers, data: { title, description: '原生固定导出与未知结果处理', acceptance: '单次发送，未知分支永久隔离' } }); assert.equal(taskResponse.status(), 200); const task = await taskResponse.json();
    assert.equal((await memberContext.request.post(`${base}/api/collab/tasks/${task.id}/runs`, { headers, data: { repositoryId: repo.id, baseSha: repo.baseSha, prompt: 'Native tool fixture, no inference', expectedVersion: task.version, idempotencyKey: randomUUID() } })).status(), 202);
    const run = await worker('run', task.id), source = await (await memberContext.request.get(`${base}/api/collab/runs/${run.runId}/git/preview`)).json();
    const requested = await memberContext.request.post(`${base}/api/collab/runs/${run.runId}/push-previews`, { headers, data: { idempotencyKey: randomUUID(), revision: source.revision, head: source.head, expectedRunRevision: source.runRevision } });
    assert.equal(requested.status(), 202); const previewId = (await requested.json()).jobId; assert.equal((await worker('process', previewId)).status, 'ready');
    const contextUrl = `${base}/api/collab/push-previews/${previewId}/confirmations`;
    const scope = (await (await memberContext.request.get(contextUrl)).json()).scope;
    const confirmed = await memberContext.request.post(contextUrl, { headers, data: { ...scope, idempotencyKey: randomUUID(), acknowledgeHistory: true, acknowledgeDestination: true, acknowledgeDisclosure: true } });
    assert.equal(confirmed.status(), 200); const confirmationId = (await confirmed.json()).id;
    const open = async page => { await page.goto(base); await page.getByRole('button').filter({ hasText: title }).click(); await page.getByRole('article', { name: `推送预览 ${previewId}`, exact: true }).getByRole('button', { name: '审阅全部出站历史', exact: true }).click(); };
    for (const page of [owner, member]) await open(page);
    const card = page => page.getByRole('article', { name: `推送确认 ${confirmationId}`, exact: true }), ui = card(member), peer = card(owner);
    const sendUrl = `${base}/api/collab/push-confirmations/${confirmationId}/send`, input = { idempotencyKey: randomUUID(), manifestHash: scope.manifestHash, acknowledgePush: true };
    assert.equal((await memberContext.request.post(sendUrl, { headers: { Origin: 'https://untrusted.invalid' }, data: input })).status(), 403);
    assert.equal((await memberContext.request.post(sendUrl, { headers, data: { ...input, acknowledgePush: false } })).status(), 400);
    assert.equal(await ui.getByRole('button', { name: '发送到已确认的任务分支', exact: true }).isDisabled(), true);
    let lost = mode === 'cancel';
    await member.route(`**/api/collab/push-confirmations/${confirmationId}/send`, async route => {
      if (lost) { lost = false; assert.equal((await route.fetch()).status(), 202); await route.abort('failed'); } else await route.continue();
    });
    await ui.getByRole('checkbox', { name: '明确发送此已确认的固定导出', exact: true }).check();
    await ui.getByRole('button', { name: '发送到已确认的任务分支', exact: true }).click();
    if (mode === 'cancel') {
      await ui.getByRole('button', { name: '重试同一发送操作', exact: true }).waitFor(); await open(member);
      await ui.getByRole('button', { name: '重试同一发送操作', exact: true }).click(); await ui.getByRole('button', { name: '重试同一发送操作', exact: true }).waitFor({ state: 'hidden' });
    }
    await peer.getByRole('status').filter({ hasText: '等待发送' }).waitFor();
    const jobs = (await admin.query('SELECT id FROM collab_git.push_deliveries WHERE confirmation_id=$1', [confirmationId])).rows; assert.equal(jobs.length, 1); const jobId = jobs[0].id;
    assert.equal((await ownerContext.request.post(sendUrl, { headers, data: input })).status(), 409);
    assert.equal((await memberContext.request.post(`${base}/api/collab/push-confirmations/${confirmationId}/withdraw`, { headers, data: { idempotencyKey: randomUUID(), reason: 'Never release a delivery-owned reservation' } })).status(), 409);
    if (mode === 'cancel') {
      await peer.getByLabel('发送任务处理原因', { exact: true }).fill('明确停止原发送任务，避免原导出被发送。');
      await peer.getByRole('button', { name: '请求停止发送', exact: true }).click(); await peer.getByText('已记录停止请求。发送授权记录后，停止不能保证撤销远端效果。', { exact: true }).waitFor();
    }
    const result = await worker(mode === 'cancel' ? 'send' : mode, previewId); assert.equal(result.status, mode === 'cancel' ? 'not_sent' : mode === 'send' ? 'acknowledged' : 'unknown');
    assert.equal(result.receiveRequests, mode === 'cancel' ? 0 : 1); assert.equal(result.writeTokens, mode === 'cancel' ? 0 : 1);
    const label = mode === 'cancel' ? '确认未发送' : mode === 'send' ? '远端已确认接收' : '发送结果未知，目标保持占用';
    for (const c of [ui, peer]) await c.getByRole('status').filter({ hasText: label }).waitFor();
    if (mode === 'send') await verifyPullProposalsUi({ base, projectId, ownerContext, memberContext, owner, member, ui, peer, deliveryId: jobId, worker, admin, open });
    const actionsUrl = `${base}/api/collab/push-deliveries/${jobId}/actions`;
    assert.equal((await memberContext.request.post(sendUrl, { headers, data: { ...input, idempotencyKey: randomUUID() } })).status(), 409);
    if (mode === 'send-unknown') {
      const retire = { idempotencyKey: randomUUID(), action: 'retire', reason: 'Permanently quarantine this old destination while its remote effect is still unknown', acknowledgeUnknown: true };
      assert.equal((await memberContext.request.post(actionsUrl, { headers, data: retire })).status(), 403);
      assert.equal((await ownerContext.request.post(actionsUrl, { headers: { Origin: 'https://untrusted.invalid' }, data: retire })).status(), 403);
      assert.equal((await ownerContext.request.post(actionsUrl, { headers, data: { ...retire, acknowledgeUnknown: false } })).status(), 400);
      assert.equal(await ui.getByRole('button', { name: '封存未知任务并永久隔离旧目标', exact: true }).count(), 0);
      await peer.getByLabel('发送任务处理原因', { exact: true }).fill('接受远端仍可能迟到生效，将旧目标永久隔离，后续使用新工作区。');
      await peer.getByRole('checkbox', { name: '确认远端结果仍未知，永久隔离旧分支，并从新工作区继续', exact: true }).check();
      await peer.screenshot({ path: 'test-results/collab/push-delivery-unknown-desktop.png' });
      await owner.setViewportSize({ width: 390, height: 844 }); await peer.screenshot({ path: 'test-results/collab/push-delivery-unknown-mobile.png' });
      assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await owner.setViewportSize({ width: 1440, height: 1000 });
      await peer.getByRole('button', { name: '封存未知任务并永久隔离旧目标', exact: true }).click();
      for (const c of [ui, peer]) await c.getByRole('status').filter({ hasText: '未知任务已封存，旧目标永久隔离' }).waitFor();
      const context = await (await ownerContext.request.get(contextUrl)).json(); assert.equal(context.occupied, true); assert.equal(context.confirmations[0].status, 'quarantined');
    }
  }
}
