#!/usr/bin/env node
// All source/artifact freeze and owned-app guards remain in the common runner.
import {fileURLToPath} from 'node:url';
if (process.argv.includes('--campaign-module')) throw new Error('Safety wrapper owns --campaign-module');
process.argv.push('--campaign-module', fileURLToPath(new URL('./campaign.mjs', import.meta.url)));
await import('../bases-electron-integration/run.mjs');
