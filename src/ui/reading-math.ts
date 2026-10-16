import { renderMath, type MathRenderHandle, type MathRenderOptions } from './math-renderer.ts';

/** Reading sections and live table cells are built while detached, so ownership
 * is explicit: their host disposes the subtree before replacing/removing it. */
export function createReadingMathRenderer(renderer: typeof renderMath = renderMath) {
  const renders = new WeakMap<Element, MathRenderHandle>();
  function renderReadingMath(parent: HTMLElement, source: string, options: MathRenderOptions = {}): MathRenderHandle {
    renders.get(parent)?.dispose();
    const rendered = renderer(parent, source, options);
    const handle: MathRenderHandle = {
      ready: rendered.ready,
      dispose() {
        rendered.dispose();
        if (renders.get(parent) === handle) renders.delete(parent);
      },
    };
    renders.set(parent, handle);
    return handle;
  }
  function destroyMathRenders(container: ParentNode): void {
    // Include the root for embedded math and cells passed directly by a host.
    if (container.nodeType === 1) renders.get(container as Element)?.dispose();
    for (const element of container.querySelectorAll('.math')) renders.get(element)?.dispose();
  }
  return { renderReadingMath, destroyMathRenders };
}

export const { renderReadingMath, destroyMathRenders } = createReadingMathRenderer();
