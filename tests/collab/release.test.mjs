import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packRelease, verifyRelease, installRelease } from '../../scripts/release.mjs';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-collab-package-')), source = path.join(root, 'source');
  await mkdir(source);
  const pkg = { name: 'pi-collab', version: '0.0.0-fixture', private: true };
  const files = {
    'package.json': JSON.stringify(pkg),
    'package-lock.json': JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }),
    'next.config.ts': 'export default {};', 'tsconfig.json': '{}', 'scripts/package.json': '{"type":"module"}',
    'scripts/dev-local.ts': '// fixture only; no Next server or product startup asserted',
    'scripts/release.mjs': '// package entry fixture', 'lib/collab/runtime/service-runner.mjs': '// runner fixture',
    'db/migrations/001-fixture.sql': 'SELECT 1;', 'public/logo.svg': '<svg/>',
  };
  async function put(name, content) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), content); }
  for (const [name, value] of Object.entries(files)) await put(name, value);
  await exec('git', ['init', '-q'], { cwd: source });
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@test.invalid', 'commit', '-qm', 'release fixture'], { cwd: source });
  for (const [name, value] of Object.entries({ '.next/BUILD_ID': 'fixture-build', '.next/required-server-files.json': '{}', '.next/routes-manifest.json': '{}', '.next/server/app.js': '// synthetic build bytes', '.next/cache/private': 'cache', '.next/dev/private': 'development output', '.local/config.json': 'private-local-secret', '.env.production': 'private-env-secret' })) await put(name, value);
  return { root, source, output: path.join(root, 'package'), put };
}

test('release packaging and installation preserve pinned bytes without Git, local secrets, build caches or existing directory writes', async () => {
  const f = await fixture();
  try {
    const manifest = await packRelease(f.source, f.output);
    assert.equal(manifest.files.some(file => /\.env|\.local|\.next\/(cache|dev)/.test(file.path)), false);
    assert.equal((await verifyRelease(f.output)).commit, manifest.commit);
    const installed = path.join(f.root, 'installed');
    await installRelease(f.output, installed); // actual npm ci, empty locked package, no model/network services
    assert.equal((await verifyRelease(installed)).commit, manifest.commit);
    await assert.rejects(readFile(path.join(installed, '.git/HEAD')), /ENOENT/);
    const data = path.join(f.root, 'data'); await mkdir(path.join(data, 'postgres'), { recursive: true }); await writeFile(path.join(data, 'postgres/PG_VERSION'), '18');
    const backup = await exec(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `import {makeManifest} from ${JSON.stringify(new URL('../../scripts/operations-core.ts', import.meta.url).href)}; console.log(JSON.stringify(await makeManifest(${JSON.stringify(data)}, [])));`], { cwd: installed });
    assert.equal(JSON.parse(backup.stdout).commit, manifest.commit);
    assert.equal(JSON.parse(backup.stdout).dirty, false);
    await assert.rejects(installRelease(f.output, installed), /EEXIST/);
    await writeFile(path.join(installed, '.next/server/app.js'), 'changed');
    await assert.rejects(verifyRelease(installed), /integrity mismatch/);
    await f.put('scripts/dev-local.ts', '// dirty source');
    await assert.rejects(packRelease(f.source, path.join(f.root, 'dirty')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('release verification rejects traversal, symlinks, extra build output and incompatible platforms', async () => {
  const f = await fixture();
  try {
    await packRelease(f.source, f.output);
    const file = path.join(f.output, 'release-manifest.json'), original = await readFile(file, 'utf8'), manifest = JSON.parse(original);
    manifest.files[0].path = '../outside'; await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(verifyRelease(f.output), /Invalid release file/);
    await writeFile(file, original);
    const injectedEnv = path.join(f.output, '.env.production'); await writeFile(injectedEnv, 'INJECTED=1');
    await assert.rejects(verifyRelease(f.output), /Unlisted release entry/); await rm(injectedEnv);
    const extra = path.join(f.output, '.next/server/injected.js'); await writeFile(extra, 'unexpected');
    await assert.rejects(verifyRelease(f.output), /Unlisted production output/); await rm(extra);
    const target = path.join(f.output, '.next/server/app.js'); await rm(target); await symlink(path.join(f.source, '.next/server/app.js'), target);
    await assert.rejects(verifyRelease(f.output), /symbolic links/); await rm(target); await writeFile(target, '// synthetic build bytes');
    const wrong = JSON.parse(original); wrong.platform = 'other'; await writeFile(file, JSON.stringify(wrong));
    await assert.rejects(verifyRelease(f.output), /OS, architecture/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
