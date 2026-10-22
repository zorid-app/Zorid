import assert from 'node:assert/strict';
// Independent export oracle, not the production serializer/parser.
export function parseCSV(source){
  const rows=[];let row=[],field='',quoted=false,afterQuote=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(quoted){if(c==='"'&&source[i+1]==='"'){field+='"';i++;}else if(c==='"'){quoted=false;afterQuote=true;}else field+=c;continue;}
    if(c==='"'){assert.equal(field,'','CSV quote starts a field');assert.equal(afterQuote,false);quoted=true;}
    else if(c===','){row.push(field);field='';afterQuote=false;}
    else if(c==='\r'||c==='\n'){if(c==='\r'&&source[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';afterQuote=false;}
    else{assert.equal(afterQuote,false,'CSV has no text after closing quote');field+=c;}
  }
  assert.equal(quoted,false,'CSV quote closed');if(row.length||field||afterQuote){row.push(field);rows.push(row);}
  assert.ok(rows.length);assert.ok(rows.every(row=>row.length===rows[0].length),'CSV rectangular');return rows;
}
