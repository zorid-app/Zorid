import {parseArgs} from 'node:util';
import {generate} from './workload.mjs';
const {values}=parseArgs({options:{out:{type:'string'},notes:{type:'string',default:'10000'}}});
if(!values.out)throw Error('Usage: node generate.mjs --out NEW_DIRECTORY [--notes 10000|100000|SMOKE_COUNT]');
const result=await generate(values.out,Number(values.notes));
console.log(JSON.stringify({out:result.out,noteCount:result.manifest.noteCount,noteBytes:result.manifest.noteBytes,fixtureHash:result.fixtureHash}));
