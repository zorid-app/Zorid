#!/usr/bin/env node
// Uses the normal owned app/native launch, freeze, evidence and cleanup path.
import {fileURLToPath} from 'node:url';
process.argv.push('--campaign-module',fileURLToPath(new URL('./campaign.mjs',import.meta.url)),'--show-window');
await import('../bases-electron-integration/run.mjs');
