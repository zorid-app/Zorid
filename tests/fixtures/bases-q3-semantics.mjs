// Independent Q3 acceptance inputs/oracles. No product parser, evaluator, clock,
// projection or result supplies an expected value. Values below are authored
// from the 1.14.4 catalogue evidence linked by the completion audit; these are
// future actual-transport assertions, not a claim that artifacts passed them.
// Source ledger: docs/history/bases-expression-completion-audit-20261022.md
// G1/G2 REA ev_052fb6ab7ee1d0bedbea7427adcf6b81f81c28ccf0a7ca713c0a26a811d38c1c,
// hydration ev_4b145fd45047306a9e8b5a75a35435fa5c21e56a5a01e6db17593edcb86ae61e.
// G3/G4 contracts cc860fad; G5/G6/G7 collection-owner reviewed literals;
// G8 captured-calendar contracts a2593c5c and 259fc27e. Unicode scalar indexing,
// stateless bounded regex and explicit clock/zone remain documented choices.
// G9-G15 extension: Object display strings retain inert __proto__ user keys
// (deliberate Zorid safety choice); List.sort uses the pinned English base-
// sensitivity/numeric policy. Neither asserts universal host-locale equivalence.
// G16/G17 source-only follow-up: literal percent formats retain Moment token
// meaning; raw extrema strings use the hyphenated parser, while explicit date()
// retains its compact constructor fallback. Historical browser009 had133 row
// checks; the13 new checks below require fresh matching native/WASM acceptance.
export const q3ClockMs = 1706702400000; // 2024-01-31T12:00:00.000Z
export const q3Timezone = 'UTC';
export const q3Folders = [['q3-dir','Q3']];
const n=value=>({type:'number',value}), s=value=>({type:'string',value}), b=value=>({type:'boolean',value});
const nil={type:'null'}, list=value=>({type:'list',value}), object=value=>({type:'object',value});
const error=code=>({type:'error',code}); // Message wording is deliberately not an oracle.
const sourcePath='Q3/Source.md';
const noteFiles=[
  {id:'q3-source',path:sourcePath,source:`---
q3: source
kind: tagged
bucket: A
index: 37
acc: outer
author: '[[../Authors/Ada|Ada]]'
obj:
  Zebra: 3
  '10': ten
  '2': two
  '01': leading
  apple: 7
displayObject:
  z: 5
  '2': two
  '1': 1
  '01': leading
  n: 1
  b: true
  none: null
  nested: {x: 1}
  items: [1, null, true]
  __proto__: inert
tags: [Work/Project, Personal]
plain: ['#Work/Project', '#Personal']
config:
  TaGs: [Work/Project]
  plain: ['#Work/Project']
pointer:
  ref: '[[/Q3/Source]]'
---
# Exact Q3 source
Inline #Inline/Child and literal Unicode café 🦀.
`},
  {id:'q3-peer',path:'Q3/Peer.md',source:`---
q3: peer
kind: tagged
bucket: B
tags: [Home]
plain: ['#Home']
config:
  TaGs: [Home]
  plain: ['#Work/Project']
---
Exact Q3 peer body.
`},
  {id:'q3-twin',path:'Q3/Twin.md',source:`---
q3: twin
kind: tagged
bucket: A
tags: [Work/Project, Personal]
plain: ['#Work/Project', '#Personal']
pointer:
  ref: '[[/Q3/Source]]'
---
Exact Q3 twin body.
`},
  {id:'q3-plain',path:'Q3/Plain.md',source:`---
q3: plain
kind: plain
bucket: A
plain: ['#Work/Project', '#Personal']
---
Exact Q3 generic-list body.
`},
];

