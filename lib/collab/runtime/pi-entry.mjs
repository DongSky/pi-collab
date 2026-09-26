import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const piEntry=path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),'bundle','cli.js');
