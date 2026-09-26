import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyPullChecks({ base, revisionId, panes: parents, member, owner, memberContext, ownerContext, worker }) {
  const route = base + '/api/collab/pull-revisions/' + revisionId;
  const panes = parents.map(p => p.locator('[data-pull-revision="' + revisionId + '"] details[aria-label="固定版本 CI"]'));
  for (const pane of panes) await pane.locator('summary').first().click();
  const policy = { idempotencyKey: randomUUID(), expectedVersion: 0, reason: 'Trust dedicated test build App for this branch', config: { version: 1, required: [{ name: 'build', appId: '41234' }], maxAgeSeconds: 600 } };
  assert.equal((await memberContext.request.post(route + '/checks-policy', { headers: { Origin: base }, data: policy })).status(), 403);
  assert.equal((await ownerContext.request.post(route + '/checks-policy', { headers: { Origin: 'https://untrusted.invalid' }, data: policy })).status(), 403);
  await panes[1].getByRole('button', { name: '编辑 CI 规则', exact: true }).click();
  await panes[1].getByLabel('CI 检查名称 1', { exact: true }).fill('build');
  await panes[1].getByLabel('CI App ID 1', { exact: true }).fill('41234');
  await panes[1].getByLabel('CI 规则变更原因', { exact: true }).fill(policy.reason);
  await panes[1].getByRole('button', { name: '发布 CI 规则', exact: true }).click();
  await panes[1].getByLabel('当前 CI 规则', { exact: true }).getByText('CI 规则 v1', { exact: false }).waitFor();
  await panes[0].getByRole('button', { name: '刷新已有 CI 记录', exact: true }).click();
  const intercept = '**/pull-revisions/' + revisionId + '/checks'; let lost = true;
  await member.route(intercept, async request => {
    if (lost && request.request().method() === 'POST') { lost = false; assert.equal((await request.fetch()).status(), 202); await request.abort('failed'); }
    else await request.continue();
  });
  await panes[0].getByRole('button', { name: '读取此版本 GitHub CI', exact: true }).click();
  await panes[0].getByRole('button', { name: '重试同一 CI 操作', exact: true }).click();
  await panes[0].getByRole('button', { name: '重试同一 CI 操作', exact: true }).waitFor({ state: 'hidden' });
  const context = await (await memberContext.request.get(route + '/checks')).json(); assert.equal(context.jobs.length, 1);
  const id = context.jobs[0].jobId, result = await worker('pull-checks', id);
  assert.equal(result.status, 'observed', JSON.stringify(result)); assert.equal(result.eligible, true); assert.equal(result.readTokens, 1); assert.equal(result.checkReads, 2); assert.equal(result.createRequests, 0);
  for (const pane of panes) {
    await pane.getByRole('button', { name: '刷新已有 CI 记录', exact: true }).click();
    await pane.locator('[data-pull-checks="' + id + '"]').getByText('检查符合当前 CI 规则', { exact: true }).waitFor();
    await pane.getByText('build · App 41234 · 通过 · 检查 71001', { exact: true }).waitFor();
  }
  await panes[1].screenshot({ path: 'test-results/collab/pull-checks-desktop.png' });
  await owner.setViewportSize({ width: 390, height: 844 }); await panes[1].screenshot({ path: 'test-results/collab/pull-checks-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await owner.setViewportSize({ width: 1440, height: 1000 });
  assert.equal((await worker('webhook-checks', revisionId)).accepted, true);
  for (const pane of panes) { await pane.getByRole('button', { name: '刷新已有 CI 记录', exact: true }).click(); await pane.locator('[data-pull-checks="' + id + '"]').getByText('历史检查成功', { exact: false }).waitFor(); }
  await panes[0].getByRole('button', { name: '读取此版本 GitHub CI', exact: true }).click();
  await panes[0].getByText('等待 CI 读取', { exact: true }).waitFor();
  const newer = (await (await memberContext.request.get(route + '/checks')).json()).jobs;
  assert.equal(newer.length, 2); assert.equal(newer.find(j => j.jobId === id).eligible, false);
  const failed = await worker('pull-checks-failed', newer[0].jobId); assert.equal(failed.status, 'observed'); assert.equal(failed.eligible, false);
  for (const pane of panes) {
    await pane.getByRole('button', { name: '刷新已有 CI 记录', exact: true }).click();
    await pane.getByText('检查未满足指定 CI 规则', { exact: true }).waitFor();
    await pane.locator('[data-pull-checks="' + id + '"]').getByText('历史检查成功', { exact: false }).waitFor();
  }
  await member.unroute(intercept);
  console.log('PASS: CI policy role/CSRF, browser publication, durable lost-response retry, two-member exact-producer checks, newer failed read invalidates old success, desktop/mobile.');
}
