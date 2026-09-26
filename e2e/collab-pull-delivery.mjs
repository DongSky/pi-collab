import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { verifyPullObservations } from './collab-pull-observations.mjs';

export async function verifyPullDeliveryUi({ base, projectId, ownerContext, memberContext, owner, member, ui, peer, deliveryId, worker, admin, open }) {
  const headers = { Origin: base }, route = base + '/api/collab/push-deliveries/' + deliveryId + '/pull-proposals';
  const proposals = card => card.locator('details[aria-label="草稿 PR 提案"]');
  const card = (root, id) => proposals(root).locator('[data-pull-proposal="' + id + '"]');
  const pane = (root, id) => card(root, id).locator('details[aria-label="创建草稿 PR"]');
  const memberId = (await (await memberContext.request.get(base + '/api/collab/me')).json()).user.id;
  const make = async title => {
    const version = (await (await memberContext.request.get(route)).json()).taskVersion;
    const response = await memberContext.request.post(route, { headers, data: { idempotencyKey: randomUUID(), expectedTaskVersion: version, title, body: '核对完整代码后创建草稿。\n<em>这段文本应保持字面显示</em>\n仍需要 CI 和独立评审。' } });
    assert.equal(response.status(), 202); const id = (await response.json()).jobId;
    const ready = await worker('pull-proposal', id); assert.equal(ready.status, 'ready');
    for (const root of [ui, peer]) {
      await proposals(root).getByRole('button', { name: '刷新 PR 提案', exact: true }).click();
      await pane(root, id).locator('summary').first().click();
      await pane(root, id).getByRole('button', { name: '刷新 PR 创建状态', exact: true }).waitFor();
    }
    return { id, ready, endpoint: base + '/api/collab/pull-proposals/' + id + '/create', input: { idempotencyKey: randomUUID(), requestHash: ready.attempt.requestHash,
      observationHash: ready.observationHash, acknowledgeContent: true, acknowledgeNotification: true, acknowledgeVersions: true } };
  };
  const confirm = async (id, capture = false) => {
    const region = pane(ui, id), submit = region.getByRole('button', { name: '确认发送并创建草稿 PR', exact: true });
    await submit.waitFor(); assert.equal(await submit.isDisabled(), true);
    await region.getByRole('checkbox', { name: '我已核对完整 PR 标题、说明及目标仓库', exact: true }).check();
    await region.getByRole('checkbox', { name: '明确创建草稿 PR，并允许 GitHub 通知仓库成员', exact: true }).check();
    assert.equal(await submit.isDisabled(), true);
    await region.getByRole('checkbox', { name: '了解创建期间分支可能变化，仍需后续检查与评审', exact: true }).check();
    assert.equal(await submit.isDisabled(), false);
    if (capture) {
      await region.screenshot({ path: 'test-results/collab/pull-creation-confirm-desktop.png' });
      await member.setViewportSize({ width: 390, height: 844 }); await region.screenshot({ path: 'test-results/collab/pull-creation-confirm-mobile.png' });
      assert.ok(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await member.setViewportSize({ width: 1440, height: 1000 });
    }
    await submit.click();
  };
  const refresh = async (id, text) => {
    for (const root of [ui, peer]) {
      await pane(root, id).getByRole('button', { name: '刷新 PR 创建状态', exact: true }).click();
      await pane(root, id).getByRole('status').filter({ hasText: text }).waitFor();
    }
  };
  const first = await make('浏览器明确创建 PR');
  assert.equal(await pane(ui, first.id).locator('pre').textContent(), first.ready.attempt.request.body);
  const read = await memberContext.request.get(first.endpoint); assert.equal(read.status(), 200); assert.equal(read.headers()['cache-control'], 'no-store');
  assert.equal((await memberContext.request.post(first.endpoint, { headers: { Origin: 'https://untrusted.invalid' }, data: first.input })).status(), 403);
  assert.equal((await memberContext.request.post(first.endpoint, { headers, data: { ...first.input, acknowledgeNotification: false } })).status(), 400);
  assert.equal((await memberContext.request.post(first.endpoint, { headers, data: { ...first.input, headSha: 'f'.repeat(40) } })).status(), 400);
  let lost = true, committedResolve, committedReject;
  const committed = new Promise((resolve, reject) => { committedResolve = resolve; committedReject = reject; }); void committed.catch(() => {});
  const intercept = '**/pull-proposals/' + first.id + '/create';
  await member.route(intercept, async request => {
    if (lost && request.request().method() === 'POST') {
      lost = false;
      try { assert.equal((await request.fetch()).status(), 202); await request.abort('failed'); committedResolve(); }
      catch (error) { committedReject(error); throw error; }
    } else await request.continue();
  });
  await confirm(first.id, true);
  await pane(ui, first.id).getByRole('button', { name: '重试同一 PR 创建操作', exact: true }).waitFor(); await committed;
  await open(member); await proposals(ui).locator('summary').first().click(); await pane(ui, first.id).locator('summary').first().click();
  await pane(ui, first.id).getByRole('button', { name: '重试同一 PR 创建操作', exact: true }).click();
  await pane(ui, first.id).getByRole('button', { name: '重试同一 PR 创建操作', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM collab_git.pull_deliveries WHERE id=$1', [first.id])).rows[0].n, 1);
  assert.equal((await ownerContext.request.post(first.endpoint, { headers, data: first.input })).status(), 409);
  const created = await worker('pull-create', first.id); assert.equal(created.status, 'created'); assert.equal(created.createRequests, 1); assert.equal(created.writeTokens, 1);
  assert.equal(created.changeRequest.observations.length, 2);
  for (const observation of created.changeRequest.observations) assert.equal(createHash('sha256').update(observation.evidenceText).digest('hex'), observation.evidenceHash);
  await refresh(first.id, '远端已确认创建草稿 PR');
  for (const root of [ui, peer]) assert.equal(await pane(root, first.id).getByRole('link', { name: '打开已创建 PR #17', exact: true }).getAttribute('href'), 'https://github.com/example-org/example-repo/pull/17');
  await pane(peer, first.id).getByText('创建与版本观察记录', { exact: true }).click();
  await pane(peer, first.id).screenshot({ path: 'test-results/collab/pull-creation-desktop.png' });
  await owner.setViewportSize({ width: 390, height: 844 }); await pane(peer, first.id).screenshot({ path: 'test-results/collab/pull-creation-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await owner.setViewportSize({ width: 1440, height: 1000 });
  await member.unroute(intercept);
  await verifyPullObservations({ base, changeId: first.id, projectId, memberId, ownerContext, memberContext, owner, member,
    root: pane(ui, first.id), peerRoot: pane(peer, first.id), worker, admin,
    reopen: async () => { await open(member); await proposals(ui).locator('summary').first().click(); await pane(ui, first.id).locator('summary').first().click(); } });

  // Subsequent fixture processes explicitly model external closure / a fresh
  // provider observation. They do not edit or adopt the first PR.
  for (const mode of ['cancel', 'existing', 'unknown']) {
    const next = await make('PR 创建状态 ' + mode); await confirm(next.id);
    await pane(ui, next.id).getByRole('status').filter({ hasText: '等待创建草稿 PR' }).waitFor();
    if (mode === 'cancel') {
      await pane(peer, next.id).getByRole('button', { name: '刷新 PR 创建状态', exact: true }).click();
      await pane(peer, next.id).getByLabel('PR 创建处理原因', { exact: true }).fill('明确取消此排队创建，不发送 GitHub 通知。');
      await pane(peer, next.id).getByRole('button', { name: '请求停止 PR 创建', exact: true }).click();
      await pane(peer, next.id).getByText('停止请求已记录；发送授权后不能保证撤销远端创建。', { exact: true }).waitFor();
    }
    const result = await worker(mode === 'cancel' ? 'pull-create' : 'pull-create-' + mode, next.id);
    assert.equal(result.status, mode === 'unknown' ? 'unknown' : 'not_created'); assert.equal(result.createRequests, mode === 'unknown' ? 1 : 0);
    assert.equal(result.writeTokens, mode === 'cancel' ? 0 : 1);
    await refresh(next.id, mode === 'unknown' ? 'PR 创建结果未知，分支保持占用' : '确认未创建 PR');
    if (mode === 'existing') await pane(ui, next.id).getByRole('link', { name: '查看已有 PR #16（未接管）', exact: true }).waitFor();
    if (mode === 'unknown') {
      const alternate = await make('被未知 PR 创建占用的另一提案');
      await pane(ui, alternate.id).getByText('此任务分支已有推送或 PR 创建占用，处理原操作后才能继续。', { exact: true }).waitFor();
      assert.equal((await memberContext.request.post(alternate.endpoint, { headers, data: alternate.input })).status(), 409);
      const actions = base + '/api/collab/pull-deliveries/' + next.id + '/actions';
      const retire = { idempotencyKey: randomUUID(), action: 'retire', reason: 'Permanently quarantine this branch because the old creation can still arrive', acknowledgeUnknown: true };
      assert.equal((await memberContext.request.post(actions, { headers, data: retire })).status(), 403);
      assert.equal((await ownerContext.request.post(actions, { headers: { Origin: 'https://untrusted.invalid' }, data: retire })).status(), 403);
      assert.equal(await pane(ui, next.id).getByRole('button', { name: '封存未知 PR 创建并隔离分支', exact: true }).count(), 0);
      await pane(peer, next.id).getByLabel('PR 创建处理原因', { exact: true }).fill('接受创建仍可能迟到生效，永久隔离此旧任务分支，使用新工作区继续。');
      await pane(peer, next.id).getByRole('checkbox', { name: '确认结果仍未知，永久隔离此 PR 任务分支', exact: true }).check();
      await pane(peer, next.id).screenshot({ path: 'test-results/collab/pull-creation-unknown.png' });
      await pane(peer, next.id).getByRole('button', { name: '封存未知 PR 创建并隔离分支', exact: true }).click();
      await refresh(next.id, '未知 PR 创建已封存，旧分支永久隔离');
      assert.equal((await (await memberContext.request.get(alternate.endpoint)).json()).occupied, true);
      await open(member); await proposals(ui).locator('summary').first().click(); await pane(ui, next.id).locator('summary').first().click();
      await pane(ui, next.id).getByRole('status').filter({ hasText: '未知 PR 创建已封存，旧分支永久隔离' }).waitFor();
      try {
        await admin.query("UPDATE collab.project_memberships SET role='reviewer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
        assert.equal((await memberContext.request.post(first.endpoint, { headers, data: first.input })).status(), 403);
        const history = await (await memberContext.request.get(first.endpoint)).json(); assert.equal(history.canControl, false); assert.equal(history.delivery.status, 'created');
      } finally { await admin.query("UPDATE collab.project_memberships SET role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]); }
    }
  }
  console.log('PASS: two-browser explicit draft creation, content/notification/version acknowledgement, real lost HTTP response and reload retry, immutable creation observations, scoped history, cancellation, existing PR refusal, unknown-result permanent quarantine, CSRF/roles and desktop/mobile. Generated loopback PR fixtures only; no external notification.');
}
