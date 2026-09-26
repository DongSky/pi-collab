import { resizeWorkspace } from './collab-navigation.mjs';
import assert from 'node:assert/strict';
import { verifyPullChecks } from './collab-pull-checks.mjs';
import { randomUUID } from 'node:crypto';
export async function verifyPullRevisions({ base, changeId, region, peer, member, owner, memberContext, ownerContext, worker }) {
  const route = base + '/api/collab/pull-changes/' + changeId + '/revisions';
  const panes = [region, peer].map(p => p.locator('details[aria-label="PR 固定代码版本"]'));
  for (const pane of panes) { await pane.locator('summary').first().click(); await pane.getByRole('button', { name: '刷新已有 PR 代码记录', exact: true }).click(); }
  const context = await (await memberContext.request.get(route)).json();
  const data = { expectedTaskVersion: context.taskVersion, expectedObservationVersion: context.observationVersion, idempotencyKey: randomUUID() };
  assert.equal((await memberContext.request.post(route, { headers: { Origin: 'https://untrusted.invalid' }, data })).status(), 403);
  const intercept = '**/pull-changes/' + changeId + '/revisions'; let lost = true;
  await member.route(intercept, async request => {
    if (lost && request.request().method() === 'POST') { lost = false; assert.equal((await request.fetch()).status(), 202); await request.abort('failed'); }
    else await request.continue();
  });
  await panes[0].getByRole('button', { name: '下载观察对应的固定代码', exact: true }).click();
  await panes[0].getByRole('button', { name: '重试同一 PR 代码操作', exact: true }).click();
  await panes[0].getByRole('button', { name: '重试同一 PR 代码操作', exact: true }).waitFor({ state: 'hidden' });
  const queued = await (await memberContext.request.get(route)).json(); assert.equal(queued.jobs.length, 1);
  const id = queued.jobs[0].jobId, result = await worker('pull-revision', id);
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(result.readTokens, 1); assert.equal(result.receiveRequests, 0);
  for (const pane of panes) {
    await pane.getByRole('button', { name: '刷新已有 PR 代码记录', exact: true }).click();
    const job = pane.locator('[data-pull-revision="' + id + '"]');
    await job.getByRole('status').filter({ hasText: '固定 PR 代码已就绪' }).waitFor();
    await job.locator('details[aria-label="固定 PR 代码差异"] > summary').click();
    await job.getByRole('button', { name: '读取固定 PR 文件列表', exact: true }).click();
    await job.getByRole('button', { name: '修改 · code.txt', exact: true }).click();
    await job.getByLabel('PR 逐行代码差异', { exact: true }).locator('div').filter({ hasText: /\+final committed code\s*$/ }).waitFor();
    await job.getByRole('button', { name: '新增 · binary.bin', exact: true }).click();
    await job.getByText('未显示内容：non_text_or_large。此路径未完成代码审阅。', { exact: true }).waitFor();
    await job.getByRole('button', { name: '已排除 · .env', exact: true }).click();
    await job.getByText('未显示内容：private_path。此路径未完成代码审阅。', { exact: true }).waitFor();
    await job.getByRole('button', { name: '修改 · code.txt', exact: true }).click();
  }
  const codeRoute = base + '/api/collab/pull-revisions/' + id + '/code';
  const listingResponse = await ownerContext.request.get(codeRoute); assert.equal(listingResponse.status(), 200); assert.equal(listingResponse.headers()['cache-control'], 'no-store');
  const listing = await listingResponse.json();
  assert.equal((await ownerContext.request.get(codeRoute + '/file?' + new URLSearchParams({ path: '../private', diffHash: listing.record.diffHash }))).status(), 404);
  assert.equal((await ownerContext.request.get(codeRoute + '/file?' + new URLSearchParams({ path: 'code.txt', diffHash: '0'.repeat(64) }))).status(), 409);
  await panes[1].screenshot({ path: 'test-results/collab/pull-revision-desktop.png' });
  await resizeWorkspace(owner, { width: 390, height: 844 }); await panes[1].screenshot({ path: 'test-results/collab/pull-revision-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await resizeWorkspace(owner, { width: 1440, height: 1000 });
  await member.unroute(intercept);
  await verifyPullChecks({ base, revisionId: id, panes, member, owner, memberContext, ownerContext, worker });
  const notification = await worker('webhook-code', id); assert.equal(notification.accepted, true);
  for (const outer of [region, peer]) await outer.getByRole('status').filter({ hasText: '远端变更通知已使旧代码证据失效' }).waitFor();
  const signals = await (await memberContext.request.get(base + '/api/collab/pull-changes/' + changeId + '/remote-events')).json();
  assert.equal(signals.events.length, 2); assert.equal(signals.needsRefresh, true);
  const eventPane = peer.getByLabel('PR 远端变更通知', { exact: true });
  await eventPane.locator('summary').click(); await eventPane.screenshot({ path: 'test-results/collab/pull-webhooks-desktop.png' });
  await resizeWorkspace(owner, { width: 390, height: 844 }); await eventPane.screenshot({ path: 'test-results/collab/pull-webhooks-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await resizeWorkspace(owner, { width: 1440, height: 1000 });
  console.log('PASS: actual signed HTTP webhook delivery/replay, shared notifications, check and code invalidation, desktop/mobile.');
  console.log('PASS: explicit fixed PR capture through browser, lost-response replay, two-user diff agreement, secret/binary omissions, hash/path checks and desktop/mobile layout.');
}
