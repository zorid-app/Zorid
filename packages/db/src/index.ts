import type { VaultPath } from '@zorid/shared';
import type { IndexedFileRecord } from '@zorid/index-api';

export interface Migration { readonly id: string; readonly sql: string; }
export const indexMigrations: readonly Migration[] = [{ id: '001-index-schema', sql: `CREATE TABLE files(path TEXT PRIMARY KEY, text TEXT, frontmatter_json TEXT);\nCREATE TABLE links(from_path TEXT, to_path TEXT);\nCREATE TABLE tags(path TEXT, tag TEXT);\nCREATE TABLE headings(path TEXT, heading TEXT);\nCREATE VIRTUAL TABLE search_fts USING fts5(path, text);` }];

export class InMemoryIndexStore {
  #records = new Map<VaultPath, IndexedFileRecord>();
  replaceAll(records: readonly IndexedFileRecord[]): void { this.#records = new Map(records.map((record) => [record.path, record])); }
  upsert(record: IndexedFileRecord): void { this.#records.set(record.path, record); }
  delete(path: VaultPath): void { this.#records.delete(path); }
  get(path: VaultPath): IndexedFileRecord | undefined { return this.#records.get(path); }
  all(): readonly IndexedFileRecord[] { return [...this.#records.values()].sort((a,b)=>String(a.path).localeCompare(String(b.path))); }
}
