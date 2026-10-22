import type {BaseQueryRow} from './query.ts';

const ownerSelector='.zorid-bases-table-cell,.bases-cards-item,.bases-list-item,.bases-kanban-card';
const filenameSelector='[data-property="file.name"],[data-property="file.file"]';

/** Anchor a saved row's preview to its actual filename, rather than its cell or
 * card rectangle. Relation links and nested rows never stand in for that file. */
export function baseFileHoverAnchor(row:BaseQueryRow,event:MouseEvent):HTMLElement|undefined {
  const boundary=event.currentTarget;
  if(!boundary||typeof row.entryId!=='string'||!row.entryId||typeof row.revision!=='string'||!row.revision)return undefined;
  const win=(boundary as HTMLElement).ownerDocument?.defaultView;
  if(!win||!(boundary instanceof win.HTMLElement)||!boundary.isConnected||!boundary.matches(ownerSelector)||boundary.dataset.path!==row.path)return undefined;
  const target=event.target instanceof win.Element?event.target:event.target instanceof win.Node?event.target.parentElement:null;
  if(!target||!boundary.contains(target)||target.closest('input,textarea,select,button,[contenteditable="true"]'))return undefined;
  const owned=(link:Element):link is HTMLElement=>{
    const property=link.closest('[data-property]');
    return link instanceof win.HTMLElement&&link.isConnected&&boundary.contains(link)&&link.matches('a.internal-link')
      &&link.closest(ownerSelector)===boundary&&!!property&&boundary.contains(property)&&property.matches(filenameSelector);
  };
  const hovered=target.closest('a.internal-link');
  // Hovering a relation must not select a neighboring filename in the same card.
  if(hovered)return owned(hovered)?hovered:undefined;
  const filenames=[...boundary.querySelectorAll('a.internal-link')].filter(owned);
  return filenames.length===1?filenames[0]:undefined;
}
