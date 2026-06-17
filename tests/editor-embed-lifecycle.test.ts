// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import type { EditorEmbedOccurrence } from '../packages/editor/src/editor-embed-lifecycle';
import {
  collectMarkdownEmbedOccurrencesFromText,
  EditorEmbedLifecycle,
  markdownEmbedFallbackHeight,
  maxOffscreenAgeMs,
  maxRetainedEmbedHosts,
} from '../packages/editor/src/editor-embed-lifecycle';

function occurrence(target: string, sourceFrom: number, sourceText = `![[${target}]]`): EditorEmbedOccurrence {
  return {
    documentSessionKey: 'doc.md',
    kind: 'embed-reference',
    referenceSyntax: 'wikilink-embed',
    target,
    rendererIdentity: 'image-renderer',
    sourceFrom,
    sourceTo: sourceFrom + sourceText.length,
    sourceText,
  };
}

describe('editor-owned embed lifecycle', () => {
  it('keeps unchanged embeds mounted across cursor/selection-only placeholder refreshes', () => {
    const disposes: string[] = [];
    const mounts: string[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ occurrence }) => {
        mounts.push(`${occurrence.target}:${occurrence.sourceFrom}`);
        return { dispose: () => disposes.push(`${occurrence.target}:${occurrence.sourceFrom}`) };
      },
    });
    const image = occurrence('image.png', 0);

    lifecycle.reconcile([image], { visibleFrom: 0, visibleTo: 20 });
    expect(mounts).toEqual([]);

    const first = lifecycle.renderPlaceholder(image);
    const second = lifecycle.renderPlaceholder(image);

    expect(first).not.toBe(second);
    expect(mounts).toEqual(['image.png:0']);
    expect(disposes).toEqual([]);
    expect(second.querySelector('[data-editor-embed-host="true"]')).toBeTruthy();
  });

  it('maps source ranges before reconcile so unrelated edits before an embed do not remount it', () => {
    const mounts: number[] = [];
    const disposes: number[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ occurrence }) => {
        mounts.push(occurrence.sourceFrom);
        return { dispose: () => disposes.push(occurrence.sourceFrom) };
      },
    });
    const original = occurrence('image.png', 10);
    lifecycle.reconcile([original], { visibleFrom: 0, visibleTo: 30 });
    lifecycle.renderPlaceholder(original);

    lifecycle.mapSourceRanges({ mapPos: (position: number) => position + 5 });
    lifecycle.reconcile([occurrence('image.png', 15)], { visibleFrom: 0, visibleTo: 40 });

    expect(mounts).toEqual([10]);
    expect(disposes).toEqual([]);
  });

  it('mounts duplicate identical embeds independently and preserves shifted existing hosts when inserting before them', () => {
    const mounts: number[] = [];
    const disposes: number[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ occurrence }) => {
        mounts.push(occurrence.sourceFrom);
        return { dispose: () => disposes.push(occurrence.sourceFrom) };
      },
    });
    const originalOccurrences = [occurrence('image.png', 10), occurrence('image.png', 30)];
    lifecycle.reconcile(originalOccurrences, { visibleFrom: 0, visibleTo: 50 });
    for (const originalOccurrence of originalOccurrences) lifecycle.renderPlaceholder(originalOccurrence);

    const nextOccurrences = [occurrence('image.png', 0), occurrence('image.png', 30), occurrence('image.png', 50)];
    lifecycle.mapSourceRanges({ mapPos: (position: number) => position + 20 });
    lifecycle.reconcile(nextOccurrences, {
      visibleFrom: 0,
      visibleTo: 80,
    });
    lifecycle.renderPlaceholder(nextOccurrences[0]!);

    expect(mounts).toEqual([10, 30, 0]);
    expect(disposes).toEqual([]);
    expect(lifecycle.retainedHostCount).toBe(3);
  });

  it('disposes a deleted duplicate host and preserves the surviving shifted host', () => {
    const mounts: number[] = [];
    const disposes: number[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ occurrence }) => {
        mounts.push(occurrence.sourceFrom);
        return { dispose: () => disposes.push(occurrence.sourceFrom) };
      },
    });
    const first = occurrence('image.png', 0);
    const second = occurrence('image.png', first.sourceTo + 1);
    lifecycle.reconcile([first, second], { visibleFrom: 0, visibleTo: 50 });
    lifecycle.renderPlaceholder(first);
    const secondPlaceholder = lifecycle.renderPlaceholder(second);
    const secondHost = secondPlaceholder.querySelector('[data-editor-embed-host="true"]');

    lifecycle.mapSourceRanges({
      mapPos: (position: number) => {
        if (position <= first.sourceTo) return 0;
        return position - (first.sourceTo + 1);
      },
    });
    const shiftedSecond = occurrence('image.png', 0);
    lifecycle.reconcile([shiftedSecond], { visibleFrom: 0, visibleTo: 20 });
    const reconciledPlaceholder = lifecycle.renderPlaceholder(shiftedSecond);

    expect(mounts).toEqual([0, second.sourceFrom]);
    expect(disposes).toEqual([0]);
    expect(reconciledPlaceholder.querySelector('[data-editor-embed-host="true"]')).toBe(secondHost);
    expect(lifecycle.retainedHostCount).toBe(1);
  });

  it('reserves fallback height and coalesces measured height writes into one rAF requestMeasure', () => {
    const animationFrames: FrameRequestCallback[] = [];
    const requestMeasure = vi.fn();
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ host }) => {
        Object.defineProperty(host, 'offsetHeight', { configurable: true, value: 240 });
        return { dispose: () => undefined };
      },
      requestAnimationFrame: (callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
      cancelAnimationFrame: () => undefined,
    });
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver implements ResizeObserver {
      readonly disconnect = vi.fn();
      readonly observe = vi.fn();
      readonly unobserve = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
    }
    const originalResizeObserver = window.ResizeObserver;
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: TestResizeObserver });

    const placeholder = lifecycle.renderPlaceholder(occurrence('image.png', 0), { requestMeasure });
    resizeCallbacks[0]?.([], {} as ResizeObserver);
    resizeCallbacks[0]?.([], {} as ResizeObserver);

    expect(placeholder.style.minHeight).toBe(`${markdownEmbedFallbackHeight}px`);
    expect(animationFrames).toHaveLength(1);
    animationFrames[0]?.(0);
    expect(placeholder.style.minHeight).toBe('240px');
    expect(requestMeasure).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: originalResizeObserver });
  });

  it('keeps reconciliation side effects lazy until a live-preview placeholder renders', () => {
    const mounts: number[] = [];
    const disposes: number[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ occurrence }) => {
        mounts.push(occurrence.sourceFrom);
        return { dispose: () => disposes.push(occurrence.sourceFrom) };
      },
    });
    const occurrences = Array.from({ length: maxRetainedEmbedHosts + 2 }, (_, index) =>
      occurrence(`image-${index}.png`, index * 20),
    );

    lifecycle.reconcile(occurrences, { visibleFrom: 0, visibleTo: 200 });
    lifecycle.evictOffscreen({ visibleFrom: 1_000_000, visibleTo: 1_000_100 });

    expect(mounts).toEqual([]);
    expect(disposes).toEqual([]);

    lifecycle.renderPlaceholder(occurrences[0]!);

    expect(mounts).toEqual([0]);
  });

  it('matches occurrences by canonical embed identity when raw source text uses whitespace, alias, or fragment spelling', () => {
    const mounts: string[] = [];
    const disposes: string[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      mount: ({ occurrence }) => {
        mounts.push(
          `${occurrence.target}${occurrence.fragment ? `#${occurrence.fragment}` : ''}:${occurrence.sourceText}`,
        );
        return { dispose: () => disposes.push(occurrence.sourceText) };
      },
    });
    const rawWhitespaceAlias = occurrence('image.png', 0, '![[ image.png|Hero ]]');
    const canonicalWhitespaceAlias = occurrence('image.png', 0, '![[image.png]]');
    const rawFragmentAlias = { ...occurrence('image.png', 30, '![[ image.png#hero|Hero ]]'), fragment: 'hero' };
    const canonicalFragment = { ...occurrence('image.png', 30, '![[image.png#hero]]'), fragment: 'hero' };

    lifecycle.reconcile([rawWhitespaceAlias, rawFragmentAlias], { visibleFrom: 0, visibleTo: 80 });
    lifecycle.renderPlaceholder(rawWhitespaceAlias);
    lifecycle.renderPlaceholder(rawFragmentAlias);
    lifecycle.reconcile([canonicalWhitespaceAlias, canonicalFragment], { visibleFrom: 0, visibleTo: 80 });
    lifecycle.renderPlaceholder(canonicalWhitespaceAlias);
    lifecycle.renderPlaceholder(canonicalFragment);

    expect(mounts).toEqual(['image.png:![[ image.png|Hero ]]', 'image.png#hero:![[ image.png#hero|Hero ]]']);
    expect(disposes).toEqual([]);
  });

  it('evicts old offscreen hosts by named retention constants without evicting attached hosts', () => {
    let now = 0;
    const disposes: number[] = [];
    const lifecycle = new EditorEmbedLifecycle({
      now: () => now,
      mount: ({ occurrence }) => ({ dispose: () => disposes.push(occurrence.sourceFrom) }),
    });
    const occurrences = Array.from({ length: maxRetainedEmbedHosts + 2 }, (_, index) =>
      occurrence(`image-${index}.png`, index * 20),
    );
    document.body.append(lifecycle.renderPlaceholder(occurrences[0]!));
    lifecycle.reconcile(occurrences, { visibleFrom: 0, visibleTo: 10_000 });
    now = maxOffscreenAgeMs + 1;
    lifecycle.evictOffscreen({ visibleFrom: 1_000_000, visibleTo: 1_000_100 });

    expect(disposes).not.toContain(0);
    expect(lifecycle.retainedHostCount).toBeLessThanOrEqual(maxRetainedEmbedHosts + 1);
  });

  it('collects embed occurrence identities with target, fragment, syntax, renderer identity, session, and source range', () => {
    const occurrences = collectMarkdownEmbedOccurrencesFromText('![[image.png#frag]]\n![[image.png]]', {
      documentSessionKey: 'doc.md',
      rendererIdentityForTarget: (target) => (target === 'image.png' ? 'image-renderer' : undefined),
    });

    expect(occurrences).toMatchObject([
      {
        documentSessionKey: 'doc.md',
        kind: 'embed-reference',
        referenceSyntax: 'wikilink-embed',
        target: 'image.png',
        fragment: 'frag',
        rendererIdentity: 'image-renderer',
        sourceFrom: 0,
      },
      {
        target: 'image.png',
        rendererIdentity: 'image-renderer',
        sourceFrom: 20,
      },
    ]);
  });
});
