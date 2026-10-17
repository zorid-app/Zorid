import { createClient, ConnectError, Code } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { RelayService, ErrorDetailSchema, ErrorCode } from '../generated/zorid/sync/rpc/v1/relay_pb.ts';
import { BrowserVaultError } from '../core/browser-vault.ts';
import { BrowserSyncTransportError, SYNC_WIRE_BYTES } from './browser-sync-transport.ts';
import type { BrowserSyncTransport, BrowserSyncTransportOptions, BrowserSyncTransportCode } from './browser-sync-transport.ts';
import { guardGrpcWebFrames } from './browser-grpc-frame-guard.ts';

export const GRPC_CONTROL_BYTES = 4096;
export const GRPC_APPEND_BYTES = SYNC_WIRE_BYTES + GRPC_CONTROL_BYTES;
export const GRPC_PULL_BYTES = 2 * SYNC_WIRE_BYTES + 32768;
const service = '/zorid.sync.rpc.v1.RelayService/';
const id = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const decimal = /^(0|[1-9][0-9]{0,19})(?![\s\S])/;
const maxPosition = 18446744073709551615n;
const transportError = (code: BrowserSyncTransportCode) => new BrowserSyncTransportError(code);
const emptyControl = () => ({ requiredFeatures: [], optionalExtensions: [] });
type Method = 'Hello' | 'Append' | 'Pull';
const requestLimit = (method: Method) => method === 'Append' ? GRPC_APPEND_BYTES : GRPC_CONTROL_BYTES;
const responseLimit = (method: Method) => method === 'Pull' ? GRPC_PULL_BYTES : GRPC_CONTROL_BYTES;
function position(value: unknown): bigint {
  if (typeof value !== 'string' || !decimal.test(value)) throw transportError('sync_invalid_request');
  const result = BigInt(value);
  if (result > maxPosition) throw transportError('sync_invalid_request');
  return result;
}
/** Input-only compatibility with the existing Rust cursor encoder. Remote reply
 * protobuf is never converted through JSON or reconstructed from generated DTOs. */
