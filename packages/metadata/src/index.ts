import type { IndexedFileRecord } from '@zorid/index-api';
import type {
  FileMetadata,
  LinkRecord,
  MetadataAPI,
  SearchAPI,
  SearchOptions,
  SearchResult,
  TagRecord,
} from '@zorid/platform-api';
import type { VaultPath } from '@zorid/shared';

export interface MetadataIndexReader {
  get(path: VaultPath): IndexedFileRecord | undefined;
  all(): readonly IndexedFileRecord[];
}

export class MetadataService implements MetadataAPI {
  #store: MetadataIndexReader;
  constructor(store: MetadataIndexReader) {
    this.#store = store;
  }
  async getFile(path: VaultPath): Promise<FileMetadata | undefined> {
    const record = this.#store.get(path);
    return (
      record && { path: record.path, frontmatter: record.frontmatter, headings: record.headings, tags: record.tags }
    );
  }
  async backlinks(path: VaultPath): Promise<readonly LinkRecord[]> {
    return this.#store
      .all()
      .flatMap((record) => (record.links.includes(path) ? [{ from: record.path, to: path }] : []));
  }
  async tags(): Promise<readonly TagRecord[]> {
    const counts = new Map<string, number>();
    for (const record of this.#store.all()) for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }
}

export class SearchService implements SearchAPI {
  #store: MetadataIndexReader;
  constructor(store: MetadataIndexReader) {
    this.#store = store;
  }
  async search(query: string, options: SearchOptions = {}): Promise<readonly SearchResult[]> {
    const q = query.toLowerCase();
    return this.#store
      .all()
      .filter((record) => record.text.toLowerCase().includes(q) || String(record.path).toLowerCase().includes(q))
      .slice(0, options.limit ?? 50)
      .map((record) => ({
        path: record.path,
        score: record.text.toLowerCase().includes(q) ? 10 : 1,
        snippet: record.text.slice(0, 160),
      }));
  }
}

export function createMetadataService(store: MetadataIndexReader): MetadataService {
  return new MetadataService(store);
}
export function createSearchService(store: MetadataIndexReader): SearchService {
  return new SearchService(store);
}
