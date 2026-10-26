// Read only the public recovery region. A failed unrelated note may own its first
// row, so the action cannot be scoped with querySelector('.native-document-notice').
export function recoveryCopyNoticeFrame(document, file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').some(part => !part || part === '..')) return false;
  const scope = '.native-document-status[aria-label="Save and recovery notices"]';
  const regions = [...document.querySelectorAll(scope)];
  const visible = element => !!element?.isConnected && !!element.getClientRects().length && !element.closest('[hidden]');
  if (regions.length !== 1 || !visible(regions[0])) return false;
  const region = regions[0], name = file.split('/').at(-1).replace(/\.md$/i, '');
  const expected = `Retained draft for “${name}” needs attention.`;
  const rows = [...region.querySelectorAll('.native-document-notice')].filter(visible);
  const targets = rows.filter(row => row.querySelector('p')?.textContent === expected);
  const copies = [...region.querySelectorAll('button')].filter(button => visible(button) && button.textContent.trim() === 'Save recovery copy');
  if (targets.length !== 1 || copies.length !== 1 || !targets[0].contains(copies[0])) return false;
  const button = copies[0];
  if (button.matches(':disabled') || button.closest('[aria-disabled="true"],[inert]')) return false;
  return {scope, file, notice: expected, visibleNotices: rows.length, recoveryCopyActions: copies.length, observedAt: Date.now()};
}

export async function saveRecoveryCopyFor(c, file) {
  const frame = await c.ui.wait(`return (${recoveryCopyNoticeFrame.toString()})(document,${JSON.stringify(file)});`, 'One public recovery-copy action for the exact retained note ' + file);
  c.evidence.actions.push({action: 'owned-recovery-copy-notice', ...frame});
  // The normal locator still requires exactly one visible, enabled, unobscured
  // button. The stable parent scopes every row rather than only the first one.
  await c.ui.button('Save recovery copy', frame.scope);
}
