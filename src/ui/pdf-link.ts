import type {Vault} from '../core/vault.ts';
import {attachmentEmbed, type AttachmentImportSettings} from '../core/attachment-import.ts';

/** PDF menu links use an empty source path in the inspected reference handler.
 * Reuse the attachment formatter's path choice and escaping, but emit a link. */
export function pdfMarkdownLink(vault:Vault,path:string,subpath:string,alias:string,settings:Partial<AttachmentImportSettings>={}):string|null{
  if(vault.entries.get(path)?.type!=='file'||!/\.pdf$/i.test(path)||!subpath.startsWith('#')||/[\u0000-\u001f\u007f]/.test(subpath))return null;
  const embed=attachmentEmbed(vault,path,'',settings);
  if(embed.startsWith('![[')){
    const target=embed.slice(3,-2);
    // Wiki delimiters cannot represent these literal filename/label sequences.
    // Retain the exact destination using the formatter's Markdown spelling.
    if(!/[#%|\[\]]/.test(target)&&!/[\[\]]/.test(alias)&&!/[|\[\]]/.test(subpath))return`[[${target}${subpath}|${alias.replace(/[\u0000-\u001f\u007f]/g,' ')}]]`;
  }
  const markdown=embed.startsWith('![[')?attachmentEmbed(vault,path,'',{...settings,useMarkdownLinks:true}):embed;
  const target=markdown.slice(markdown.indexOf('](')+2,-1);
  // The viewer already URL-encodes annotation IDs. Preserve percent sequences
  // while protecting Markdown destination delimiters (encodeURIComponent leaves
  // parentheses untouched).
  const fragment=subpath.replace(/[\u0000-\u0020\u007f\\()<>\[\]]/g,character=>encodeURIComponent(character).replace(/[()]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`));
  const label=alias.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\\[\]]/g,'\\$&');
  return`[${label}](${target}${fragment})`;
}
