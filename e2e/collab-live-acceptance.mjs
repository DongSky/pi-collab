// Uses the running application and its actual executors; no fixture workers.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import lockfile from 'proper-lockfile';
import { demoSignIn, demoTotp } from './collab-live-auth.mjs';
const exec = promisify(execFile), file = '.local/live-demo/state.json';
const release = await lockfile.lock('.local/live-demo', { retries: 0 });
const state = JSON.parse(await readFile(file, 'utf8'));
const base = 'http://127.0.0.1:30142';
assert.equal(state.realRunEvidence?.length, 2);
assert.ok(state.realRunEvidence.every(r => r.status === 'completed'));
assert.notEqual(state.realRunEvidence[0].workspaceId, state.realRunEvidence[1].workspaceId);
const save = async () => { await writeFile(file + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await rename(file + '.tmp', file); };
state.acceptance ??= { runIds: state.runIds, requests: {}, snapshots: [], validations: [], results: [] };
const evidence = state.acceptance;
assert.deepEqual(evidence.runIds, state.runIds, 'Acceptance is pinned to the recorded pair');
const browser = await chromium.launch({ headless: true });
const contexts = [];
const api = async (i, route, body) => {
  const response = body === undefined ? await contexts[i].request.get(base + '/api/collab/' + route)
    : await contexts[i].request.post(base + '/api/collab/' + route, { headers: { Origin: base }, data: body });
  const result = await response.json();
  if (!response.ok()) throw new Error(`${route}: ${response.status()} ${result.error ?? 'failed'}`);
  return result;
};
// Persist each exact mutation before submitting; interrupted executions replay it.
const mutation = async (key, i, route, body) => {
  evidence.requests[key] ??= { route, body: { ...body, idempotencyKey: randomUUID() } };
  await save(); const request = evidence.requests[key];
  return api(i, request.route, request.body);
};
const poll = async (label, load, success, active) => {
  const deadline = Date.now() + 120000; let previous;
  for (;;) {
    const value = await load();
    if (value.status !== previous) { console.log(label + ': ' + value.status); previous = value.status; }
    if (value.status === success) return value;
    assert.ok(active.includes(value.status), `${label}: terminal ${value.status} (${value.error_code ?? ''})`);
    if (Date.now() > deadline) throw new Error(`${label}: still active; resume existing operation`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
};
try {
  for (const name of ['Alice', 'Bob', 'Reviewer']) {
    const account = state.accounts.find(a => a.name === name), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context); const page = await context.newPage();
    await demoSignIn(page, base, account);
  }
  for (let i = 0; i < 2; i++) {
    const run = (await api(i, `runs/${state.runIds[i]}`)).run;
    assert.equal(run.status, 'completed');
    const checkout = path.resolve('.local/workspaces', run.workspace_id, 'checkout');
    const changed = (await exec('git', ['diff', '--name-only', state.repository.baseSha], { cwd: checkout })).stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(changed, [i ? 'shipping.mjs' : 'pricing.mjs']);
    assert.equal((await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: checkout })).stdout.trim(), '');
    const unchanged = ['README.md', 'package.json', 'checkout.mjs', 'tests/pricing.test.mjs', 'tests/shipping.test.mjs', 'tests/checkout.test.mjs', i ? 'pricing.mjs' : 'shipping.mjs'];
    for (const name of unchanged) assert.deepEqual(await readFile(path.join(checkout, name)), await readFile(path.join(state.source, name)), `${name} remained unchanged`);
    if (!evidence.snapshots[i]) {
      const result = await mutation('snapshot' + i, i, `runs/${run.id}/snapshots`, { expectedRevision: run.revision, note: '真实模型完成单一职责代码；冻结版本用于独立检查和组合。' });
      evidence.snapshots[i] = result.snapshotId; assert.ok(result.snapshotId); await save();
    }
    await poll('snapshot ' + i, async () => (await api(i, `tasks/${state.tasks[i].id}/snapshots`)).snapshots.find(s => s.id === evidence.snapshots[i]), 'ready', ['pending']);
    const manifest = await api(i, `snapshots/${evidence.snapshots[i]}`);
    assert.equal(manifest.manifest.runId, run.id);
    assert.deepEqual(manifest.manifest.excluded, [{ path: '.git', reason: 'private_path' }]);
    if (!evidence.validations[i]) {
      const result = await mutation('validation' + i, i, `snapshots/${evidence.snapshots[i]}/validations`, { profileId: state.profiles[i] });
      evidence.validations[i] = result.validationId; assert.ok(result.validationId); await save();
    }
    await poll('validation ' + i, async () => (await api(i, `validations/${evidence.validations[i]}`)).validation, 'passed', ['queued', 'running']);
    if (!evidence.results[i]) {
      const current = await api(i, `tasks/${state.tasks[i].id}/results`);
      const result = await mutation('result' + i, i, `tasks/${state.tasks[i].id}/results`, { validationId: evidence.validations[i], expectedVersion: current.task.version, note: '真实模型编写，固定检查通过，发布供组合验收。' });
      evidence.results[i] = result.resultId; assert.ok(result.resultId); await save();
    }
  }
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: state.source })).stdout.trim(), '');
  if (!evidence.integrationId) {
    const result = await mutation('integration', 0, `projects/${state.projectId}/integrations`, { repositoryId: state.repository.id, targetSha: state.repository.baseSha, resultIds: evidence.results, profileId: state.profiles[2], expectedPolicyId: state.policyId });
    evidence.integrationId = result.integrationId; assert.ok(result.integrationId); await save();
  }
  const id = evidence.integrationId;
  const integration = await poll('integration', async () => (await api(0, `integrations/${id}`)).integration, 'checked', ['queued', 'integrating', 'checking']);
  assert.equal(integration.evidence.merges.length, 2);
  assert.ok(integration.evidence.validation.steps.every(step => step.exitCode === 0));
  const listing = await api(2, `integrations/${id}/code`);
  const changedFiles = listing.files.filter(f => f.kind !== 'excluded');
  assert.deepEqual(listing.files.filter(f => f.kind === 'excluded').map(f => ({ path: f.path, reason: f.reason })), [{ path: '.git', reason: 'private_path' }]);
  assert.deepEqual(changedFiles.map(f => f.path).sort(), ['pricing.mjs', 'shipping.mjs']);
  assert.ok(listing.diffHash);
  for (const f of changedFiles) {
    const detail = await api(2, `integrations/${id}/code/file?path=${encodeURIComponent(f.path)}&diffHash=${listing.diffHash}`);
    assert.equal(detail.omitted, null); assert.ok(detail.after.text.includes('export function'));
  }
  // Generated reviewer account exercises independent authorization, not a claim
  // that a real human has reviewed or approved the implementation.
  if (!evidence.promotionId) {
    await mutation('review', 2, `integrations/${id}/reviews`, { revisionHash: integration.review_state.revisionHash, expectedVersion: 0, decision: 'approve', note: '自动化验收账号：已核对双成果差异、文件边界与全部组合检查；不代表真人审批。' });
    const reviewed = (await api(0, `integrations/${id}`)).integration;
    assert.equal(reviewed.review_state.reviewSatisfied, true);
    if (!(await api(0, 'me')).mfa.enabled) {
      const account = state.accounts.find(a => a.name === 'Alice');
      if (!account.totpSecret) {
        const enrollment = await api(0, 'auth/two-factor/enable', { password: account.password });
        account.totpSecret = new URL(enrollment.totpURI).searchParams.get('secret');
        account.backupCodes = enrollment.backupCodes;
        await save();
      }
      await api(0, 'auth/two-factor/verify-totp', { code: demoTotp(account.totpSecret) });
      assert.equal((await api(0, 'me')).mfa.enabled, true);
      console.log('Maintainer MFA enrolled through normal account APIs');
    }
    const result = await mutation('promotion', 0, `integrations/${id}/promotions`, { revisionHash: reviewed.review_state.revisionHash, acknowledgeExcluded: true, reason: '仅本机练习仓库：双模型组合检查通过，推进演示基线用于验收。' });
    evidence.promotionId = result.promotionId; assert.ok(result.promotionId); await save();
  }
  const promotion = await poll('promotion', async () => (await api(0, `promotions/${evidence.promotionId}`)).promotion, 'applied', ['queued', 'running', 'preparing', 'applying']);
  evidence.promotionSha = promotion.promotion_sha;
  assert.notEqual(evidence.promotionSha, state.repository.baseSha);
  await mkdir('test-results/collab', { recursive: true });
  for (let i = 0; i < 2; i++) {
    const page = contexts[i].pages()[0]; await page.goto(base);
    await page.getByRole('button').filter({ hasText: state.tasks[i].title }).click();
    const card = page.getByRole('article', { name: `整合 ${id}`, exact: true });
    await card.getByRole('status').filter({ hasText: '已推进本地基线' }).waitFor();
    await card.screenshot({ path: `test-results/collab/live-integrated-${i ? 'bob' : 'alice'}.png` });
    if (i === 0) {
      await page.setViewportSize({ width: 390, height: 844 });
      await card.screenshot({ path: 'test-results/collab/live-integrated-mobile.png' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  evidence.completedAt ??= new Date().toISOString(); await save();
  const report = { projectId: state.projectId, modelProfileId: state.modelProfileId, runs: state.realRunEvidence.map(r => ({ id: r.id, status: r.status, workspaceId: r.workspaceId, startedAt: r.startedAt, finishedAt: r.finishedAt })), snapshots: evidence.snapshots, validations: evidence.validations, results: evidence.results, integrationId: id, promotionId: evidence.promotionId, promotionSha: evidence.promotionSha, completedAt: evidence.completedAt, review: 'generated independent account; not human approval' };
  await writeFile('test-results/collab/live-acceptance.json', JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: real concurrent model code, isolated file changes, immutable snapshots, individual checks, combined checks, independent review authorization and local Git promotion.');
} finally { await browser.close(); await release(); }
