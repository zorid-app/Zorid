import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { LivePreviewRenderer } from '../packages/editor/src';
import { collectLivePreviewRanges, createLivePreviewContext } from '../packages/editor/src/live-preview/extension';

describe('editor live preview error handling', () => {
  it('drops a throwing renderer range and reports the renderer context', () => {
    const renderer: LivePreviewRenderer = {
      id: 'throwing-renderer',
      match: () => {
        throw new Error('renderer boom');
      },
    };
    const errors: unknown[] = [];
    const state = EditorState.create({ doc: '- [ ] task' });

    const ranges = collectLivePreviewRanges(
      [renderer],
      createLivePreviewContext(state, { from: 0, to: state.doc.length }),
      (error, context) => errors.push({ error, context }),
    );

    expect(ranges).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ context: { rendererId: 'throwing-renderer', phase: 'match' } });
  });
});
