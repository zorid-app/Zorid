export interface DiagnosticLatch {
 trackProbe(name:string,tasks:readonly PromiseLike<unknown>[]):void;
 finish<T>(startup:PromiseLike<T>):Promise<T>;
}
export function createDiagnosticLatch():DiagnosticLatch;
