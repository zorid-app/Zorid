import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const protoc=process.env.PROTOC;
if(!protoc)throw new Error('Set PROTOC to protoc32.0 (same vendored compiler as protobuf foundation)');
mkdirSync('gen',{recursive:true});
const result=spawnSync(protoc,['--proto_path=proto','--plugin=protoc-gen-es=node_modules/.bin/protoc-gen-es','--es_out=gen','--es_opt=target=ts,import_extension=js','zorid/prototype/grpcproof/v1/proof.proto'],{stdio:'inherit'});
if(result.error)throw result.error;
if(result.status===0){const path='gen/zorid/prototype/grpcproof/v1/proof_pb.ts';writeFileSync(path,readFileSync(path,'utf8').trimEnd()+'\n');}
process.exitCode=result.status??1;
