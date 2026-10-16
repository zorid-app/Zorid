import { destroyCalloutPresentations } from './callout-presentation.ts';
import { destroyCodeBlocks } from './code-block.ts';
import { destroyMathRenders } from './reading-math.ts';

/** Dispose asynchronous renderers before replacing or detaching a Reading
 * pane, embed, callout or table cell. Construction may happen while detached,
 * so DOM connection alone cannot represent ownership. Safe to call repeatedly.
 */
export function destroyMarkdown(container: HTMLElement): void {
  destroyCalloutPresentations(container);
  destroyCodeBlocks(container);
  destroyMathRenders(container);
}
