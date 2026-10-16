import type { VaultEntry } from '../core/types.ts';
import { isImage } from './attachments.ts';
import { mediaKind } from './media-view.ts';

/** Recognition is presentation policy, not a promise of a complete file viewer. */
export function fileTreeLabel(entry: Pick<VaultEntry, 'path' | 'type'>): string {
  const filename = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  if (entry.type === 'folder') return filename;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return filename;
  const extension = filename.slice(dot + 1).toLowerCase();
  const recognized = extension === 'md' || extension === 'pdf' || extension === 'canvas' || extension === 'base'
    || isImage(entry.path) || mediaKind(entry.path) !== null;
  return recognized ? filename.slice(0, dot) : filename;
}
