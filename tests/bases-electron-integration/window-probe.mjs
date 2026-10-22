#!/usr/bin/env node
// Harness-only visibility/normal-quit proof; never runs the product journey.
process.argv.push('--window-bootstrap-probe','--show-window');
await import('./run.mjs');
