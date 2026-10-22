// Independently authored disposable values and expected membership; no product
// parser/evaluator/serializer supplies expected results.
export const vaultName='Typed filter acceptance';
export const records=[
  {id:'A',path:'Items/A.md',text:'Alpha beta',items:['red','blue'],mixed:[1,true,'1',null],amount:2,enabled:true,due:'2026-10-20',moment:'2026-10-20T12:30',offsetMoment:'2026-10-22T06:59:00Z',optional:'yes',tags:['alpha'],body:'[[Targets/Anchor]]'},
  {id:'B',path:'Items/B.md',text:'Alpha gamma',items:['red'],mixed:['1'],amount:5,enabled:false,due:'2026-10-22',moment:'2026-10-22T12:30',offsetMoment:'2026-10-22T07:00:00Z',tags:['alpha','beta'],body:'No target link.'},
  {id:'C',path:'Items/Deep/C.md',text:'delta beta',items:['blue','green'],mixed:[false,2],amount:-1,enabled:true,due:'2026-10-24',moment:'2026-10-24T12:30',offsetMoment:'2026-10-22T07:01:00Z',optional:'yes',tags:['beta'],body:'[[/Targets/Anchor.md|anchor alias]]'},
  {id:'D',path:'Items/D.md',text:'',items:[],mixed:[],amount:0,enabled:false,due:null,moment:null,offsetMoment:null,tags:[],body:'Empty text and list; zero is a number.'},
  {id:'E',path:'Items/E.md',text:'ALPHA',items:['red','blue'],mixed:[1,true,'1',null],amount:null,enabled:null,due:null,moment:null,offsetMoment:null,tags:[],body:'Explicit null is distinct from empty text/list.'},
];
export const initialConfiguration={fixtureSentinel:'typed-filter-keep',pluginRoot:{version:31,keep:['x','y']},filters:'note.kind == "typed-filter"',views:[
  {type:'table',name:'Typed',order:['file.name','note.text','note.items','note.amount','note.enabled','note.due','note.moment'],sort:[{property:'file.name',direction:'ASC'}],pluginView:{keep:true}},
  {type:'table',name:'Unknown source',filters:'note.amount > max(1, 2)',order:['file.name','note.amount'],sort:[{property:'file.name',direction:'ASC'}],pluginView:{keep:true}},
  {type:'table',name:'Offset source',filters:'note.offsetMoment < "2026-10-22T12:30:00+05:30"',order:['file.name','note.offsetMoment'],sort:[{property:'file.name',direction:'ASC'}],pluginView:{keep:true}},
  {type:'table',name:'Single-list source',filters:'note.items.containsAny(["red", "green"])',order:['file.name','note.items'],sort:[{property:'file.name',direction:'ASC'}],pluginView:{keep:true}},
]};
export const base='# Typed filter acceptance: retain this comment and unknown fields.\n'+JSON.stringify(initialConfiguration,null,2)+'\n';
export function fixtureFiles(){
  const files=new Map([['Typed filters.base',base],['Properties.yaml',JSON.stringify({properties:{kind:{type:'text'},text:{type:'text'},items:{type:'list'},mixed:{type:'list'},amount:{type:'number'},enabled:{type:'checkbox'},due:{type:'date'},moment:{type:'datetime'},offsetMoment:{type:'datetime'}}},null,2)+'\n'],['Targets/Anchor.md','# Anchor\n\nNot a typed-filter member.\n']]);
  for(const {id,path,body,...fields}of records)files.set(path,'---\n'+JSON.stringify({kind:'typed-filter',...fields},null,2)+'\n---\n# '+id+'\n\n'+body+'\nExact body '+id+' stays unchanged.\n');
  return files;
}

