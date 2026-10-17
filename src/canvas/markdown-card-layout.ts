import { markdownLanguage } from '@codemirror/lang-markdown';

/** Match source line geometry for ordinary prose cards without changing the
 * shared renderer or any editor transactions. Rich block widgets retain their
 * own layout; never guess a source-to-DOM mapping for them. */
export function applyCanvasProseLayout(preview: HTMLElement, source: string): void {
  preview.classList.remove('has-source-prose-layout');
  preview.style.removeProperty('--canvas-trailing-lines');
  const text = source.replace(/\r\n?/g, '\n');
  const blocks = [];
  for (let node = markdownLanguage.parser.parse(text).topNode.firstChild; node; node = node.nextSibling) blocks.push(node);
  const children = [...preview.children] as HTMLElement[];
  if (!blocks.length || blocks.length !== children.length) return;
  if (blocks.some((block, index) => {
    const expected = block.name === 'Paragraph' ? 'P' : /^ATXHeading[1-6]$/.test(block.name) ? `H${block.name.slice(-1)}` : '';
    // Inline code, comments and link destinations can collapse source newlines.
    // Use rendered breaks (including hard-break BRs), not guessed syntax rules.
    const sourceBreaks = (text.slice(block.from, block.to).match(/\n/g) ?? []).length;
    const renderedText = children[index].textContent ?? '';
    const hardBreaks = children[index].querySelectorAll('br').length;
    const renderedBreaks = (renderedText.match(/\n/g) ?? []).length + hardBreaks;
    // A paragraph containing a replaced embed or display widget is not prose.
    return !expected || children[index].tagName !== expected || (!renderedText.trim() && !hardBreaks) || sourceBreaks !== renderedBreaks
      || children[index].querySelector('.internal-embed,.math-block');
  })) return;
  let previousEnd = 0;
  for (const [index, block] of blocks.entries()) {
    const breaks = (text.slice(previousEnd, block.from).match(/\n/g) ?? []).length;
    children[index].style.setProperty('--canvas-blank-lines', String(Math.max(0, breaks - (index ? 1 : 0))));
    children[index].classList.toggle('is-first-source-line', index === 0 && breaks === 0);
    previousEnd = block.to;
  }
  preview.style.setProperty('--canvas-trailing-lines', String((text.slice(previousEnd).match(/\n/g) ?? []).length));
  preview.classList.add('has-source-prose-layout');
}
