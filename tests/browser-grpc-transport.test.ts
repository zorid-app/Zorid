import test from 'node:test';
import assert from 'node:assert/strict';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { HelloReplySchema, AppendRequestSchema, AcceptedReplySchema, PullRequestSchema, PullReplySchema } from '../src/generated/zorid/sync/rpc/v1/relay_pb.ts';
import { createBrowserGrpcTransport, GRPC_CONTROL_BYTES, GRPC_PULL_BYTES } from '../src/platform/browser-grpc-transport.ts';

const options={endpoint:'https://sync.zorid.test/',vaultId:'vault',bearerToken:'secret',timeoutMs:1000};
const emptyControl=()=>({requiredFeatures:[],optionalExtensions:[]});
function frame(flags:number,payload:Uint8Array,declared=payload.length) {const bytes=new Uint8Array(payload.length+5);bytes[0]=flags;new DataView(bytes.buffer).setUint32(1,declared,false);bytes.set(payload,5);return bytes;}
function response(payload:Uint8Array,status=0,extra:HeadersInit={}):Response {
  const trailer=frame(128,new TextEncoder().encode(`grpc-status: ${status}\r\ngrpc-message: secret-diagnostic\r\n`));
  return new Response(new ReadableStream({start(c){c.enqueue(frame(0,payload));c.enqueue(trailer);c.close();}}),{headers:{'Content-Type':'application/grpc-web+proto',...extra}});
}
const hello=()=>toBinary(HelloReplySchema,create(HelloReplySchema,{selectedTransportMajor:2,realmId:'realm',serverEpoch:'epoch',envelopeVersions:[1],suite:'xchacha20poly1305',maxWireBytes:1052720n,maxPageWireBytes:2105440n,maxPageItems:64,control:emptyControl()}));
const accepted=(updateId='update')=>toBinary(AcceptedReplySchema,create(AcceptedReplySchema,{transportMajor:2,vaultId:'vault',updateId,serverEpoch:'epoch',sequence:9007199254740993n,control:emptyControl()}));
const initialCursor=JSON.stringify({server_epoch:'epoch',after:'0',extensions:{required_features:[],optional_extensions:{}}});

