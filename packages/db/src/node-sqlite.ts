import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IndexedFileRecord } from '@zorid/index-api';
import { normalizeVaultPath, type VaultPath } from '@zorid/shared';
import { type IndexStore, indexMigrations, parseJsonRecord, serializeJson } from './index.js';

interface FileRow {
  path: string;
  text: string;
  frontmatter_json: string;
  fields_json: string;
}
interface ValueRow {
  value: string;
}
interface FtsSearchRow {
  path: string;
  score: number;
  snippet: string;
}

export interface FullTextSearchHit {
  readonly path: VaultPath;
  readonly score: number;
  readonly snippet: string;
}

export interface NodeSqliteIndexStoreOptions {
  readonly path: string;
  readonly pragmas?: boolean;
}

export class NodeSqliteIndexStore implements IndexStore {
  readonly database: DatabaseSync;

  constructor(options: NodeSqliteIndexStoreOptions | string = ':memory:') {
    const dbPath = typeof options === 'string' ? options : options.path;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.database = new DatabaseSync(dbPath);
    const pragmas = typeof options === 'string' ? true : options.pragmas !== false;
    if (pragmas) this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  migrate(): void {
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, applied_at_ms INTEGER NOT NULL)',
    );
    for (const migration of indexMigrations) {
      const applied = this.database.prepare('SELECT 1 AS value FROM schema_migrations WHERE id = ?').get(migration.id);
      if (applied) continue;
      this.database.exec(migration.sql);
      this.database
        .prepare('INSERT OR IGNORE INTO schema_migrations(id, applied_at_ms) VALUES (?, ?)')
        .run(migration.id, Date.now());
    }
  }

  transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  replaceAll(records: readonly IndexedFileRecord[]): void {
    this.transaction(() => {
      this.database.exec(
        'DELETE FROM search_fts; DELETE FROM headings; DELETE FROM tags; DELETE FROM links; DELETE FROM files;',
      );
      for (const record of records) this.upsert(record);
    });
  }

  upsert(record: IndexedFileRecord): void {
    this.transaction(() => {
      this.delete(record.path);
      this.database
        .prepare('INSERT INTO files(path, text, frontmatter_json, fields_json) VALUES (?, ?, ?, ?)')
        .run(record.path, record.text, serializeJson(record.frontmatter), serializeJson(record.fields));
      const insertLink = this.database.prepare('INSERT INTO links(from_path, to_path) VALUES (?, ?)');
      for (const link of record.links) insertLink.run(record.path, link);
      const insertTag = this.database.prepare('INSERT INTO tags(path, tag) VALUES (?, ?)');
      for (const tag of record.tags) insertTag.run(record.path, tag);
      const insertHeading = this.database.prepare('INSERT INTO headings(path, heading) VALUES (?, ?)');
      for (const heading of record.headings) insertHeading.run(record.path, heading);
      this.database
        .prepare('INSERT INTO search_fts(path, text, headings, tags) VALUES (?, ?, ?, ?)')
        .run(record.path, record.text, record.headings.join(' '), record.tags.join(' '));
    });
  }

  delete(vaultPath: VaultPath): void {
    this.database.prepare('DELETE FROM search_fts WHERE path = ?').run(vaultPath);
    this.database.prepare('DELETE FROM headings WHERE path = ?').run(vaultPath);
    this.database.prepare('DELETE FROM tags WHERE path = ?').run(vaultPath);
    this.database.prepare('DELETE FROM links WHERE from_path = ?').run(vaultPath);
    this.database.prepare('DELETE FROM files WHERE path = ?').run(vaultPath);
  }

  get(vaultPath: VaultPath): IndexedFileRecord | undefined {
    const row = this.database
      .prepare('SELECT path, text, frontmatter_json, fields_json FROM files WHERE path = ?')
      .get(vaultPath) as FileRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  all(): readonly IndexedFileRecord[] {
    const rows = [
      ...this.database.prepare('SELECT path, text, frontmatter_json, fields_json FROM files ORDER BY path').iterate(),
    ] as unknown as FileRow[];
    return rows.map((row) => this.hydrate(row));
  }

  dispose(): void {
    if (this.database.isOpen) this.database.close();
  }

  hydrate(row: FileRow): IndexedFileRecord {
    return {
      path: normalizeVaultPath(row.path),
      text: row.text,
      frontmatter: parseJsonRecord(row.frontmatter_json),
      fields: parseJsonRecord(row.fields_json),
      links: this.values('SELECT to_path AS value FROM links WHERE from_path = ? ORDER BY to_path', row.path).map(
        normalizeVaultPath,
      ),
      tags: this.values('SELECT tag AS value FROM tags WHERE path = ? ORDER BY tag', row.path),
      headings: this.values('SELECT heading AS value FROM headings WHERE path = ? ORDER BY rowid', row.path),
    };
  }

  values(sql: string, bind: string): string[] {
    return ([...this.database.prepare(sql).iterate(bind)] as unknown as ValueRow[]).map((row) => row.value);
  }

  searchFullText(query: string, options: { readonly limit?: number } = {}): readonly FullTextSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = clampLimit(options.limit ?? 50);
    const rows = [
      ...this.database
        .prepare(
          `SELECT
             path,
             bm25(search_fts, 1.2, 1.0, 0.8, 0.8) AS score,
             snippet(search_fts, -1, '', '', ' … ', 24) AS snippet
           FROM search_fts
           WHERE search_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .iterate(ftsQuery, limit),
    ] as unknown as FtsSearchRow[];
    return rows.map((row) => ({
      path: normalizeVaultPath(row.path),
      score: row.score,
      snippet: row.snippet,
    }));
  }
}

export function createNodeSqliteIndexStore(
  options: NodeSqliteIndexStoreOptions | string = ':memory:',
): NodeSqliteIndexStore {
  return new NodeSqliteIndexStore(options);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function toFtsQuery(rawQuery: string): string | null {
  const normalized = rawQuery.trim().replace(/^#+/, '');
  if (!normalized) return null;
  const tokens = [...normalized.matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((match) => match[0] ?? '')
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}
