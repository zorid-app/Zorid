import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { VaultProfile } from '@zorid/platform-api';

export interface RecentVaultDto {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
}

interface RecentVaultRecord extends RecentVaultDto {
  readonly normalizedPath: string;
}

interface RecentVaultFile {
  readonly version: 1;
  readonly entries: readonly RecentVaultRecord[];
}

export interface RecentVaultStoreOptions {
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

const recentVaultFileVersion = 1;
const defaultMaxEntries = 12;

function isRecord(value: unknown): value is RecentVaultRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.path === 'string'
    && typeof candidate.normalizedPath === 'string'
    && typeof candidate.lastOpenedAt === 'string';
}

function isRecentVaultFile(value: unknown): value is RecentVaultFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === recentVaultFileVersion
    && Array.isArray(candidate.entries)
    && candidate.entries.every(isRecord);
}

function recentVaultId(normalizedPath: string): string {
  const digest = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 20);
  return `recent:${digest}`;
}

function displayNameFor(root: string): string {
  return path.basename(root) || root;
}

async function normalizeRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export class RecentVaultStore {
  readonly #filePath: string;
  readonly #maxEntries: number;
  readonly #now: () => Date;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: RecentVaultStoreOptions = {}) {
    this.#filePath = filePath;
    this.#maxEntries = options.maxEntries ?? defaultMaxEntries;
    this.#now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly RecentVaultDto[]> {
    await this.#writeQueue.catch(() => undefined);
    const file = await this.#readFile();
    return file.entries.map(({ id, name, path: displayPath, lastOpenedAt }) => ({ id, name, path: displayPath, lastOpenedAt }));
  }

  async record(root: string): Promise<RecentVaultDto> {
    return this.#enqueueWrite(async () => {
      const normalizedPath = await normalizeRoot(root);
      const id = recentVaultId(normalizedPath);
      const entry: RecentVaultRecord = {
        id,
        name: displayNameFor(normalizedPath),
        path: normalizedPath,
        normalizedPath,
        lastOpenedAt: this.#now().toISOString(),
      };
      const file = await this.#readFile();
      const entries = [entry, ...file.entries.filter((candidate) => candidate.id !== id)].slice(0, this.#maxEntries);
      await this.#writeFile({ version: recentVaultFileVersion, entries });
      return { id: entry.id, name: entry.name, path: entry.path, lastOpenedAt: entry.lastOpenedAt };
    });
  }

  async resolve(id: string): Promise<string | undefined> {
    await this.#writeQueue.catch(() => undefined);
    const file = await this.#readFile();
    return file.entries.find((entry) => entry.id === id)?.normalizedPath;
  }

  async #enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writeQueue.catch(() => undefined).then(task);
    this.#writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #readFile(): Promise<RecentVaultFile> {
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecentVaultFile(parsed)) return parsed;
    } catch {
      // Missing, unreadable, and malformed recent stores are treated as empty.
    }
    return { version: recentVaultFileVersion, entries: [] };
  }

  async #writeFile(file: RecentVaultFile): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.#filePath);
  }
}

export function createRecentVaultStore(userDataPath: string): RecentVaultStore {
  return new RecentVaultStore(path.join(userDataPath, 'recent-vaults.json'));
}


export interface RecentVaultOpenRuntime {
  openVault(root: string): Promise<VaultProfile>;
}

export interface RecentVaultResolver {
  resolve(id: string): Promise<string | undefined>;
  record(root: string): Promise<RecentVaultDto>;
}

export async function openRecentVault(
  id: string,
  runtime: RecentVaultOpenRuntime,
  store: RecentVaultResolver,
): Promise<VaultProfile> {
  const root = await store.resolve(id);
  if (!root) throw new Error('Recent vault not found.');
  const profile = await runtime.openVault(root);
  await store.record(root);
  return profile;
}
