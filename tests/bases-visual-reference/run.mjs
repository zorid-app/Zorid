#!/usr/bin/env node
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
assert.ok(!process.argv.includes('--campaign-module'),'Visual entrypoint owns its explicit campaign module');
assert.ok(process.argv.includes('--reference'),'Explicit retained reference capture directory required');
process.argv.push('--campaign-module',fileURLToPath(new URL('./campaign.mjs',import.meta.url)));
await import('../bases-electron-integration/run.mjs');
