/** Matches the shared Rust Text storage boundary (zorid-client-sync MAX_TEXT_BYTES).
 * This is a Markdown editing policy, not an attachment/file-size limit. */
export const MAX_NOTE_TEXT_BYTES = 1024 * 1024;
export class NoteTextSizeError extends Error {
  constructor(){super('Markdown notes support up to 1 MiB of text. This change was not applied. Split the text into smaller notes.');this.name='NoteTextSizeError';}
}
function utf8Bytes(text:string):number {
  let bytes=0;
  for(let i=0;i<text.length;i++){
    const unit=text.charCodeAt(i);
    if(unit<0x80)bytes++;
    else if(unit<0x800)bytes+=2;
    else if(unit>=0xd800&&unit<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}
    else bytes+=3;
  }
  return bytes;
}
/** Existing oversized recovery text remains accessible and may shrink. */
export function assertNoteTextChange(previous:string,next:string):void {
  if(next===previous||next.length<=Math.floor(MAX_NOTE_TEXT_BYTES/3))return;
  // Avoid encoding or scanning a huge paste when the current note is small.
  if(next.length>MAX_NOTE_TEXT_BYTES&&previous.length<=Math.floor(MAX_NOTE_TEXT_BYTES/3))throw new NoteTextSizeError();
  const bytes=utf8Bytes(next);
  if(bytes<=MAX_NOTE_TEXT_BYTES||bytes<utf8Bytes(previous))return;
  throw new NoteTextSizeError();
}
