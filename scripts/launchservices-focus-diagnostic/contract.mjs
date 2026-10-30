import assert from 'node:assert/strict';

export function launchArguments({app,profile,data,stdout,stderr}){
  return ['-n','-W','-a',app,'--stdout',stdout,'--stderr',stderr,'--env','ZORID_LOCAL_DATA_DIR='+data,'--args','--inspect=127.0.0.1:0','--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run'];
}
export function processRows(text){
  return text.split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);return m?[{pid:Number(m[1]),started:m[2].replace(/\s+/g,' '),command:m[3]}]:[];});
}
export function authenticate(identity,expected,rows,wrapperPid){
  assert.ok(Number.isSafeInteger(identity?.pid)&&identity.pid>1&&identity.pid!==wrapperPid,'Actual main PID must differ from wrapper');
  for(const key of ['executable','appPath','profile','data'])assert.equal(identity[key],expected[key],'Actual main '+key+' differs');
  assert.equal(identity.packaged,true);assert.ok(Number.isFinite(identity.timeOrigin));
  assert.ok(identity.argv.includes('--user-data-dir='+expected.profile),'Actual main argv lacks unique profile');
  const matching=rows.filter(row=>row.command===expected.executable||row.command.startsWith(expected.executable+' '));
  assert.equal(matching.length,1,'Expected one owned executable process');
  const row=matching[0];assert.equal(row.pid,identity.pid);assert.ok(row.command.split(' ').includes('--user-data-dir='+expected.profile),'Actual process profile differs');
  return {...identity,started:row.started,command:row.command};
}
export function assertLifetime(owner,rows){const row=rows.find(row=>row.pid===owner.pid);assert.ok(row&&row.started===owner.started&&row.command===owner.command,'Owned app lifetime differs');return owner.pid;}
export function cleanupVerdict({wrapper,final,remaining,forced,appPid}){
  const nativeNormal=!!final?.nativePids?.length&&final.nativePids.every(pid=>final.nativeExits?.some(exit=>exit.pid===pid&&exit.code===0&&exit.signal===null));
  return {normalLifecycle:!forced&&wrapper?.code===0&&wrapper.signal===null&&final?.pid===appPid&&final.normalQuitObserved===true&&final.quitExitCode===0&&nativeNormal&&final.errors?.length===0&&Array.isArray(remaining)&&remaining.length===0,appKernelExitStatus:'unknown',nativeNormal};
}
