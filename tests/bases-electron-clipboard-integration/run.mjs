#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const campaign=fileURLToPath(new URL('./campaign.mjs',import.meta.url));
if(process.argv.includes('--campaign-module'))throw Error('This wrapper owns the clipboard campaign module.');
process.argv.push('--campaign-module',path.resolve(campaign));
await import('../bases-electron-integration/run.mjs');
