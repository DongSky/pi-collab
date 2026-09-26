import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyPromotionUi({ base, projectId, repository, ownerContext, memberContext, owner, member, admin, worker, resultId }) {
  const headers = { Origin: base };
  const profile = await (await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/validation-profiles`, { headers, data: {
    repositoryId: repository.id, name: '本地推进必跑检查', idempotencyKey: randomUUID(),
    config: { version: 1, steps: [{ tool: 'node', args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('collab-beta.txt','utf8'),'beta')"], timeoutSeconds: 10 }] },
  } })).json(); assert.ok(profile.profileId);
  const current = (await (await ownerContext.request.get(`${base}/api/collab/projects/${projectId}/integration-policies`)).json()).policies.find(p => p.repository_id === repository.id);
  const policy = await (await ownerContext.request.post(`${base}/api/collab/projects/${projectId}/integration-policies`, { headers, data: { repositoryId: repository.id, profileId: profile.profileId, requiredApprovals: 1, reviewerApprovals: true, expectedVersion: current.version, reason: '固定 beta 成果的独立评审和本地 Git 推进验收。', idempotencyKey: randomUUID() } })).json(); assert.ok(policy.policyId);
  const queued = await (await memberContext.request.post(`${base}/api/collab/projects/${projectId}/integrations`, { headers, data: { repositoryId: repository.id, targetSha: repository.baseSha, resultIds: [resultId], profileId: profile.profileId, expectedPolicyId: policy.policyId, idempotencyKey: randomUUID() } })).json();
  const id = queued.integrationId; assert.ok(id); assert.equal((await worker('integrate', id)).outcome, 'checked');
  const detail = (await (await ownerContext.request.get(`${base}/api/collab/integrations/${id}`)).json()).integration;
  assert.equal((await ownerContext.request.post(`${base}/api/collab/integrations/${id}/reviews`, { headers, data: { revisionHash: detail.review_state.revisionHash, expectedVersion: 0, decision: 'approve', note: '独立核对 beta 代码树、固定检查证据和未验证的排除内容。', idempotencyKey: randomUUID() } })).status(), 201);
  const body = { revisionHash: detail.review_state.revisionHash, acknowledgeExcluded: true, reason: '批准固定候选的本地推进，保留完整溯源。', idempotencyKey: randomUUID() };
  assert.equal((await memberContext.request.post(`${base}/api/collab/integrations/${id}/promotions`, { headers, data: body })).status(), 403);
  assert.equal((await ownerContext.request.post(`${base}/api/collab/integrations/${id}/promotions`, { headers: { Origin: 'https://untrusted.invalid' }, data: body })).status(), 403);
  assert.equal((await ownerContext.request.post(`${base}/api/collab/integrations/${id}/promotions`, { headers, data: { ...body, acknowledgeExcluded: false } })).status(), 400);
  for (const page of [owner, member]) { await page.goto(base); await page.getByRole('button').filter({ hasText: '整合候选乙' }).click(); }
  const panel = owner.getByRole('region', { name: '项目 Git 整合队列', exact: true }), card = panel.getByRole('article', { name: `整合 ${id}`, exact: true });
  const peer = member.getByRole('article', { name: `整合 ${id}`, exact: true });
  await card.locator('summary').filter({ hasText: /^推进本地 Git 基线$/ }).click();
  assert.equal(await peer.locator('summary').filter({ hasText: /^推进本地 Git 基线$/ }).count(), 0);
  await card.getByRole('button', { name: '准备本地推进', exact: true }).click(); await card.getByLabel('推进说明', { exact: true }).fill(body.reason);
  assert.equal(await card.getByRole('button', { name: '确认推进本地基线', exact: true }).isDisabled(), true);
  await card.getByRole('checkbox', { name: /我确认固定候选与同代码树溯源提交/ }).check();
  await card.getByRole('region', { name: '本地 Git 推进', exact: true }).screenshot({ path: 'test-results/collab/promotion-confirmation.png' });
  await owner.setViewportSize({ width: 390, height: 844 }); await card.getByRole('region', { name: '本地 Git 推进', exact: true }).screenshot({ path: 'test-results/collab/promotion-confirmation-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await owner.setViewportSize({ width: 1440, height: 1000 });
  let lost = true;
  await owner.route(`**/api/collab/integrations/${id}/promotions`, async route => { if (lost) { lost = false; assert.equal((await route.fetch()).status(), 201); await route.abort('failed'); } else await route.continue(); });
  await card.getByRole('button', { name: '确认推进本地基线', exact: true }).click(); await panel.getByRole('button', { name: '重试同一整合操作', exact: true }).click();
  await peer.getByRole('status').filter({ hasText: '等待本地推进' }).waitFor();
  const rows = (await admin.query('SELECT id FROM collab.promotions WHERE integration_id=$1', [id])).rows; assert.equal(rows.length, 1); const promotion = rows[0].id;
  assert.equal((await ownerContext.request.post(`${base}/api/collab/integrations/${id}/promotions`, { headers, data: { ...body, idempotencyKey: randomUUID() } })).status(), 409);
  assert.equal((await worker('promotion-crash', promotion)).outcome, 'unknown');
  const operation = card.getByLabel(`推进 ${promotion}`, { exact: true });
  await operation.getByRole('status').filter({ hasText: '推进结果未知' }).waitFor(); await peer.getByRole('status').filter({ hasText: '推进结果未知' }).waitFor();
  assert.equal((await admin.query('SELECT base_sha FROM collab.repositories WHERE id=$1', [repository.id])).rows[0].base_sha, repository.baseSha);
  await operation.screenshot({ path: 'test-results/collab/promotion-unknown.png' });
  const reconcile = { action: 'reconcile', reason: '确认已写入的 Git 决定，不能自动重复推进。', idempotencyKey: randomUUID() };
  assert.equal((await memberContext.request.post(`${base}/api/collab/promotions/${promotion}`, { headers, data: reconcile })).status(), 403);
  await operation.getByLabel('推进处理原因', { exact: true }).fill(reconcile.reason);
  let reconcileLost = true; await owner.route(`**/api/collab/promotions/${promotion}`, async route => {
    if (route.request().method() === 'POST' && reconcileLost) { reconcileLost = false; assert.equal((await route.fetch()).status(), 200); await route.abort('failed'); } else await route.continue();
  });
  await operation.getByRole('button', { name: '申请 Git 对账', exact: true }).click(); await panel.getByRole('button', { name: '重试同一整合操作', exact: true }).click();
  await peer.getByRole('status').filter({ hasText: '等待 Git 对账' }).waitFor(); assert.equal((await worker('promote', promotion)).outcome, 'applied');
  await operation.getByRole('status').filter({ hasText: '已推进本地基线' }).waitFor(); await peer.getByRole('status').filter({ hasText: '已推进本地基线' }).waitFor();
  const response = await memberContext.request.get(`${base}/api/collab/promotions/${promotion}`); assert.equal(response.status(), 200); assert.equal(response.headers()['cache-control'], 'no-store');
  const p = (await response.json()).promotion; assert.notEqual(p.promotion_sha, detail.evidence.candidateCommit); assert.equal(p.observation.targetSha, p.promotion_sha); assert.equal(p.observation.applicationEvidence, 'receipt');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM collab.repository_baselines WHERE promotion_id=$1', [promotion])).rows[0].n, 1);
  await panel.getByLabel('整合仓库', { exact: true }).selectOption(repository.id); await panel.getByText(`目标基线 ${p.promotion_sha.slice(0, 12)}`, { exact: true }).waitFor();
  await member.reload(); await member.getByRole('button').filter({ hasText: '整合候选乙' }).click(); await peer.getByRole('status').filter({ hasText: '已推进本地基线' }).waitFor();
  await card.getByRole('region', { name: '本地 Git 推进', exact: true }).screenshot({ path: 'test-results/collab/promotions.png' });
  await owner.setViewportSize({ width: 390, height: 844 }); await card.getByRole('region', { name: '本地 Git 推进', exact: true }).screenshot({ path: 'test-results/collab/promotions-mobile.png' });
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await owner.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS: two-browser native promotion, maintainer/CSRF/acknowledgement gates, duplicate request protection, lost-response retry, actual Git effect with uncertain acknowledgement, explicit terminal reconciliation, baseline refresh and desktop/mobile UI.');
}
