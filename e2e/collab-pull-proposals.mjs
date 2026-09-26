import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { verifyPullDeliveryUi } from './collab-pull-delivery.mjs';

export async function verifyPullProposalsUi({ base, projectId, ownerContext, memberContext, owner, member, ui, peer, deliveryId, worker, admin, open }) {
  const headers = { Origin: base }, route = `${base}/api/collab/push-deliveries/${deliveryId}/pull-proposals`;
  const pane = card => card.locator('details[aria-label="草稿 PR 提案"]');
  const me = (await (await memberContext.request.get(`${base}/api/collab/me`)).json()).user.id;
  const context = await (await memberContext.request.get(route)).json(); assert.equal(context.canRequest, true);
  const input = { idempotencyKey: randomUUID(), expectedTaskVersion: context.taskVersion, title: '固定版本 PR 🌱', body: '目标：保存已推送代码的完整说明。\n<img src=x onerror="window.__pullInjected=true">\n验证与风险：等待独立评审。' };
  assert.equal((await ownerContext.request.post(route, { headers: { Origin: 'https://untrusted.invalid' }, data: input })).status(), 403);
  assert.equal((await memberContext.request.post(route, { headers, data: { ...input, headSha: 'f'.repeat(40) } })).status(), 400);
  for (const card of [ui, peer]) await pane(card).getByText('准备草稿 PR 提案', { exact: true }).click();
  let lost = true, observeCommitted, rejectCommitted;
  const committed = new Promise((resolve, reject) => { observeCommitted = resolve; rejectCommitted = reject; });
  void committed.catch(() => {});
  await member.route(`**/push-deliveries/${deliveryId}/pull-proposals`, async routed => {
    if (lost && routed.request().method() === 'POST') {
      lost = false;
      try { assert.equal((await routed.fetch()).status(), 202); await routed.abort('failed'); observeCommitted(); }
      catch (error) { rejectCommitted(error); throw error; }
    }
    else await routed.continue();
  });
  await pane(ui).getByLabel('PR 提案标题', { exact: true }).fill(input.title); await pane(ui).getByLabel('PR 提案说明', { exact: true }).fill(input.body);
  await pane(ui).getByRole('button', { name: '读取目标并保存 PR 提案', exact: true }).click();
  await pane(ui).getByRole('button', { name: '重试同一 PR 提案操作', exact: true }).waitFor();
  await committed;
  const jobs = (await admin.query('SELECT id FROM collab_git.pull_proposals WHERE delivery_id=$1', [deliveryId])).rows; assert.equal(jobs.length, 1); const id = jobs[0].id;
  await open(member); await pane(ui).getByText('准备草稿 PR 提案', { exact: true }).click();
  await pane(ui).getByRole('button', { name: '重试同一 PR 提案操作', exact: true }).click();
  await pane(ui).getByRole('button', { name: '重试同一 PR 提案操作', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM collab_git.pull_proposals WHERE delivery_id=$1', [deliveryId])).rows[0].n, 1);
  const ready = await worker('pull-proposal', id); assert.equal(ready.status, 'ready'); assert.equal(ready.readTokens, 1); assert.equal(ready.createRequests, 0);
  assert.equal(ready.attempt.requestHash, createHash('sha256').update(ready.requestText).digest('hex'));
  assert.equal(ready.observationHash, createHash('sha256').update(ready.observationText).digest('hex'));
  for (const card of [ui, peer]) {
    await pane(card).getByRole('button', { name: '刷新 PR 提案', exact: true }).click();
    const item = pane(card).locator(`[data-pull-proposal="${id}"]`);
    await item.getByRole('status').filter({ hasText: '已保存只读 PR 提案' }).waitFor();
    await item.getByText('完整生成的 PR 标题与说明', { exact: true }).click();
    assert.equal(await item.locator('pre').first().textContent(), ready.attempt.request.body);
  }
  assert.equal(await owner.evaluate(() => window.__pullInjected), undefined); assert.equal(await member.evaluate(() => window.__pullInjected), undefined);
  await pane(peer).screenshot({ path: 'test-results/collab/pull-proposal-desktop.png' });
  await owner.setViewportSize({ width: 390, height: 844 }); await pane(peer).screenshot({ path: 'test-results/collab/pull-proposal-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await owner.setViewportSize({ width: 1440, height: 1000 });
  try {
    await admin.query("UPDATE collab.project_memberships SET role='reviewer' WHERE project_id=$1 AND user_id=$2", [projectId, me]);
    assert.equal((await memberContext.request.post(route, { headers, data: input })).status(), 403);
    const read = await memberContext.request.get(route); assert.equal(read.status(), 200); assert.equal((await read.json()).proposals[0].valid, false);
    await pane(ui).getByRole('button', { name: '刷新 PR 提案', exact: true }).click();
    await pane(ui).getByLabel('PR 提案标题', { exact: true }).waitFor({ state: 'hidden' });
    await pane(ui).getByText('原提案权限或关联已失效，请重新准备。', { exact: true }).waitFor();
  } finally { await admin.query("UPDATE collab.project_memberships SET role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, me]); }
  // Regrant invalidates the old project event stream. Start a current view
  // before issuing another request, instead of racing its revocation callback.
  await open(member); await pane(ui).getByText('准备草稿 PR 提案', { exact: true }).click();
  for (const existing of [false, true]) {
    await pane(ui).getByLabel('PR 提案标题', { exact: true }).fill(existing ? '查看既有 PR' : '取消只读准备');
    await pane(ui).getByLabel('PR 提案说明', { exact: true }).fill('此请求只准备提案，不发送外部通知。');
    await pane(ui).getByRole('button', { name: '读取目标并保存 PR 提案', exact: true }).click();
    await pane(ui).getByRole('button', { name: '读取目标并保存 PR 提案', exact: true }).waitFor();
    await pane(ui).getByRole('status').filter({ hasText: '等待读取 PR 目标' }).waitFor();
    const latest = (await admin.query("SELECT id FROM collab_git.pull_proposals WHERE delivery_id=$1 AND status='queued'", [deliveryId])).rows[0]; assert.ok(latest);
    if (!existing) {
      await pane(peer).getByRole('button', { name: '刷新 PR 提案', exact: true }).click();
      await pane(peer).getByLabel('PR 提案取消原因', { exact: true }).fill('当前不需要准备草稿，明确取消这次读取。');
      await pane(peer).getByRole('button', { name: '取消 PR 提案准备', exact: true }).click();
      await pane(peer).getByText('已请求停止此提案的只读准备。', { exact: true }).waitFor();
    }
    const result = await worker(existing ? 'pull-existing' : 'pull-proposal', latest.id);
    assert.equal(result.status, existing ? 'existing' : 'cancelled'); assert.equal(result.createRequests, 0); assert.equal(result.readTokens, existing ? 1 : 0);
    await pane(ui).getByRole('button', { name: '刷新 PR 提案', exact: true }).click();
    await pane(ui).getByRole('status').filter({ hasText: existing ? '发现已有 PR，仅供查看' : 'PR 提案已取消' }).waitFor();
    if (existing) assert.equal(await pane(ui).getByRole('link', { name: '查看已有 PR #16', exact: true }).getAttribute('href'), 'https://github.com/example-org/example-repo/pull/16');
  }
  await member.unroute(`**/push-deliveries/${deliveryId}/pull-proposals`);
  console.log('PASS: durable read-only PR proposals after real Git acknowledgement; browser reload and exact retry, two-member generated content, raw evidence hashes, literal text, cancellation, existing-PR observation, role revocation and desktop/mobile layout. Preparation created no PR; explicit creation acceptance follows.');
  await verifyPullDeliveryUi({ base, projectId, ownerContext, memberContext, owner, member, ui, peer, deliveryId, worker, admin, open });
}