// A data-to-YAML encoder only. Expected outcomes are literal values in each
// case; encoding a formula never evaluates it or derives its expected result.
const yaml=value=>JSON.stringify(value);
function single(id,name,cases){
  const baseId='q3-'+id,basePath='Q3-'+id+'.base',view='Q3 '+id;
  const source=`filters: ${yaml('file.path == "'+sourcePath+'"')}\nformulas:\n`+
    cases.map(([key,expression])=>`  ${key}: ${yaml(expression)}\n`).join('')+
    `views:\n  - type: table\n    name: ${yaml(view)}\n    order: [file.path, ${cases.map(([key])=>'formula.'+key).join(', ')}]\n`;
  return {name,baseId,basePath,view,clockMs:q3ClockMs,timezone:q3Timezone,source,
    rows:[{path:sourcePath,values:Object.fromEntries(cases.map(([key,,expected])=>['formula.'+key,expected]))}],
    diagnostics:cases.filter(([, ,expected])=>expected.type==='error').map(([key,,expected])=>({path:sourcePath,property:'formula.'+key,code:expected.code})),summaries:{}};
}

const objects=single('objects','Q3 Object callbacks preserve exact keys, typed values and outer scope',[
  ['keys','obj.map(key)',list([s('2'),s('10'),s('Zebra'),s('01'),s('apple')])],
  ['eagerKeys','obj.keys()',list([s('2'),s('10'),s('Zebra'),s('01'),s('apple')])],
  ['values','obj.map(value)',list([s('two'),s('ten'),n(3),s('leading'),n(7)])],
  ['outer','obj.filter(value.isType("number")).map(key + ":" + index + ":" + acc)',list([s('Zebra:37:outer'),s('apple:37:outer')])],
  ['filtered','obj.filter(key == "apple")',object([['apple',n(7)]])],
  ['empty','obj.filter(false)',object([])],
  ['mixedCaseMap','obj.MAP(99)',list([s('two'),s('ten'),n(3),s('leading'),n(7)])],
  ['mixedCaseFilter','obj.FILTER(false).keys()',list([s('2'),s('10'),s('Zebra'),s('01'),s('apple')])],
  ['mapArity','obj.map(value,key)',error('arity')],
  ['callbackThrown','obj.filter(number("bad"))',error('type')],
  ['objectString','displayObject.toString()',s('{"1":"1","2":"two","z":"5","01":"leading","n":"1","b":"true","none":"null","nested":"{\\"x\\":\\"1\\"}","items":"1, null, true","__proto__":"inert"}')],
  ['objectConcat','displayObject + ""',s('{"1":"1","2":"two","z":"5","01":"leading","n":"1","b":"true","none":"null","nested":"{\\"x\\":\\"1\\"}","items":"1, null, true","__proto__":"inert"}')],
  ['objectJoin','[displayObject].join("|")',s('{"1":"1","2":"two","z":"5","01":"leading","n":"1","b":"true","none":"null","nested":"{\\"x\\":\\"1\\"}","items":"1, null, true","__proto__":"inert"}')],
  ['typedObjectUnchanged','displayObject',object([
    ['z',n(5)],['2',s('two')],['1',n(1)],['01',s('leading')],['n',n(1)],['b',b(true)],['none',nil],
    ['nested',object([['x',n(1)]])],['items',list([n(1),nil,b(true)])],['__proto__',s('inert')],
  ])],
]);
objects.ownKeyStringProperties=['formula.objectString','formula.objectConcat','formula.objectJoin'];
const tags=single('tags','Q3 Tag hierarchy differs from generic String and transformed List membership',[
  ['rawTags','tags',list([s('#Work/Project'),s('#Personal')])],
  ['hierarchy','tags.contains("WORK")',b(true)],
  ['slashBoundary','tags[0].matches("wor")',b(false)],
  ['descendant','tags[0].matches("work/project/child")',b(false)],
  ['anyList','tags.containsAny(["missing","#WORK"])',b(true)],
  ['allList','tags.containsAll(["work","PERSONAL"])',b(true)],
  ['emptyAny','tags.containsAny([])',b(false)],
  ['emptyAll','tags.containsAll([])',b(true)],
  ['elementKeepsTag','tags.map(value)[0].matches("work")',b(true)],
  ['mapLosesTagList','tags.map(value).contains("work")',b(false)],
  ['filterLosesTagList','tags.filter(true).contains("work")',b(false)],
  ['mixedCaseKeepsTagList','tags.MAP(value).contains("work")',b(true)],
  ['plainExact','plain.contains("work")',b(false)],
  ['fileInlineTag','file.tags.contains("INLINE")',b(true)],
  ['nestedTags','config.TaGs.contains("work")',b(true)],
  ['publicAncestry','tags[0].isType("String") && tags.isType("List")',b(true)],
  ['plainMatches','plain[0].matches("work")',error('unknown-function')],
  ['emptyFolder','file.inFolder("")',b(true)],
  ['rootFolder','file.inFolder("/")',b(true)],
  ['normalizedFolder','file.inFolder("///Q3\\\\\\\\")',b(true)],
  ['folderCase','file.inFolder("q3")',b(false)],
  ['folderNoTrim','file.inFolder(" Q3")',b(false)],
  ['tagRepeatedPrefix','file.hasTag("##Work")',b(false)],
  ['tagCase','file.hasTag("#WORK")',b(true)],
  ['tagHierarchy','file.hasTag("work")',b(true)],
  ['tagNotPartialSegment','file.hasTag("work/pro")',b(false)],
]);
const calls=single('calls','Q3 registered calls validate exact arity, null, type and special-case spelling',[
  ['requiredNull','"abc".startsWith(null)',nil],
  ['nullStopsLater','"abc".replace(null,unknown())',nil],
  ['optionalNull','"abc".slice(1,null)',s('bc')],
  ['nullUnknown','null.unknown(alsoMissing())',nil],
  ['lazyIf','true.if(7,unknown())',n(7)],
  ['eagerIf','IF(true,7,unknown())',error('unknown-function')],
  ['ifTotalArity','if(unknown(),1,2,3)',error('arity')],
  ['methodIfCase','true.IF(7,8)',error('unknown-function')],
  ['mixedMap','[1,2].MAP(7)',list([n(1),n(2)])],
  ['scopedMap','[1,2].map(value+1)',list([n(2),n(3)])],
  ['mixedFilter','[1,2].FILTER(false)',list([n(1),n(2)])],
  ['mixedReduce','[1,2].REDUCE(7,8)',list([n(1),n(2)])],
  ['excessNumber','(1).abs(2)',error('arity')],
  ['wrongStringType','"abc".contains(1)',error('type')],
  ['missingJoin','[1,2].join()',error('arity')],
  ['argumentBeforeArity','"x".toString(unknown())',error('unknown-function')],
  ['ancestry','null.isType("Any") && image("a").isType("String")',b(true)],
  ['richConcat','image("a") + icon("b")',s('![[a]]b')],
  ['relationRawString','author.startsWith("../")',b(true)],
  ['relationRawDisplay','author.toString()',s('[[../Authors/Ada|Ada]]')],
  ['relationTarget','author.asFile().path',s('Authors/Ada.md')],
  ['deadMalformedRegex','if(false,/(/,7)',error('parse')],
  ['deadRepeatedFlag','if(true,7,/a/ii)',error('parse')],
  ['deadAndRegex','false && /(/',error('parse')],
  ['deadValidRegex','if(false,/a/,7)',n(7)],
]);
const strings=single('strings','Q3 strings, regex templates and finite numeric conversions preserve exact results',[
  ['foldAny','"Compiler".containsAny("PILE","zzz")',b(true)],
  ['foldAll','"Compiler".containsAll("COMP","ILER")',b(true)],
  ['emptyReplace','"abc".replace("","-")',s('abc')],
  ['scalarIndex','"A🦀Z"[1]',s('🦀')],
  ['missingIndex','"abc"[99]',s('')],
  ['replacement','"abc".replace(/(b)/,"$$|$&|$1")',s('a$|b|bc')],
  ['captureSplit','"a1b2".split(/(\\d)/)',list([s('a'),s('1'),s('b'),s('2'),s('')])],
  ['regexUnsupported','/(?=a)/.matches("a")',error('unsupported')],
  ['negativeRound','(123.45).round(-1)',n(123)],
  ['positiveRound','(123.45).round(1)',n(123.5)],
  ['fixedTie','(1.25).toFixed(1)',s('1.3')],
  ['fixedBinary','(1.005).toFixed(2)',s('1.00')],
  ['numberPrefix','number("  -12.5xyz")',n(-12.5)],
  ['titlePunctuation','"HELLO-WORLD".title()',s('Hello-world')],
  ['titleSpacesAndTab','"  hELLO  WORLD\\tNEXT ".title()',s('  Hello  World\tnext ')],
  ['titleLeadingPunctuation','".hELLO !wORLD".title()',s('.hello !world')],
]);
const collections=single('collections','Q3 recursive flatten and strict constructor-aware uniqueness survive transport',[
  ['flat','[1,[2,[3]],[[4]]].flat()',list([n(1),n(2),n(3),n(4)])],
  ['anyList','[1,2].containsAny([9,2])',b(true)],
  ['allList','[1,2].containsAll([2,1])',b(true)],
  ['typedUnique','[1,"1",1,null,null,false].unique()',list([n(1),s('1'),nil,b(false)])],
  ['tagScalarUnique','[tags[0],"#Work/Project"].unique().length',n(2)],
  ['tagListUnique','[tags,plain].unique().length',n(2)],
  ['nestedProvenance','[config,config].unique().length',n(1)],
  ['regexIdentity','[/x/,/x/].unique().length',n(2)],
  ['sortNatural','["a10","a2"].sort()',list([s('a2'),s('a10')])],
  ['sortBaseStable','["é","E","e","É"].sort()',list([s('é'),s('E'),s('e'),s('É')])],
  ['sortMixedNumbers','[10,"2",2,"10"].sort()',list([s('2'),n(2),n(10),s('10')])],
  ['sortRawRichKeys','[icon("a10"),html("a2"),image("A2")].sort()',list([{type:'html',value:'a2'},{type:'image',value:'A2'},{type:'icon',value:'a10'}])],
  ['iconEarliest','[icon("2024-01-01")].earliest()',{type:'date',timestamp:1704067200000,hasTime:true}],
  ['iconLatest','[icon("2024-01-01")].latest()',{type:'date',timestamp:1704067200000,hasTime:true}],
  ['htmlEarliest','[html("2024-01-02")].earliest()',{type:'date',timestamp:1704153600000,hasTime:true}],
  ['htmlLatest','[html("2024-01-02")].latest()',{type:'date',timestamp:1704153600000,hasTime:true}],
  ['imageEarliest','[image("2024-01-03")].earliest()',{type:'date',timestamp:1704240000000,hasTime:true}],
  ['imageLatest','[image("2024-01-03")].latest()',{type:'date',timestamp:1704240000000,hasTime:true}],
  ['linkEarliest','[link("2024-01-04","Not a date label")].earliest()',{type:'date',timestamp:1704326400000,hasTime:true}],
  ['linkLatest','[link("2024-01-04","Not a date label")].latest()',{type:'date',timestamp:1704326400000,hasTime:true}],
  ['compactRawEarliest','["20240101"].earliest()',nil],
  ['compactRawLatest','["202401011200"].latest()',nil],
  ['compactIconEarliest','[icon("20240101")].earliest()',nil],
  ['compactIconLatest','[icon("202401011200")].latest()',nil],
  ['compactMixedEarliest','["20240101",icon("202401011200"),"2024-01-02"].earliest()',{type:'date',timestamp:1704153600000,hasTime:true}],
  ['compactMixedLatest','["20241231",html("202412311200"),"2024-01-02"].latest()',{type:'date',timestamp:1704153600000,hasTime:true}],
  ['compactTypedEarliest','[date("20240101")].earliest()',{type:'date',timestamp:1704067200000,hasTime:true}],
  ['compactTypedLatest','[date("202401011200")].latest()',{type:'date',timestamp:1704110400000,hasTime:true}],
]);
const durationJanuary=single('duration-january','Q3 Duration components, null inputs and January overflow use the captured clock',[
  ['iso','duration("P1Y2M3W4DT5H6M7S")',{type:'duration',years:1,months:2,weeks:0,days:25,hours:5,minutes:6,seconds:7,milliseconds:0}],
  ['zero','duration("0d").isTruthy()',b(false)],
  ['zeroIso','duration("PT").isTruthy()',b(false)],
  ['fractionInput','duration("1.5h")',nil],
  ['compoundInput','duration("1d 2h")',nil],
  ['millisecondInput','duration("1ms")',nil],
  ['isoNeedsTime','duration("P1D")',nil],
  ['monthDays','duration("1M").days',n(31)],
  ['monthComparison','duration("1M") > duration("30d")',b(true)],
  ['monthOverflow','(date("2024-01-31") + duration("1M")).format("YYYY-MM-DD")',s('2024-03-02')],
  ['half','duration("3h") / 2',{type:'duration',years:0,months:0,weeks:0,days:0,hours:1.5,minutes:0,seconds:0,milliseconds:0}],
  ['halfHours','(duration("3h") / 2).hours',n(1)],
  ['percentLiteral','date("2024-01-21T19:04:05.067Z").format("%")',s('%')],
  ['percentBracket','date("2024-01-21T19:04:05.067Z").format("[%]")',s('%')],
  ['percentYearToken','date("2024-01-21T19:04:05.067Z").format("%YYYY")',s('%2024')],
  ['percentSingleYearToken','date("2024-01-21T19:04:05.067Z").format("%Y")',s('%2024')],
  ['percentMomentNotStrftime','date("2024-01-21T19:04:05.067Z").format("%Y-%m-%d")',s('%2024-%4-%0')],
  ['capturedNow','now().format("YYYY-MM-DD HH:mm:ss Z")',s('2024-01-31 12:00:00 +00:00')],
  ['capturedToday','today().format("YYYY-MM-DD HH:mm:ss Z")',s('2024-01-31 00:00:00 +00:00')],
]);
const durationFebruary=single('duration-february','Q3 Duration field and comparison change under an explicit February clock',[
  ['monthDays','duration("1M").days',n(29)],
  ['monthComparison','duration("1M") > duration("30d")',b(false)],
  ['capturedNow','now().format("YYYY-MM-DD HH:mm:ss Z")',s('2024-02-01 12:00:00 +00:00')],
  ['capturedToday','today().format("YYYY-MM-DD HH:mm:ss Z")',s('2024-02-01 00:00:00 +00:00')],
]);
durationFebruary.clockMs=1706788800000; // 2024-02-01T12:00:00.000Z, independent literal.

