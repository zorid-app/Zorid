import assert from 'node:assert/strict';
import {records,exportRecords} from './fixtures.mjs';

// These are ordinary JavaScript predicates/comparators over authored records.
// No production expression parser, query result or evaluator participates.
export const rootMembership=item=>(item.status==='Todo'||item.status==='Done')&&item.enabled;
export const viewMembership=item=>item.score>=4||(item.priority==='High'&&item.status!=='Done');
export const filteredRecords=()=>records.filter(item=>rootMembership(item)&&viewMembership(item));
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function sortedRecords(criteria,items=filteredRecords()){
  return [...items].sort((left,right)=>{
    for(const [property,direction] of criteria){const order=compare(left[property],right[property]);if(order)return direction==='DESC'?-order:order;}
    return compare(left.path,right.path);
  });
}
export const exportMatrix=()=>[['file name','Ordinal','Label'],...exportRecords.map(item=>[item.name,String(item.ordinal),item.label])];
export const expectedTSV=()=>exportMatrix().map(row=>row.map(value=>/[\t\r\n"]/.test(value)?`"${value.replace(/"/g,'""')}"`:value).join('\t')).join('\r\n');
export function parseDelimited(source,delimiter='\t'){
  const rows=[];let row=[],field='',quoted=false,closed=false;
  for(let index=0;index<source.length;index++){
    const character=source[index];
    if(quoted){if(character==='"'&&source[index+1]==='"'){field+='"';index++;}else if(character==='"'){quoted=false;closed=true;}else field+=character;continue;}
    if(character==='"'){assert.equal(field,'','Quote starts a complete field');assert.equal(closed,false);quoted=true;}
    else if(character===delimiter){row.push(field);field='';closed=false;}
    else if(character==='\n'||character==='\r'){if(character==='\r'&&source[index+1]==='\n')index++;row.push(field);rows.push(row);row=[];field='';closed=false;}
    else{assert.equal(closed,false,'No suffix after a quoted field');field+=character;}
  }
  assert.equal(quoted,false,'Quoted field closed');if(row.length||field||closed){row.push(field);rows.push(row);}
  assert.ok(rows.length);assert.ok(rows.every(item=>item.length===rows[0].length),'Rectangular delimited export');return rows;
}
export function assertLargeTSV(source){const rows=parseDelimited(source);assert.deepEqual(rows,exportMatrix());return{rows:rows.length-1,ordinalSum:rows.slice(1).reduce((sum,row)=>sum+Number(row[1]),0)};}
