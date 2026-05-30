import type { IndexedFileRecord } from '@zorid/index-api';
import type { Disposable, JsonValue, VaultPath } from '@zorid/shared';

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const indexMigrations: readonly Migration[] = [
  {
    id: '001-index-schema',
    sql: `CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, applied_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, text TEXT NOT NULL, frontmatter_json TEXT NOT NULL, fields_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links(from_path TEXT NOT NULL, to_path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_links_to_path ON links(to_path);
CREATE TABLE IF NOT EXISTS tags(path TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS headings(path TEXT NOT NULL, heading TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(path UNINDEXED, text);`,
  },
  {
    id: '002-search-fts-expanded-corpus',
    sql: `DROP TABLE IF EXISTS search_fts;
CREATE VIRTUAL TABLE search_fts USING fts5(path, text, headings, tags);
INSERT INTO search_fts(path, text, headings, tags)
SELECT
  files.path,
  files.text,
  COALESCE((SELECT group_concat(heading, ' ') FROM headings WHERE headings.path = files.path), ''),
  COALESCE((SELECT group_concat(tag, ' ') FROM tags WHERE tags.path = files.path), '')
FROM files;`,
  },
];

export interface IndexReader {
  get(path: VaultPath): IndexedFileRecord | undefined;
  all(): readonly IndexedFileRecord[];
}

export interface IndexWriter {
  replaceAll(records: readonly IndexedFileRecord[]): void;
  upsert(record: IndexedFileRecord): void;
  delete(path: VaultPath): void;
}

export interface IndexStore extends IndexReader, IndexWriter, Disposable {
  transaction<T>(operation: () => T): T;
}

export function serializeJson(value: JsonValue | Readonly<Record<string, JsonValue>>): string {
  return JSON.stringify(value);
}

export function parseJsonRecord(value: string): Readonly<Record<string, JsonValue>> {
  return JSON.parse(value) as Readonly<Record<string, JsonValue>>;
}

export class InMemoryIndexStore implements IndexStore {
  #records = new Map<VaultPath, IndexedFileRecord>();
  transaction<T>(operation: () => T): T {
    return operation();
  }
  replaceAll(records: readonly IndexedFileRecord[]): void {
    this.#records = new Map(records.map((record) => [record.path, record]));
  }
  upsert(record: IndexedFileRecord): void {
    this.#records.set(record.path, record);
  }
  delete(path: VaultPath): void {
    this.#records.delete(path);
  }
  get(path: VaultPath): IndexedFileRecord | undefined {
    return this.#records.get(path);
  }
  all(): readonly IndexedFileRecord[] {
    return [...this.#records.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }
  dispose(): void {
    this.#records.clear();
  }
}
