import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const exec = promisify(execFile);
const manifestName = 'release-manifest.json';
const sourceRoots = ['app', 'components', 'hooks', 'lib', 'scripts', 'db', 'public', 'bin', 'extensions', 'deploy', 'containers', 'docs'];
const sourceFiles = ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'proxy.ts', 'LICENSE'];
const required = ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'scripts/package.json', 'scripts/dev-local.ts', 'scripts/release.mjs', 'lib/collab/runtime/service-runner.mjs', '.next/BUILD_ID', '.next/required-server-files.json', '.next/routes-manifest.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const excludedBuild = name => /^\.next\/(?:dev|cache|diagnostics)(?:\/|$)/.test(name) || /^\.next\/trace[^/]*(?:\/|$)/.test(name);
function safeName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0') && !path.posix.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
}
function allowed(name) {
  return safeName(name) && !name.split('/').some(part => part.startsWith('.env') || part === '.local' || part === 'node_modules') &&
    (sourceFiles.includes(name) || sourceRoots.some(root => name.startsWith(root + '/')) || (name.startsWith('.next/') && !excludedBuild(name)));
}
async function bytesAt(root, name) {
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Release cannot contain symbolic links');
  }
  const stat = await lstat(cursor);
  if (!stat.isFile()) throw new Error('Release requires regular files');
  return { bytes: await readFile(cursor), executable: !!(stat.mode & 0o111) };
}
async function buildFiles(root, prefix = '.next') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`;
    if (excludedBuild(name)) continue;
    if (entry.isDirectory()) files.push(...await buildFiles(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('Build contains a link or special file');
  }
  return files;
}
async function createDestination(source, destination) {
  source = await realpath(source);
  destination = path.resolve(destination);
  const parent = await realpath(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  const rel = path.relative(source, destination);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('Release destination must be outside its source');
  // Exclusive creation: never overwrite a previous release or existing data.
  await mkdir(destination, { mode: 0o700 });
  return destination;
}
async function put(root, name, bytes, executable) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, name), bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
}

/** Package an already built, clean checkout. This command never runs a build. */
export async function packRelease(source, output) {
  source = await realpath(source);
  const gitRoot = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: source })).stdout.trim();
  if (await realpath(gitRoot) !== source) throw new Error('Package from the checkout root');
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  await exec('git', ['diff', '--quiet', 'HEAD', '--', ...sourceRoots, ...sourceFiles], { cwd: source });
  const tracked = (await exec('git', ['ls-files', '-z'], { cwd: source, maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(name => name && allowed(name));
  const files = [...tracked, ...await buildFiles(source)].sort();
  for (const file of required) if (!files.includes(file)) throw new Error('Release is missing required source or production output: ' + file);
  if (!(await readFile(path.join(source, '.next/BUILD_ID'), 'utf8')).trim()) throw new Error('Production BUILD_ID is empty');
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'pi-collab') throw new Error('Unexpected release package');
  const destination = await createDestination(source, output);
  try {
    const entries = [];
    for (const file of files) {
      const { bytes, executable } = await bytesAt(source, file);
      await put(destination, file, bytes, executable);
      entries.push({ path: file, bytes: bytes.length, sha256: digest(bytes), executable });
    }
    const manifest = { version: 1, product: 'pi-collab', packageVersion: pkg.version, commit, platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), createdAt: new Date().toISOString(), files: entries };
    await put(destination, manifestName, JSON.stringify(manifest, null, 2) + '\n', false);
    await verifyRelease(destination);
    return manifest;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

/** Integrity checking is not a signature: accept packages only from a trusted build. */
export async function verifyRelease(root = process.cwd()) {
  root = await realpath(root);
  const manifest = JSON.parse((await bytesAt(root, manifestName)).bytes.toString());
  if (manifest.version !== 1 || manifest.product !== 'pi-collab' || !/^[a-f0-9]{40,64}$/.test(manifest.commit) || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw new Error('Invalid release manifest');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.nodeMajor !== Number(process.versions.node.split('.')[0])) throw new Error('Release requires the build host OS, architecture and Node major version');
  const names = new Set();
  for (const file of manifest.files) {
    if (!allowed(file.path) || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean') throw new Error('Invalid release file entry');
    names.add(file.path);
    const { bytes } = await bytesAt(root, file.path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Release integrity mismatch: ' + file.path);
  }
  for (const file of required) if (!names.has(file)) throw new Error('Incomplete release: ' + file);
  // A private env file belongs outside the release, loaded with --env-file.
  for (const entry of await readdir(root)) {
    if (entry === manifestName || entry === 'node_modules' || entry === '.next') continue;
    if (!names.has(entry) && ![...names].some(name => name.startsWith(entry + '/'))) throw new Error('Unlisted release entry: ' + entry);
  }
  for (const dir of sourceRoots) {
    if (![...names].some(name => name.startsWith(dir + '/'))) continue;
    for (const file of await buildFiles(root, dir)) if (!names.has(file)) throw new Error('Unlisted release source: ' + file);
  }
  // Additional executable build output must not silently join a verified artifact.
  for (const file of await buildFiles(root)) if (!names.has(file)) throw new Error('Unlisted production output: ' + file);
  return manifest;
}

/** Install into a fresh directory; failed dependency installation leaves no partial release. */
export async function installRelease(source, output) {
  source = await realpath(source);
  const manifest = await verifyRelease(source);
  const destination = await createDestination(source, output);
  try {
    for (const file of manifest.files) {
      const { bytes } = await bytesAt(source, file.path);
      if (digest(bytes) !== file.sha256) throw new Error('Release changed during installation');
      await put(destination, file.path, bytes, file.executable);
    }
    await put(destination, manifestName, JSON.stringify(manifest, null, 2) + '\n', false);
    const code = await new Promise((resolve, reject) => {
      const child = spawn('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: destination, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, CI: '1' }, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', value => resolve(value));
    });
    if (code !== 0) throw new Error('Release dependency installation failed');
    await verifyRelease(destination);
    return manifest;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { source: { type: 'string' }, output: { type: 'string' } } });
    const source = values.source ?? process.cwd();
    let manifest;
    if (positionals[0] === 'verify') manifest = await verifyRelease(source);
    else if (['pack', 'install'].includes(positionals[0]) && values.output) manifest = await (positionals[0] === 'pack' ? packRelease : installRelease)(source, values.output);
    else throw new Error('Usage: release.mjs pack|install --output NEW_DIRECTORY [--source DIRECTORY], or verify [--source DIRECTORY]');
    console.log(JSON.stringify({ operation: positionals[0], commit: manifest.commit, version: manifest.packageVersion, platform: manifest.platform, arch: manifest.arch, files: manifest.files.length }));
  } catch (error) {
    // npm errors print separately; never dump child process environments or buffers.
    console.error(error instanceof Error ? error.message.split('\n')[0] : 'Release operation failed'); process.exitCode = 1;
  }
}
