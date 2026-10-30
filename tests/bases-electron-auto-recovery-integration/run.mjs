#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
if(process.argv.includes('--campaign-module'))throw new Error('Automatic recovery wrapper owns --campaign-module');
process.argv.push('--campaign-module',fileURLToPath(new URL('./campaign.mjs',import.meta.url)));
await import('../bases-electron-integration/run.mjs');