// Each expression and membership is literal test data, not computed by a shadow
// expression engine. List comparisons have one array; variadic methods do not.
const entry=(id,property,operator,values,expression,members)=>({id,property,operator,values,expression,members:members.split('')});
export const cases=[
  entry('string-eq','text','eq',['Alpha beta'],'note["text"] == "Alpha beta"','A'),
  entry('string-neq','text','neq',['Alpha beta'],'note["text"] != "Alpha beta"','BCDE'),
  entry('string-starts','text','startsWith',['Alpha'],'note["text"].startsWith("Alpha")','AB'),
  entry('string-not-starts','text','notStartsWith',['Alpha'],'!note["text"].startsWith("Alpha")','CDE'),
  entry('string-ends','text','endsWith',['beta'],'note["text"].endsWith("beta")','AC'),
  entry('string-not-ends','text','notEndsWith',['beta'],'!note["text"].endsWith("beta")','BDE'),
  entry('string-empty','text','isEmpty',[],'note["text"].isEmpty()','D'),
  entry('string-not-empty','text','isNotEmpty',[],'!note["text"].isEmpty()','ABCE'),
  entry('string-contains','text','contains',['beta'],'note["text"].contains("beta")','AC'),
  entry('string-not-contains','text','notContains',['beta'],'!note["text"].contains("beta")','BDE'),
  entry('string-any','text','containsAny',['beta','gamma'],'note["text"].containsAny("beta", "gamma")','ABC'),
  entry('string-not-any','text','notContainsAny',['beta','gamma'],'!note["text"].containsAny("beta", "gamma")','DE'),
  entry('string-all','text','containsAll',['Alpha','beta'],'note["text"].containsAll("Alpha", "beta")','A'),
  entry('string-not-all','text','notContainsAll',['Alpha','beta'],'!note["text"].containsAll("Alpha", "beta")','BCDE'),
  entry('string-zero-results','text','startsWith',['absent'],'note["text"].startsWith("absent")',''),
  entry('list-exact','items','eq',['red','blue'],'note["items"] == ["red", "blue"]','AE'),
  entry('list-not-exact','items','neq',['red','blue'],'note["items"] != ["red", "blue"]','BCD'),
  entry('list-empty-exact','items','eq',[],'note["items"] == []','D'),
  entry('list-empty','items','isEmpty',[],'note["items"].isEmpty()','D'),
  entry('list-not-empty','items','isNotEmpty',[],'!note["items"].isEmpty()','ABCE'),
  entry('list-contains','items','contains',['red'],'note["items"].contains("red")','ABE'),
  entry('list-not-contains','items','notContains',['red'],'!note["items"].contains("red")','CD'),
  entry('list-any','items','containsAny',['red','green'],'note["items"].containsAny("red", "green")','ABCE'),
  entry('list-not-any','items','notContainsAny',['red','green'],'!note["items"].containsAny("red", "green")','D'),
  entry('list-all','items','containsAll',['red','blue'],'note["items"].containsAll("red", "blue")','AE'),
  entry('list-not-all','items','notContainsAll',['red','blue'],'!note["items"].containsAll("red", "blue")','BCD'),
  entry('list-typed-exact','mixed','eq',[1,true,'1',null],'note["mixed"] == [1, true, "1", null]','AE'),
  entry('list-typed-not-exact','mixed','neq',[1,true,'1',null],'note["mixed"] != [1, true, "1", null]','BCD'),
  entry('number-eq','amount','eq',[2],'note["amount"] == 2','A'),
  entry('number-neq','amount','neq',[2],'note["amount"] != 2','BCDE'),
  entry('number-lt','amount','lt',[2],'note["amount"] < 2','CD'),
  entry('number-lte','amount','lte',[2],'note["amount"] <= 2','ACD'),
  entry('number-gt','amount','gt',[2],'note["amount"] > 2','B'),
  entry('number-gte','amount','gte',[2],'note["amount"] >= 2','AB'),
  entry('number-empty','amount','isEmpty',[],'note["amount"].isEmpty()','E'),
  entry('number-not-empty','amount','isNotEmpty',[],'!note["amount"].isEmpty()','ABCD'),
  entry('number-explicit-null','amount','eq',[null],'note["amount"] == null','E'),
  entry('checkbox-true','enabled','eq',[true],'note["enabled"] == true','AC'),
  entry('checkbox-false','enabled','eq',[false],'note["enabled"] == false','BD'),
  entry('checkbox-not-true','enabled','neq',[true],'note["enabled"] != true','BDE'),
  entry('checkbox-explicit-null','enabled','eq',[null],'note["enabled"] == null','E'),
  entry('date-on','due','eq',['2026-10-22'],'note["due"] == "2026-10-22"','B'),
  entry('date-not-on','due','neq',['2026-10-22'],'note["due"] != "2026-10-22"','ACDE'),
  entry('date-before','due','lt',['2026-10-22'],'note["due"] < "2026-10-22"','A'),
  entry('date-on-before','due','lte',['2026-10-22'],'note["due"] <= "2026-10-22"','AB'),
  entry('date-after','due','gt',['2026-10-22'],'note["due"] > "2026-10-22"','C'),
  entry('date-on-after','due','gte',['2026-10-22'],'note["due"] >= "2026-10-22"','BC'),
  entry('date-empty','due','isEmpty',[],'note["due"].isEmpty()','DE'),
  entry('date-not-empty','due','isNotEmpty',[],'!note["due"].isEmpty()','ABC'),
  entry('datetime-on','moment','eq',['2026-10-22T12:30'],'note["moment"] == "2026-10-22T12:30"','B'),
  entry('datetime-not-on','moment','neq',['2026-10-22T12:30'],'note["moment"] != "2026-10-22T12:30"','ACDE'),
  entry('datetime-before','moment','lt',['2026-10-22T12:30'],'note["moment"] < "2026-10-22T12:30"','A'),
  entry('datetime-on-before','moment','lte',['2026-10-22T12:30'],'note["moment"] <= "2026-10-22T12:30"','AB'),
  entry('datetime-after','moment','gt',['2026-10-22T12:30'],'note["moment"] > "2026-10-22T12:30"','C'),
  entry('datetime-on-after','moment','gte',['2026-10-22T12:30'],'note["moment"] >= "2026-10-22T12:30"','BC'),
  entry('datetime-empty','moment','isEmpty',[],'note["moment"].isEmpty()','DE'),
  entry('datetime-not-empty','moment','isNotEmpty',[],'!note["moment"].isEmpty()','ABC'),
  entry('file-link','file.file','hasLink',['Targets/Anchor.md'],'file.hasLink("Targets/Anchor.md")','AC'),
  entry('file-not-link','file.file','notHasLink',['Targets/Anchor.md'],'!file.hasLink("Targets/Anchor.md")','BDE'),
  entry('file-folder','file.file','inFolder',['Items/Deep'],'file.inFolder("Items/Deep")','C'),
  entry('file-not-folder','file.file','notInFolder',['Items/Deep'],'!file.inFolder("Items/Deep")','ABDE'),
  entry('file-tag','file.file','hasTag',['alpha'],'file.hasTag("alpha")','AB'),
  entry('file-not-tag','file.file','notHasTag',['alpha'],'!file.hasTag("alpha")','CDE'),
  entry('file-property','file.file','hasProperty',['optional'],'file.hasProperty("optional")','AC'),
  entry('file-not-property','file.file','notHasProperty',['optional'],'!file.hasProperty("optional")','BDE'),
];
export const roundTripSources={
  'list-exact':'note["items"] == ["red"]',
  'list-any':'note["items"].containsAny("red")',
  'list-typed-exact':'note["mixed"] == [1, true, "1"]',
  'list-typed-not-exact':'note["mixed"] != [1, true, "1"]',
};
