import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, access, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';

// Run only against an independently installed package, never the active checkout.
const { values } = parseArgs({ options: { 'package-dir': { type: 'string' } } });
if (!values['package-dir']) throw new Error('Usage: npm run test:pi-install:smoke -- --package-dir /absolute/isolated/install');
const packageRoot = path.resolve(values['package-dir']);
if (packageRoot === path.resolve(import.meta.dirname, '..')) throw new Error('Use a separate installation, not this checkout');
const temp = await mkdtemp(path.join(tmpdir(), 'pi-collab-install-smoke-'));
const data = path.join(temp, 'data'), agentDir = path.join(temp, 'pi'), cwd = path.join(temp, 'cwd');
await mkdir(cwd);
const exec = promisify(execFile);
const env = { ...process.env, PI_COLLAB_DATA_DIR: data, PI_CODING_AGENT_DIR: agentDir, PI_COLLAB_DEPLOYMENT: 'local', PI_OFFLINE: '1' };
const run = (command, args = []) => exec(process.execPath, [path.join(packageRoot, 'bin/pi-collab.cjs'), command, '--data-dir', data, ...args], { cwd, env, timeout: 150_000 });
const servers = Array.from({ length: 4 }, () => createServer());
for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ports = servers.map(server => server.address().port);
await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
const piCli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
let passed = false;
try {
  await exec(process.execPath, [piCli, 'install', packageRoot], { cwd, env });
  const settings = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
  assert.ok(settings.packages.some(source => path.resolve(agentDir, source) === packageRoot));
  await run('start', ['--port', String(ports[0]), '--database-port', String(ports[1]), '--gateway-port', String(ports[2])]);
  const config = JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8'));
  const origin = `http://127.0.0.1:${ports[0]}`;
  const response = await fetch(`${origin}/api/collab/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ token: config.bootstrapToken, name: 'Install smoke', email: 'install-smoke@example.invalid', password: randomBytes(24).toString('hex'), organizationName: 'Isolated install smoke' }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, 'Owner initialization');
  await assert.rejects(run('start', ['--port', String(ports[3])]), /更换端口前/);
  assert.equal(JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).port, ports[0]);
  await run('stop');
  for (const file of ['supervisor.json', 'postgres/postmaster.pid']) await assert.rejects(access(path.join(data, file)), /ENOENT/, file);
  await run('start', ['--port', String(ports[3])]);
  await run('resume');
  assert.match((await run('status')).stdout, /"draining":false/);
  assert.equal((await (await fetch(`http://127.0.0.1:${ports[3]}/api/collab/setup`, { signal: AbortSignal.timeout(15_000) })).json()).needed, false);
  assert.equal(JSON.parse(await readFile(path.join(data, 'config.json'), 'utf8')).bootstrapToken, config.bootstrapToken);
  await run('stop');
  for (const file of ['supervisor.json', 'postgres/postmaster.pid']) await assert.rejects(access(path.join(data, file)), /ENOENT/, file);
  await exec(process.execPath, [piCli, 'remove', packageRoot], { cwd, env });
  passed = true;
  console.log('PASS: Pi install, native startup, Owner setup, port guards, stop, port change, account persistence, resume and uninstall.');
} finally {
  if (passed) await rm(temp, { recursive: true, force: true });
  else {
    try { await run('stop'); } catch { /* Preserve evidence; never kill arbitrary processes. */ }
    console.error(`Failed acceptance data and logs retained at ${temp}`);
  }
}
