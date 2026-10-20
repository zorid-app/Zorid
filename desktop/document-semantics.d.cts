import type {DesktopDocumentRequest} from '../src/platform/desktop-document-semantics.ts';
export const MAX_DOCUMENT_REQUEST: number;
export const MAX_DOCUMENT_RESPONSE: number;
export function captureDocumentRuntimeRequest(method:string,args:unknown):unknown[];
export function captureDocumentRuntimeReply(method:string,args:readonly unknown[],value:unknown,scope:{localStoreId:string;clientId:string}):unknown;
export function captureDocumentRequest(input: unknown): DesktopDocumentRequest;
export function decodeDocumentReply(request: DesktopDocumentRequest, marker: unknown, bytes: Uint8Array): unknown;
export function validDocumentReply(command: {request: DesktopDocumentRequest}, marker: unknown, bytes: Uint8Array): boolean;
export function createDesktopDocumentSemantics(host: {documentCommand(clientId: string, request: DesktopDocumentRequest): Promise<unknown>}, clientId: string, localStoreId: string, options?:{readonly metadataRowsAvailable?:boolean;readonly basePreviewAvailable?:boolean}): {
  readonly basePreviewAvailable?:true;
  invoke(input: unknown): Promise<unknown>;
  forget(): void;
};
