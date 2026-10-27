// Read-only, bounded macOS process accounting for disposable shell benchmarks.
// A sum of ri_phys_footprint is kernel-accounted footprint, not a deduplicated
// physical-page union. Responsible-PID membership does not prove exclusive use
// of a shared service; equal common-launcher responsibility is NOT attribution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const source = fileURLToPath(new URL('./memory-probe.c', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let prepared;
async function prepare() {
  if (process.platform !== 'darwin') throw new Error('memory-metrics requires macOS');
  return prepared ??= (async () => {
    const sourceBytes = await fs.readFile(source);
    const directory = await fs.mkdtemp('/private/tmp/zorid-tauri-memory-probe-');
    const binary = path.join(directory, 'memory-probe');
    await execute('/usr/bin/xcrun', ['clang', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', source, '-o', binary],
      { timeout: 30000, maxBuffer: 512 * 1024 });
    return { binary, source, sourceSha256: hash(sourceBytes), binarySha256: hash(await fs.readFile(binary)),
      accounting: 'proc_pid_rusage RUSAGE_INFO_V4: ri_phys_footprint and ri_resident_size',
      responsibility: 'optional private dlsym responsibility_get_pid_responsible_for_pid; no task ports or process mutation' };
  })();
}

export async function probeMetadata() { return { ...await prepare() }; }

export async function sampleProcesses(pids) {
  if (!Array.isArray(pids) || pids.length > 4096 || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647))
    throw new Error('Explicit positive PID array required (maximum4096)');
  const unique = [...new Set(pids)];
  if (!unique.length) return [];
  const { binary } = await prepare();
  const { stdout } = await execute(binary, unique.map(String), { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length !== unique.length || rows.some((row, index) => row.pid !== unique[index]))
    throw new Error('Invalid memory-probe response');
  return rows;
}