function cursor(input: string) {
  if (typeof input !== 'string' || input.length === 0 || input.length > GRPC_CONTROL_BYTES || new TextEncoder().encode(input).length > GRPC_CONTROL_BYTES) throw transportError('sync_invalid_request');
  let value: any;
  try { value = JSON.parse(input); } catch { throw transportError('sync_invalid_request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['server_epoch', 'after', 'extensions'].includes(key)) || typeof value.server_epoch !== 'string' || !id.test(value.server_epoch)) throw transportError('sync_invalid_request');
  if (value.extensions !== undefined) {
    const extension = value.extensions;
    if (!extension || typeof extension !== 'object' || Array.isArray(extension) || Object.keys(extension).some(key => !['required_features', 'optional_extensions'].includes(key)) ||
      extension.required_features !== undefined && (!Array.isArray(extension.required_features) || extension.required_features.length !== 0) ||
      extension.optional_extensions !== undefined && (!extension.optional_extensions || typeof extension.optional_extensions !== 'object' || Array.isArray(extension.optional_extensions) || Object.keys(extension.optional_extensions).length !== 0)) throw transportError('sync_invalid_request');
  }
  return { serverEpoch: value.server_epoch, after: position(value.after), control: emptyControl() };
}

/** Generated Connect-ES unary calls own protobuf and final gRPC trailer parsing.
 * The supported custom fetch rejects oversized declared frames before Connect's
 * envelope decoder can allocate, and captures the exact bounded message bytes
 * for the shared Rust validator. RPC success alone is not durable local ACK. */
export function createBrowserGrpcTransport(
  options: BrowserSyncTransportOptions,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): BrowserSyncTransport & { readonly format: 'grpc-protobuf-v2' } {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw transportError('sync_invalid_configuration'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (options.endpoint.includes('?') || options.endpoint.includes('#') || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
    endpoint.protocol !== 'https:' && !(options.allowLoopbackHttp === true && endpoint.protocol === 'http:' && loopback) ||
    !id.test(options.vaultId) || !/^[\x21-\x7e]{1,4096}(?![\s\S])/.test(options.bearerToken)) throw transportError('sync_invalid_configuration');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw transportError('sync_invalid_configuration');
  const origin = endpoint.origin, vaultId = options.vaultId;
  let token = options.bearerToken, closed = false;
  const active = new Set<AbortController>();
  function sanitize(error: unknown): Error {
    // Preserve only local finite guard classifications, including Connect's cause.
    let cause = error;
    for (let depth = 0; depth < 4 && cause; depth++) {
      if (cause instanceof BrowserSyncTransportError || cause instanceof BrowserVaultError) return cause;
      cause = cause instanceof Error ? cause.cause : undefined;
    }
    if (error instanceof ConnectError) {
      // Details are generated protobuf, not strings. Unknown/malformed details
      // never become authorization, compatibility or retry decisions.
      try {
        const details = error.findDetails(ErrorDetailSchema);
        if (details.length === 1) {
          switch (details[0].code) {
            case ErrorCode.UNSUPPORTED_PROTOCOL: return new BrowserVaultError('sync_unsupported_protocol', 'Sync protocol was rejected');
            case ErrorCode.EPOCH_MISMATCH: return new BrowserVaultError('sync_epoch_mismatch', 'Sync epoch was rejected');
          }
        }
      } catch { return transportError('sync_invalid_response'); }
      switch (error.code) {
        case Code.Unauthenticated: case Code.PermissionDenied: return transportError('sync_authorization_failed');
        case Code.AlreadyExists: case Code.FailedPrecondition: case Code.Aborted: return transportError('sync_relay_conflict');
        case Code.ResourceExhausted: return transportError('sync_limit');
        case Code.DeadlineExceeded: return transportError('sync_timeout');
        case Code.Canceled: return transportError(closed ? 'sync_closed' : 'sync_aborted');
        case Code.InvalidArgument: case Code.OutOfRange: return transportError('sync_invalid_request');
        default: return transportError('sync_transport');
      }
    }
    return transportError('sync_transport');
  }
  async function invoke(method: Method, signal: AbortSignal | undefined, call: (client: Client<typeof RelayService>, signal: AbortSignal) => Promise<unknown>): Promise<Uint8Array> {
    if (closed) throw transportError('sync_closed');
    if (signal?.aborted) throw transportError('sync_aborted');
    if (active.size !== 0) throw transportError('sync_invalid_request'); // One admitted relay RPC per client.
    const controller = new AbortController(); active.add(controller);
    let timedOut = false, captured: Uint8Array | undefined, bodyComplete = false;
    const abortError = () => transportError(closed ? 'sync_closed' : timedOut ? 'sync_timeout' : 'sync_aborted');
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const expectedUrl = origin + service + method;
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== expectedUrl || init?.method !== 'POST' || !(init.body instanceof Uint8Array)) throw transportError('sync_invalid_request');
      if (controller.signal.aborted) throw abortError();
      const body = init.body;
      // Connect supplies exactly one uncompressed request envelope. No protobuf parsing.
      if (body.byteLength < 5 || body[0] !== 0 || body.byteLength > requestLimit(method) + 5 || new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1, false) !== body.byteLength - 5) throw transportError('sync_limit');
      const headers = new Headers(init.headers);
      if (headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/grpc-web+proto') throw transportError('sync_invalid_request');
      headers.set('grpc-accept-encoding', 'identity');
      if (method === 'Hello') headers.delete('Authorization'); else headers.set('Authorization', `Bearer ${token}`);
      let rejectAbort!: (error: Error) => void;
      const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(abortError());
      const requestSignal = init.signal ?? controller.signal;
      requestSignal.addEventListener('abort', onAbort, { once: true });
      let response: Response;
      try {
        if (requestSignal.aborted) throw abortError();
        const sent = fetchImpl(expectedUrl, { ...init, headers, body: body.slice(), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: requestSignal });
        void sent.then(late => { if (requestSignal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
        response = await Promise.race([sent, interrupted]);
      } finally { requestSignal.removeEventListener('abort', onAbort); }
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw abortError(); }
      const rejectResponse = (code: BrowserSyncTransportCode): never => { void response.body?.cancel().catch(() => {}); throw transportError(code); };
      if (response.redirected || response.url && response.url !== expectedUrl) return rejectResponse('sync_invalid_response');
      if (response.status !== 200) return rejectResponse(response.status === 401 || response.status === 403 ? 'sync_authorization_failed' : response.status === 409 ? 'sync_relay_conflict' : response.status === 413 ? 'sync_limit' : 'sync_transport');
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/grpc-web+proto') return rejectResponse('sync_invalid_response');
      for (const name of ['Content-Encoding', 'Grpc-Encoding']) {
        const value = response.headers.get(name);
        if (value && value.trim().toLowerCase() !== 'identity') return rejectResponse('sync_invalid_response');
      }
      const messageLimit = responseLimit(method), bodyLimit = messageLimit + GRPC_CONTROL_BYTES + 10;
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^[0-9]+(?![\s\S])/.test(length) || !Number.isSafeInteger(Number(length)))) return rejectResponse('sync_invalid_response');
      if (length !== null && Number(length) > bodyLimit) return rejectResponse('sync_response_limit');
      let statusHeaderBytes = 0;
      for (const name of ['Grpc-Status', 'Grpc-Message', 'Grpc-Status-Details-Bin']) statusHeaderBytes += new TextEncoder().encode(response.headers.get(name) ?? '').byteLength;
      if (statusHeaderBytes > GRPC_CONTROL_BYTES) return rejectResponse('sync_response_limit');
      // Tonic can send an immediate failure as trailers-only response headers.
      // Connect must parse/map that status; an absent message cannot become success.
      if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      const guarded = guardGrpcWebFrames(response.body, { maxMessageBytes: messageLimit, maxTrailerBytes: GRPC_CONTROL_BYTES, maxBodyBytes: bodyLimit }, {
        signal: requestSignal, abortError,
        onMessage(bytes) { captured = bytes; },
        onDone() { bodyComplete = !requestSignal.aborted; },
      });
      return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    try {
      const client = createClient(RelayService, createGrpcWebTransport({ baseUrl: origin, useBinaryFormat: true, fetch: guardedFetch, defaultTimeoutMs: timeoutMs, binaryOptions: { readUnknownFields: false } }));
      await call(client, controller.signal); // Includes final grpc-status/trailer validation.
      if (controller.signal.aborted) throw abortError();
      if (!bodyComplete || !captured) throw transportError('sync_invalid_response');
      return captured;
    } catch (error) {
      if (controller.signal.aborted) throw abortError();
      throw sanitize(error);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller); controller.abort();
    }
  }
  return {
    format: 'grpc-protobuf-v2',
    hello: signal => invoke('Hello', signal, (client, requestSignal) => client.hello({ offeredTransportMajors: [2], control: emptyControl() }, { signal: requestSignal })),
    upload(updateId, wire, signal) {
      if (!id.test(updateId) || !(wire instanceof Uint8Array)) return Promise.reject(transportError('sync_invalid_request'));
      if (wire.byteLength > SYNC_WIRE_BYTES) return Promise.reject(transportError('sync_limit'));
      const exactWire = wire.slice(); // Snapshot before any await; never reseal or remint IDs.
      return invoke('Append', signal, (client, requestSignal) => client.append({ context: { transportMajor: 2, control: emptyControl() }, vaultId, updateId, exactWire }, { signal: requestSignal }));
    },
    pull(cursorJson, through, signal) {
      try {
        const selected = cursor(cursorJson), boundary = through === undefined ? undefined : position(through);
        return invoke('Pull', signal, (client, requestSignal) => client.pull({ context: { transportMajor: 2, control: emptyControl() }, vaultId, cursor: selected, ...(boundary === undefined ? {} : { through: boundary }), limit: 64 }, { signal: requestSignal }));
      } catch (error) { return Promise.reject(error); }
    },
    close() { closed = true; token = ''; for (const controller of active) controller.abort(); },
  };
}
