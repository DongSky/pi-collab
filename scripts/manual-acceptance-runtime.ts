/** Disposable backend companion for Computer Use. No browser automation. */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Pool } from 'pg';
import { localConfig, connectionString, executorConnectionString, gitConnectionString, brokerConnectionString, gatewayConnectionString } from './local-config';
import { masterKey } from '../lib/collab/gateway/credentials';
import { registerModelProfile } from '../lib/collab/gateway/profiles';
import { importLocalRepository } from '../lib/collab/repository-import';
import { createValidationProfile } from '../lib/collab/validations';
import { gitSource } from '../tests/collab/fixtures/git-source';
const { values } = parseArgs({ options: { database: { type: 'string' }, directory: { type: 'string' }, 'import-model': { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, 'gateway-port': { type: 'string' }, 'web-origin': { type: 'string' } } });
const gatewayPort = Number(values['gateway-port']);
if (values['import-model'] && (!values.provider || !values.model)) throw new Error('Explicit model selection required: --import-model --provider NAME --model ID');
if (values['import-model'] && (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(values['web-origin'] ?? ''))) throw new Error('Explicit loopback web origin and gateway port required for inference');
if (!values.database || !/^pi_collab_test_[a-f0-9]{12}$/.test(values.database) || !values.directory) throw new Error('Disposable test database and directory required');
const root = path.resolve(values.directory);
if (!root.startsWith(path.resolve('.local') + path.sep + 'identity-e2e-')) throw new Error('Expected existing manual acceptance source directory');
await readFile(path.join(root, 'package.json'));
const config = await localConfig();
const admin = new Pool({ connectionString: connectionString(config, true, values.database) });
const rows = (await admin.query(`SELECT p.id,p.created_by FROM collab.projects p JOIN public."user" u ON u.id=p.created_by WHERE u.email='cua-owner@pi-collab.test' AND p.name='双 AI 协作验收'`)).rows;
if (rows.length !== 1) throw new Error('Expected named disposable CUA fixture project');
const project = rows[0];
process.env.DATABASE_URL = connectionString(config, false, values.database);
try {
 if (!(await admin.query('SELECT id FROM collab.repositories WHERE project_id=$1', [project.id])).rowCount) {
  await gitSource(root);
  const repository = await importLocalRepository(admin, root, { projectId: project.id, actorId: project.created_by, source: path.join(root, 'source'), name: 'CUA 本机验收仓库' });
  await createValidationProfile(project.created_by, project.id, { repositoryId: repository.id, name: '固定文件验收', config: { version: 1, steps: [{ tool: 'node', args: ['-e', "const fs=require('fs');if(!fs.existsSync('shared.txt'))process.exit(1);console.log('fixture verified')"], timeoutSeconds: 10 }] }, idempotencyKey: crypto.randomUUID() });
 }
 if (values['import-model']) {
  const selected = JSON.parse(await readFile(path.join(os.homedir(), '.pi/agent/models.json'), 'utf8')).providers?.[values.provider!];
  const model = selected?.models?.find((m: { id: string }) => m.id === values.model);
  if (!model || (model.api ?? selected.api) !== 'openai-responses' || typeof selected.apiKey !== 'string' || selected.apiKey.startsWith('!') || selected.headers || model.headers) throw new Error('Unsupported selected Pi configuration');
  const existing = (await admin.query('SELECT id FROM collab.model_profiles WHERE project_id=$1', [project.id])).rows;
  const key = await masterKey(path.join(root, 'model-master.key'), existing.length === 0);
  try {
   if (!existing.length) await registerModelProfile(admin, key, { projectId: project.id, actorId: project.created_by, name: `${values.provider} / ${model.id} · 本机验收`, modelId: model.id, reasoning: !!model.reasoning, contextWindow: 128000, maxOutputTokens: 4096, runRequestLimit: 24, runTokenLimit: 1000000, dailyTokenLimit: 2000000 }, { apiKey: selected.apiKey, baseUrl: selected.baseUrl });
  } finally { key.fill(0); }
 }
} finally { await admin.end(); }
await mkdir(path.join(root, 'manual-runtime'), { recursive: true });
await writeFile(path.join(root, 'manual-runtime', 'README.txt'), 'Disposable executor and brokers for Computer Use. Inference requires the explicit selected-model flag.\n');
const shared: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'development', PI_COLLAB_DATA_DIR: root, PI_COLLAB_RUNTIME: 'native', ...(values['import-model'] ? { PI_COLLAB_MODEL_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}/v1` } : {}) };
const children = [
 ...(values['import-model'] ? [spawn(process.execPath, ['--import', 'tsx', 'scripts/model-gateway.ts'], { env: { ...shared, PI_COLLAB_GATEWAY_DATABASE_URL: gatewayConnectionString(config, values.database), PI_COLLAB_MODEL_MASTER_KEY_FILE: path.join(root, 'model-master.key'), PI_COLLAB_GATEWAY_PORT: String(gatewayPort), PI_COLLAB_WEB_ORIGIN: values['web-origin'] }, stdio: 'inherit' })] : []),
 spawn(process.execPath, ['--import', 'tsx', 'scripts/executor.ts'], { env: { ...shared, PI_COLLAB_EXECUTOR_DATABASE_URL: executorConnectionString(config, values.database) }, stdio: 'inherit' }),
 spawn(process.execPath, ['--import', 'tsx', 'scripts/git-broker.ts'], { env: { ...shared, PI_COLLAB_GIT_DATABASE_URL: gitConnectionString(config, values.database), PI_COLLAB_GIT_KEY_FILE: path.join(root, 'git-master.key') }, stdio: 'inherit' }),
 spawn(process.execPath, ['--import', 'tsx', 'scripts/resource-broker.ts'], { env: { ...shared, PI_COLLAB_BROKER_DATABASE_URL: brokerConnectionString(config, values.database), PI_COLLAB_RESOURCE_KEY_FILE: path.join(root, 'resource-master.key') }, stdio: 'inherit' }),
];
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const exits = children.map(child => new Promise<void>(resolve => { child.once('exit', code => { if (code) process.exitCode = 1; stop(); resolve(); }); child.once('error', () => { process.exitCode = 1; stop(); resolve(); }); }));
console.log(`Disposable runtime ready; inference ${values['import-model'] ? 'enabled for the explicitly selected model' : 'disabled'}.`);
await Promise.all(exits);
const { database } = await import('../lib/collab/database'); await database().end();
