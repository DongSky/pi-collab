#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { isNodeVersionSupported, getUnsupportedNodeVersionMessage } = require('./node-version');
if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}
const child = spawn(process.execPath, ['--import', require.resolve('tsx'), path.join(__dirname, '../scripts/pi-launcher.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
