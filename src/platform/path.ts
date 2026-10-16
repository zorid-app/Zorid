export function vaultPath(value: string, root = false): string {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('Invalid vault path');
  const parts = value.split('/');
  if (parts.some(part => part === '..' || part === '.')) throw new Error('Invalid vault path');
  const result = parts.filter(Boolean).join('/');
  if (!result && !root) throw new Error('A file or folder path is required');
  return result;
}
