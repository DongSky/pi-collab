import { resizeWorkspace } from './collab-navigation.mjs';
import { verifyPullRevisions } from './collab-pull-revisions.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

export async function verifyPullObservations({ base, changeId, projectId, memberId, ownerContext, memberContext, owner, member, root, peerRoot, worker, admin, reopen }) {
  const region = root.locator('details[aria-label="远端 PR 状态观察"]'), peer = peerRoot.locator('details[aria-label="远端 PR 状态观察"]');
  const route = base + '/api/collab/pull-changes/' + changeId + '/observations', headers = { Origin: base };
  const context = async () => { const r = await memberContext.request.get(route); assert.equal(r.status(), 200); assert.equal(r.headers()['cache-control'], 'no-store'); return r.json(); };
  const input = value => ({ idempotencyKey: randomUUID(), expectedTaskVersion: value.taskVersion, expectedObservationVersion: value.observationVersion });
  for (const pane of [region, peer]) await pane.locator('summary').first().click();
  await region.getByRole('button', { name: '读取 GitHub PR 状态', exact: true }).waitFor();
  assert.equal((await context()).observationVersion, '0');
  assert.equal((await memberContext.request.post(route, { headers: { Origin: 'https://untrusted.invalid' }, data: input(await context()) })).status(), 403);
  assert.equal((await memberContext.request.post(route, { headers, data: { ...input(await context()), identity: { number: 900 } } })).status(), 400);
  let lost = true, resolveCommit, rejectCommit;
  const committed = new Promise((resolve, reject) => { resolveCommit = resolve; rejectCommit = reject; }); void committed.catch(() => {});
  const intercept = '**/pull-changes/' + changeId + '/observations';
  await member.route(intercept, async request => {
    if (lost && request.request().method() === 'POST') {
      lost = false;
      try { assert.equal((await request.fetch()).status(), 202); await request.abort('failed'); resolveCommit(); }
      catch (error) { rejectCommit(error); throw error; }
    } else await request.continue();
  });
  await region.getByRole('button', { name: '读取 GitHub PR 状态', exact: true }).click();
  await region.getByRole('button', { name: '重试同一 PR 读取操作', exact: true }).waitFor(); await committed;
  await reopen(); await region.locator('summary').first().click();
  await region.getByRole('button', { name: '重试同一 PR 读取操作', exact: true }).click();
  await region.getByRole('button', { name: '重试同一 PR 读取操作', exact: true }).waitFor({ state: 'hidden' });
  let current = await context(); assert.equal(current.jobs.length, 1); const first = current.jobs[0].jobId;
  const result = await worker('pull-observe', first); assert.equal(result.status, 'observed'); assert.equal(result.readTokens, 1); assert.equal(result.readRequests, 1); assert.equal(result.createRequests, 0);
  assert.equal(createHash('sha256').update(result.observationText).digest('hex'), result.observationHash);
  for (const pane of [region, peer]) {
    await pane.getByRole('button', { name: '刷新已有 PR 观察记录', exact: true }).click();
    await pane.getByRole('region', { name: '最近成功的 PR 观察', exact: true }).getByText('最近成功观察 · 记录版本 1', { exact: true }).waitFor();
    await pane.locator('[data-pull-observation="' + first + '"]').getByRole('status').filter({ hasText: '已保存远端 PR 观察' }).waitFor();
  }
  await verifyPullRevisions({ base, changeId, region, peer, member, owner, memberContext, ownerContext, worker });
  await member.unroute(intercept);
  current = await context();
  const merged = await ownerContext.request.post(route, { headers, data: input(current) }); assert.equal(merged.status(), 202);
  const mergedId = (await merged.json()).jobId; assert.equal((await worker('pull-observe-merged', mergedId)).observationVersion, '2');
  for (const pane of [region, peer]) {
    await pane.getByRole('button', { name: '刷新已有 PR 观察记录', exact: true }).click();
    await pane.getByRole('region', { name: '最近成功的 PR 观察', exact: true }).getByText('观察到已合并', { exact: true }).waitFor();
  }
  assert.equal((await context()).jobs.find(j => j.jobId === first).observation.snapshot.merged, false);
  assert.equal((await memberContext.request.post(route, { headers, data: input(current) })).status(), 409);
  await peer.screenshot({ path: 'test-results/collab/pull-observation-desktop.png' });
  await resizeWorkspace(owner, { width: 390, height: 844 }); await peer.screenshot({ path: 'test-results/collab/pull-observation-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await resizeWorkspace(owner, { width: 1440, height: 1000 });

  const failed = await memberContext.request.post(route, { headers, data: input(await context()) }); assert.equal(failed.status(), 202);
  assert.equal((await worker('pull-observe-missing', (await failed.json()).jobId)).status, 'failed');
  await region.getByRole('button', { name: '刷新已有 PR 观察记录', exact: true }).click();
  await region.getByText('最近一次读取失败，保留的成功观察可能已过期；失败不代表 PR 被删除或关闭。', { exact: true }).waitFor();
  await region.getByRole('region', { name: '最近成功的 PR 观察', exact: true }).getByText('观察到已合并', { exact: true }).waitFor();
  const cancelled = await memberContext.request.post(route, { headers, data: input(await context()) }); assert.equal(cancelled.status(), 202);
  const cancelledId = (await cancelled.json()).jobId;
  await peer.getByRole('button', { name: '刷新已有 PR 观察记录', exact: true }).click();
  const job = peer.locator('[data-pull-observation="' + cancelledId + '"]');
  await job.getByLabel('PR 读取取消原因', { exact: true }).fill('取消此排队读取，保留之前的成功观察。');
  await job.getByRole('button', { name: '取消此次 PR 读取', exact: true }).click(); await job.getByText('已记录取消请求。', { exact: true }).waitFor();
  const stop = await worker('pull-observe', cancelledId); assert.equal(stop.status, 'cancelled'); assert.equal(stop.readTokens, 0); assert.equal(stop.readRequests, 0);
  assert.equal((await context()).observationVersion, '2');
  await admin.query("UPDATE collab.project_memberships SET role='reviewer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]);
  try {
    await region.getByRole('button', { name: '刷新已有 PR 观察记录', exact: true }).click();
    await region.getByRole('button', { name: '读取 GitHub PR 状态', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await memberContext.request.post(route, { headers, data: input(await context()) })).status(), 403);
  } finally { await admin.query("UPDATE collab.project_memberships SET role='developer' WHERE project_id=$1 AND user_id=$2", [projectId, memberId]); }
  await reopen(); await region.locator('summary').first().click();
  await region.getByRole('region', { name: '最近成功的 PR 观察', exact: true }).getByText('观察到已合并', { exact: true }).waitFor();
  console.log('PASS: durable manual PR observation, actual lost HTTP response and same-key reload retry, two-member ordered history, observed closure/merge, failed-read preservation, queued cancellation without credentials, stale versions, role/CSRF and desktop/mobile. Loopback protocol fixtures; no remote writes or CI assertions.');
}
