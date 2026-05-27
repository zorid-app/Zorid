import type { IndexEngine, IndexFileInput, IndexFilesOutput, IndexScheduler } from '@zorid/index-api';

export class InlineIndexScheduler implements IndexScheduler {
  #engine: IndexEngine;
  constructor(engine: IndexEngine) { this.#engine = engine; }
  rebuild(files: readonly IndexFileInput[]): Promise<IndexFilesOutput> { return this.#engine.indexFiles({ files }); }
  update(file: IndexFileInput): Promise<IndexFilesOutput> { return this.#engine.indexFiles({ files: [file] }); }
}
