import type { JsonValue, VaultPath } from '@zorid/shared';

export interface IndexFileInput {
  readonly path: VaultPath;
  readonly contents: string;
}
export interface IndexedFileRecord {
  readonly path: VaultPath;
  readonly text: string;
  readonly frontmatter: Readonly<Record<string, JsonValue>>;
  readonly headings: readonly string[];
  readonly links: readonly VaultPath[];
  readonly tags: readonly string[];
  readonly fields: Readonly<Record<string, JsonValue>>;
}
export interface IndexFilesInput {
  readonly files: readonly IndexFileInput[];
}
export interface IndexFilesOutput {
  readonly records: readonly IndexedFileRecord[];
  readonly diagnostics: readonly IndexDiagnostic[];
}
export interface IndexDiagnostic {
  readonly path: VaultPath;
  readonly code: string;
  readonly message: string;
}
export interface IndexEngine {
  indexFiles(input: IndexFilesInput): Promise<IndexFilesOutput>;
}
export interface IndexScheduler {
  rebuild(files: readonly IndexFileInput[]): Promise<IndexFilesOutput>;
  update(file: IndexFileInput): Promise<IndexFilesOutput>;
}
