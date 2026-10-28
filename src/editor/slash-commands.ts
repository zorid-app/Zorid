import {ChangeSet} from '@codemirror/state';
import type {EditorState,TransactionSpec} from '@codemirror/state';
import {isolateHistory} from '@codemirror/commands';
import {canInsert,insertionTransaction} from './insertion-commands.ts';
import type {InsertionCommandId} from './insertion-commands.ts';

export type SlashCommandGroup = 'Basic blocks' | 'Media' | 'Database' | 'Advanced blocks';
interface Descriptor {readonly id:string;readonly label:string;readonly description:string;readonly group:SlashCommandGroup;readonly glyph:string;readonly keywords:string;readonly hint?:string}
export type SlashCommand = Descriptor & (
  {readonly kind:'prefix';readonly prefix:string}
  | {readonly kind:'insert';readonly command:InsertionCommandId}
  | {readonly kind:'database';readonly mode:'inline'|'page'}
);
const prefix=(id:string,label:string,description:string,glyph:string,value:string,keywords=''):SlashCommand=>({id,label,description,glyph,kind:'prefix',prefix:value,group:'Basic blocks',keywords,hint:id==='todo'?'[]':value.trim()});
const insert=(id:InsertionCommandId,label:string,description:string,glyph:string,group:SlashCommandGroup,keywords=''):SlashCommand=>({id,label,description,glyph,kind:'insert',command:id,group,keywords,...(id==='editor-insert-rule'?{hint:'---'}:id==='editor-insert-code-block'?{hint:'```'}:{})});
const commands:readonly SlashCommand[]=[
  prefix('text','Text','Start writing with plain text.','Aa','','paragraph body normal'),
  prefix('heading-1','Heading 1','A large section heading.','H1','# ','h1 title'),
  prefix('heading-2','Heading 2','A medium section heading.','H2','## ','h2 subtitle'),
  prefix('heading-3','Heading 3','A small section heading.','H3','### ','h3 subtitle'),
  prefix('heading-4','Heading 4','A compact section heading.','H4','#### ','h4 subtitle'),
  prefix('bullet','Bulleted list','Make a simple list.','•','- ','bullet unordered'),
  prefix('number','Numbered list','Create a list with numbering.','1.','1. ','ordered numbered'),
  prefix('todo','To-do list','Keep track of a task.','☑','- [ ] ','task todo checkbox checklist'),
  insert('editor-insert-callout','Callout','Highlight a note or important idea.','!','Basic blocks','note tip warning'),
  prefix('quote','Quote','Capture a quotation.','❞','> ','blockquote citation'),
  insert('editor-insert-table','Table','Organize information in a simple table.','▦','Basic blocks','columns rows markdown'),
  insert('editor-insert-rule','Divider','Separate blocks with a line.','—','Basic blocks','horizontal rule separator'),
  insert('editor-insert-image','Image','Add an image from a link.','▧','Media','picture photo embed'),
  insert('editor-insert-link','Link','Add a link to a page or website.','↗','Basic blocks','url hyperlink'),
  insert('editor-insert-code-block','Code','Write or paste a code snippet.','<>','Media','code block fence programming'),
  insert('editor-insert-math-block','Block equation','Display a mathematical equation.','∑','Advanced blocks','math latex formula'),
  insert('editor-insert-footnote','Footnote','Add a reference at the end of the note.','¹','Advanced blocks','reference citation'),
];

/** Only capabilities supplied by the current editor owner enter the catalogue. */
export function slashCommands(capabilities:{inline:boolean;page:boolean}):readonly SlashCommand[]{
  const databases:SlashCommand[]=[
    ...(capabilities.inline?[{id:'database-inline',kind:'database' as const,mode:'inline' as const,label:'Database - Inline',description:'Add a database inside this page.',glyph:'▦',group:'Database' as const,keywords:'database inline table'}]:[]),
    ...(capabilities.page?[{id:'database-page',kind:'database' as const,mode:'page' as const,label:'Database - Full page',description:'Create a database as a separate page.',glyph:'▦',group:'Database' as const,keywords:'database full page'}]:[]),
  ];
  return [...commands.filter(command=>command.group==='Basic blocks'),...commands.filter(command=>command.group==='Media'),...databases,...commands.filter(command=>command.group==='Advanced blocks')];
}
export function filterSlashCommands(commands:readonly SlashCommand[],query:string):readonly SlashCommand[]{
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command=>words.every(word=>`${command.label} ${command.description} ${command.keywords} ${command.group}`.toLocaleLowerCase().includes(word)));
}

/** Compose removing the slash query and the existing insertion planner into a
 * single authored transaction. Intermediate editor state is never dispatched. */
export function slashInsertionTransaction(state:EditorState,from:number,to:number,command:SlashCommand):TransactionSpec|null{
  if(command.kind==='database'||state.readOnly||!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>state.doc.length||!canInsert(state,'editor-insert-code-block'))return null;
  if(command.kind==='prefix')return{changes:{from,to,insert:command.prefix},selection:{anchor:from+command.prefix.length},annotations:isolateHistory.of('full'),userEvent:'input.insert',scrollIntoView:true};
  const remove=ChangeSet.of({from,to,insert:''},state.doc.length),cleared=state.update({changes:remove,selection:{anchor:from}}).state;
  const plan=insertionTransaction(cleared,command.command);if(!plan)return null;
  const inserted=cleared.update(plan);
  return{changes:remove.compose(inserted.changes),selection:inserted.newSelection,annotations:isolateHistory.of('full'),userEvent:'input.insert',scrollIntoView:true};
}
