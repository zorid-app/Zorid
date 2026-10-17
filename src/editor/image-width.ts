/** Source labels use an optional final integer width[xheight] segment. Keep
 * descriptive labels and unrelated Markdown untouched when changing that size. */
export function imageWidthLabel(label: string, width: number | null, kind: 'wiki' | 'markdown' = 'wiki'): string | undefined {
  if (width !== null && (!Number.isSafeInteger(width) || width < 1)) return undefined;
  const split = label.lastIndexOf('|');
  const size = /^\s*\d+(?:\s*x\s*\d+)?\s*$/.test(label.slice(split + 1));
  const description = size ? (split < 0 ? '' : label.slice(0, split)) : label;
  if (width === null) {
    if (!size) return label;
    if (kind === 'markdown' && split >= 0) {
      // A backslash that escaped the removed pipe must be removed with it.
      // Keep paired backslashes: they encode literal backslashes in the alt.
      let escapes = 0;
      for (let index = description.length - 1; index >= 0 && description[index] === '\\'; index--) escapes++;
      if (escapes % 2) return description.slice(0, -1);
    }
    return description;
  }
  return description ? `${description}|${width}` : String(width);
}
