export const vaultName='Mapped editor selection';
export const file='Selection note.md';
export const targetLine='Selection 🦀 anchor BRAVO CHARLIE tail.';
export const prefix='Selection 🦀 anchor ',word='BRAVO';
export const body='Before body sentinel.\n'+targetLine+'\n';
export const sources={
  initial:'---\nkind: selection\nscore: 1\nuntouched: preserve\n---\n'+body,
  grown:'---\nkind: selection\nscore: 123456789\nuntouched: preserve\n---\n'+body,
  final:'---\nkind: selection\nscore: 2\nuntouched: preserve\n---\n'+body,
};
export const phases=[
  {name:'caret-prefix-grows',before:sources.initial,after:sources.grown,score:'123456789',collapsed:true,selected:'',anchor:prefix.length,head:prefix.length,delta:8},
  {name:'nonempty-range-prefix-shrinks',before:sources.grown,after:sources.final,score:'2',collapsed:false,selected:word,anchor:prefix.length,head:prefix.length+word.length,delta:-8},
];
export const base='filters: \'note.kind == "selection"\'\nviews:\n  - type: table\n    name: Selection\n    order: [file.name, note.score]\n';
export const properties='properties:\n  score: {type: number}\n';
export function fixtureFiles(){return new Map([[file,sources.initial],['Selection.base',base],['Properties.yaml',properties]]);}
