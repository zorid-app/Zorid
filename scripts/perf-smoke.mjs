import { performance } from 'node:perf_hooks';

const itemCount = 10_000;
const start = performance.now();
const rows = Array.from({ length: itemCount }, (_, i) => ({ path: `Note-${i}.md`, title: `Note ${i}`, tag: i % 2 ? 'odd' : 'even' }));
const filtered = rows.filter((row) => row.tag === 'even' && row.title.includes('9'));
const durationMs = performance.now() - start;
const report = { itemCount, resultCount: filtered.length, durationMs: Number(durationMs.toFixed(2)), budgetMs: 200 };
console.log(JSON.stringify(report));
if (durationMs > report.budgetMs) process.exit(1);
