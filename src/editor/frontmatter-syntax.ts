import type { markdown } from '@codemirror/lang-markdown';

type MarkdownExtension = NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>;

/** YAML owns its source before block Markdown can interpret literal property
 * values as open math/code fences. Visibility remains the property panel's
 * decision: invalid or incomplete metadata stays editable, never deleted. */
export const frontmatterMarkdown: MarkdownExtension = {
  defineNodes: [{ name: 'ZoridFrontmatter', block: true }],
  parseBlock: [{ name: 'ZoridFrontmatter', before: 'HorizontalRule', parse(context, line) {
    if (context.lineStart !== 0 || context.depth !== 1 || !/^\uFEFF?---[ \t]*(?:#[^\r\n]*)?$/.test(line.text)) return false;
    let to = line.text.length;
    while (context.nextLine()) {
      to = context.lineStart + line.text.length;
      if (/^(?:---|\.\.\.)[ \t]*(?:#[^\r\n]*)?$/.test(line.text)) { context.nextLine(); break; }
    }
    context.addElement(context.elt('ZoridFrontmatter', 0, to));
    return true;
  } }],
};
