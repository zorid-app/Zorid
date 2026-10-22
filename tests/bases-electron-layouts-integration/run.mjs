#!/usr/bin/env node
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
assert.ok(!process.argv.includes('--campaign-module'), 'The layouts entrypoint owns its campaign module');
process.argv.push('--campaign-module', fileURLToPath(new URL('./campaign.mjs', import.meta.url)));
await import('../bases-electron-integration/run.mjs');
