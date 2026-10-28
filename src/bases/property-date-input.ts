/** Native date controls normalize some valid ISO spellings and reject precision
 * that our saved values support. Use them only when the exact source survives
 * assignment; opening an editor must never become an implicit property edit. */
export function configureBaseDateInput(input: HTMLInputElement, raw: string, datetime: boolean): void {
  input.type = datetime ? 'datetime-local' : 'date';
  input.step = 'any';
  input.value = raw;
  if (input.value !== raw) {
    input.type = 'text';
    input.value = raw;
  }
}