test('generated unary client returns exact protobuf payload only after successful final trailers',async()=>{
  // Unknown protobuf field is informational under the frozen transport2 policy.
  // Keeping it proves response capture does not decode/re-encode the generated object.
  const canonical=hello(),raw=Uint8Array.from([...canonical,0xf8,0x07,0x01]);
  let request:RequestInit|undefined;
  const transport=createBrowserGrpcTransport(options,async(_url,init)=>{request=init;return response(raw);});
  assert.equal(transport.format,'grpc-protobuf-v2');assert.deepEqual(await transport.hello(),raw);
  assert.equal(request!.redirect,'error');assert.equal(request!.credentials,'omit');assert.equal(request!.cache,'no-store');assert.equal(request!.referrerPolicy,'no-referrer');
  assert.equal(new Headers(request!.headers).has('Authorization'),false);transport.close();
});
test('generated append carries exact original bytes and retains request ID on retry',async()=>{
  const requests:any[]=[];const raw=accepted();
  const transport=createBrowserGrpcTransport(options,async(url,init)=>{assert.equal(String(url),'https://sync.zorid.test/zorid.sync.rpc.v1.RelayService/Append');assert.equal(new Headers(init!.headers).get('Authorization'),'Bearer secret');const body=init!.body as Uint8Array;requests.push(fromBinary(AppendRequestSchema,body.subarray(5)));return response(raw);});
  const wire=Uint8Array.from([90,83,69,49,0,255]),sending=transport.upload('update',wire);wire.fill(42);assert.deepEqual(await sending,raw);await transport.upload('update',Uint8Array.from([90,83,69,49,0,255]));
  assert.deepEqual(requests[0].exactWire,Uint8Array.from([90,83,69,49,0,255]));assert.deepEqual(requests[1],requests[0]);assert.equal(requests[0].context.transportMajor,2);transport.close();
});
test('pull preserves >2^53 cursor and present zero through without a protobuf JSON conversion',async()=>{
  let request:any;const payload=toBinary(PullReplySchema,create(PullReplySchema,{transportMajor:2,items:[],next:{serverEpoch:'epoch',after:9007199254740993n,control:emptyControl()},through:9007199254740993n,complete:true,control:emptyControl()}));
  const transport=createBrowserGrpcTransport(options,async(_url,init)=>{request=fromBinary(PullRequestSchema,(init!.body as Uint8Array).subarray(5));return response(payload);});
  await transport.pull(JSON.stringify({server_epoch:'epoch',after:'9007199254740993'}),'0');assert.equal(request.cursor.after,9007199254740993n);assert.equal(request.through,0n);assert.equal(request.limit,64);assert.ok(request.control??request.context.control);transport.close();
});
test('HTTP200 plus a captured protobuf message and failing final grpc-status never returns success',async()=>{
  const transport=createBrowserGrpcTransport(options,async()=>response(accepted(),14));
  await assert.rejects(transport.upload('update',Uint8Array.of(1)),error=>{assert.equal((error as any).code,'sync_transport');assert.doesNotMatch(String(error),/secret-diagnostic/);return true;});transport.close();
});
for(const[status,code]of [[16,'sync_authorization_failed'],[7,'sync_authorization_failed'],[6,'sync_relay_conflict'],[8,'sync_limit'],[4,'sync_timeout']] as const)test(`gRPC status ${status} has a sanitized finite classification`,async()=>{
  const transport=createBrowserGrpcTransport(options,async()=>response(accepted(),status));await assert.rejects(transport.upload('update',Uint8Array.of(1)),{code});transport.close();
});
test('five-byte malicious declared length is rejected before Connect allocation',async()=>{
  const transport=createBrowserGrpcTransport(options,async()=>new Response(frame(0,new Uint8Array(),0xffffffff),{headers:{'Content-Type':'application/grpc-web+proto'}}));await assert.rejects(transport.hello(),{code:'sync_response_limit'});transport.close();
});
test('wrong origin/redirect, compression, text protocol and excessive Content-Length fail closed',async()=>{
  for(const kind of ['redirect','origin','gzip','grpcgzip','text','length']as const){let cancelled=false;
    const transport=createBrowserGrpcTransport(options,async()=>{
      const headers:Record<string,string>={'Content-Type':'application/grpc-web+proto'};
      if(kind==='gzip')headers['Content-Encoding']='gzip';if(kind==='grpcgzip')headers['Grpc-Encoding']='gzip';if(kind==='text')headers['Content-Type']='application/grpc-web-text';if(kind==='length')headers['Content-Length']=String(GRPC_CONTROL_BYTES*3);
      const result=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers});if(kind==='redirect')Object.defineProperty(result,'redirected',{value:true});if(kind==='origin')Object.defineProperty(result,'url',{value:'https://other.test/'});return result;
    });
    await assert.rejects(transport.hello(),{code:kind==='length'?'sync_response_limit':'sync_invalid_response'});assert.equal(cancelled,true);transport.close();
  }
});
test('timeout, close and caller abort interrupt even injected fetch that ignores signals',async()=>{
  for(const kind of ['timeout','close','abort']as const){const abort=new AbortController();const transport=createBrowserGrpcTransport({...options,timeoutMs:kind==='timeout'?5:1000},async()=>new Promise(()=>{}));const pending=transport.hello(abort.signal);if(kind==='close')transport.close();if(kind==='abort')abort.abort();await assert.rejects(pending,{code:kind==='timeout'?'sync_timeout':kind==='close'?'sync_closed':'sync_aborted'});transport.close();}
});
test('per-call capture isolates parallel clients; a client rejects an overlapping RPC',async()=>{
  let finish!:(value:Response)=>void;const first=createBrowserGrpcTransport(options,async()=>new Promise(resolve=>{finish=resolve;}));const second=createBrowserGrpcTransport(options,async()=>response(hello()));const one=first.hello();await assert.rejects(first.hello(),{code:'sync_invalid_request'});const two=second.hello(),distinct=Uint8Array.from([...hello(),0xf8,0x07,0x02]);finish(response(distinct));assert.deepEqual(await one,distinct);assert.deepEqual(await two,hello());first.close();second.close();
});
test('missing trailer, extra message and over-cap unary payload never escape as success',async()=>{
  for(const kind of ['missing','extra','huge']as const){const transport=createBrowserGrpcTransport(options,async()=>{
    const parts=kind==='huge'?[frame(0,new Uint8Array(),GRPC_PULL_BYTES+1)]:kind==='missing'?[frame(0,hello())]:[frame(0,hello()),frame(0,hello())];
    return new Response(new ReadableStream({start(c){for(const part of parts)c.enqueue(part);c.close();}}),{headers:{'Content-Type':'application/grpc-web+proto'}});
  });await assert.rejects(transport.hello());transport.close();}
});
test('invalid configuration and malformed cursor are rejected before any network request',async()=>{
  for(const endpoint of ['http://remote.test/','https://sync.zorid.test/prefix','https://user:pass@sync.zorid.test/','https://sync.zorid.test/?token=secret'])assert.throws(()=>createBrowserGrpcTransport({...options,endpoint}),{code:'sync_invalid_configuration'});
  let calls=0;const transport=createBrowserGrpcTransport(options,async()=>{calls++;return response(hello());});for(const after of ['01','18446744073709551616',1])await assert.rejects(transport.pull(JSON.stringify({server_epoch:'epoch',after})),{code:'sync_invalid_request'});await assert.rejects(transport.pull(initialCursor,'01'),{code:'sync_invalid_request'});assert.equal(calls,0);transport.close();
});
test('trailers-only response headers retain final gRPC error classification',async()=>{
  for(const body of [null,new Uint8Array()]){
    const transport=createBrowserGrpcTransport(options,async()=>new Response(body,{headers:{'Content-Type':'application/grpc-web+proto','grpc-status':'16','grpc-message':'secret-internal'}}));
    await assert.rejects(transport.hello(),error=>{assert.equal((error as any).code,'sync_authorization_failed');assert.doesNotMatch(String(error),/secret-internal/);return true;});transport.close();
  }
});