const taggedWrapper=tag=>list([object([['TaGs',list([s(tag)])],['plain',list([s('#Work/Project')])]])]);
const tagSummaries={
  name:'Q3 custom overall and grouped summaries retain nested TagList provenance',baseId:'q3-tag-summaries',basePath:'Q3-tag-summaries.base',view:'Q3 tag summaries',clockMs:q3ClockMs,timezone:q3Timezone,
  source:`filters: 'file.path == "Q3/Source.md" || file.path == "Q3/Peer.md"'
formulas:
  wrapped: '[config]'
  generic: '[config]'
summaries:
  WorkCount: 'values.filter(value[0].TaGs.contains("WORK")).length'
  GenericWork: 'values.filter(value[0].plain.contains("work")).length'
views:
  - type: table
    name: Q3 tag summaries
    order: [file.path, formula.wrapped, formula.generic]
    sort: [{property: file.path, direction: ASC}]
    groupBy: {property: bucket, direction: ASC}
    summaries: {formula.wrapped: WorkCount, formula.generic: GenericWork}
`,
  rows:[
    {path:'Q3/Peer.md',values:{'formula.wrapped':taggedWrapper('#Home'),'formula.generic':taggedWrapper('#Home')}},
    {path:sourcePath,values:{'formula.wrapped':taggedWrapper('#Work/Project'),'formula.generic':taggedWrapper('#Work/Project')}},
  ],summaries:{'formula.wrapped':n(1),'formula.generic':n(0)},diagnostics:[],
  groups:[
    {key:s('A'),paths:[sourcePath],summaries:{'formula.wrapped':n(1),'formula.generic':n(0)}},
    {key:s('B'),paths:['Q3/Peer.md'],summaries:{'formula.wrapped':n(0),'formula.generic':n(0)}},
  ],
};
// Public Link DTOs omit the captured source path. Identical DTOs must not be
// rehydrated by guessing a new origin before strict Object child comparisons.
// Ordinary unconfigured links retain the parsed raw destination in public path;
// canonical lookup lives in the independently bound target witness and asFile.
// Configured relation display projection is a separate canonical-path contract.
const pointer=object([['ref',{type:'link',path:'/Q3/Source',target:{$fixtureWitness:sourcePath},display:null,external:false}]]);
const provenanceGroups={
  name:'Q3 strict Object Link children retain captured provenance across grouping and summaries',baseId:'q3-provenance',basePath:'Q3-provenance.base',view:'Q3 provenance',clockMs:q3ClockMs,timezone:q3Timezone,
  source:`filters: 'file.path == "Q3/Source.md" || file.path == "Q3/Twin.md"'
formulas:
  pointerString: 'pointer.ref.toString()'
  pointerRawPrefix: 'pointer.ref.startsWith("/")'
  pointerFile: 'pointer.ref.asFile().path'
summaries:
  StrictUnique: 'values.unique().length'
views:
  - type: table
    name: Q3 provenance
    order: [file.path, note.pointer, formula.pointerString, formula.pointerRawPrefix, formula.pointerFile]
    sort: [{property: file.path, direction: ASC}]
    groupBy: {property: note.pointer, direction: ASC}
    summaries: {note.pointer: StrictUnique}
`,
  rows:[
    {path:sourcePath,values:{'note.pointer':pointer,'formula.pointerString':s('[[/Q3/Source]]'),'formula.pointerRawPrefix':b(true),'formula.pointerFile':s('Q3/Source.md')}},
    {path:'Q3/Twin.md',values:{'note.pointer':pointer,'formula.pointerString':s('[[/Q3/Source]]'),'formula.pointerRawPrefix':b(true),'formula.pointerFile':s('Q3/Source.md')}},
  ],
  summaries:{'note.pointer':n(2)},diagnostics:[],groups:[
    {key:pointer,paths:[sourcePath],summaries:{'note.pointer':n(1)}},
    {key:pointer,paths:['Q3/Twin.md'],summaries:{'note.pointer':n(1)}},
  ],
};
const returnedErrors={
  name:'Q3 summary callbacks receive returned Error data while formula namespace access rethrows',baseId:'q3-errors',basePath:'Q3-errors.base',view:'Q3 errors',clockMs:q3ClockMs,timezone:q3Timezone,
  source:`filters: 'file.path == "Q3/Source.md"'
formulas:
  problem: 'number("bad")'
  rethrown: 'formula.problem.isType("Error")'
summaries:
  ErrorCount: 'values.filter(value.isType("Error")).length'
  ErrorTruthy: 'values.map(value.isTruthy())'
views:
  - type: table
    name: Q3 errors
    order: [file.path, formula.problem, formula.rethrown]
    summaries: {formula.problem: ErrorCount, formula.rethrown: ErrorTruthy}
`,
  rows:[{path:sourcePath,values:{'formula.problem':error('type'),'formula.rethrown':error('type')}}],
  summaries:{'formula.problem':n(1),'formula.rethrown':list([b(false)])},
  diagnostics:[{path:sourcePath,property:'formula.problem',code:'type'},{path:sourcePath,property:'formula.rethrown',code:'type'}],
};

export const q3Groups=[objects,tags,calls,strings,collections,durationJanuary,durationFebruary,tagSummaries,provenanceGroups,returnedErrors];
export const q3Files=[...noteFiles,...q3Groups.map(group=>({id:group.baseId,path:group.basePath,source:group.source}))];
