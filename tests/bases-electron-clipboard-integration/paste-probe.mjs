/** Transient native-event validation. Unexpected bytes never leave this call or
 * reach production handlers; receipts contain known type names and flags only.
 * Keep self-contained: the campaign embeds this exact function in the renderer. */
export function nativePasteReceipt(event,expected){
  const known=['text/plain','text/markdown','obsidian/table','obsidian/bases-cells'];
  let accepted=event.isTrusted===true&&!!expected,types=[];
  try{
    for(const type of known)if((event.clipboardData?.getData(type)??'')!==expected?.[type])accepted=false;
    types=[...(event.clipboardData?.types??[])];
  }catch{accepted=false;}
  const receipt={trusted:event.isTrusted===true,accepted,types:types.filter(type=>known.includes(type)),unknownFormatCount:types.filter(type=>!known.includes(type)).length};
  if(!accepted){event.preventDefault();event.stopImmediatePropagation();}
  return receipt;
}
