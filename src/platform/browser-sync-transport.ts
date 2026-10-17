/** HTTP only. Raw response bytes MUST pass the shared Rust protocol decoder before use. */
export const SYNC_CONTROL_BYTES = 4096;
export const SYNC_WIRE_BYTES = 8 + 4096 + 24 + 1024 * 1024 + 16;
export const SYNC_PAGE_BYTES = 4 * Math.ceil(2 * SYNC_WIRE_BYTES / 3) + 32768;

export type BrowserSyncTransportCode = 'sync_invalid_configuration' | 'sync_invalid_request' |
  'sync_transport' | 'sync_timeout' | 'sync_aborted' | 'sync_closed' |
  'sync_authorization_failed' | 'sync_relay_conflict' | 'sync_limit' |
  'sync_invalid_response' | 'sync_response_limit';
export class BrowserSyncTransportError extends Error {
  readonly code: BrowserSyncTransportCode;
  constructor(code: BrowserSyncTransportCode) { super(code); this.name = 'BrowserSyncTransportError'; this.code = code; }
}
export interface BrowserSyncTransportOptions {
  /** Root origin only: no credentials, path prefix, query or fragment. */
  endpoint: string;
  vaultId: string;
  bearerToken: string;
  /** Explicit synthetic-fixture opt-in. HTTPS is required otherwise. */
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
}
export interface BrowserSyncTransport {
  hello(signal?: AbortSignal): Promise<Uint8Array>;
  upload(updateId: string, exactWire: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  /** cursorJson is produced by the shared Rust cursor encoder, never renderer input. */
  pull(cursorJson: string, through?: string, signal?: AbortSignal): Promise<Uint8Array>;
  close(): void;
}
const id = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const decimal = /^(0|[1-9][0-9]{0,19})(?![\s\S])/;
const fail = (code: BrowserSyncTransportCode): never => { throw new BrowserSyncTransportError(code); };

export function createBrowserSyncTransport(
  options: BrowserSyncTransportOptions,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): BrowserSyncTransport {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { return fail('sync_invalid_configuration'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (options.endpoint.includes('?') || options.endpoint.includes('#') || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(options.allowLoopbackHttp === true && endpoint.protocol === 'http:' && loopback)) ||
      !id.test(options.vaultId) || !/^[\x21-\x7e]{1,4096}(?![\s\S])/.test(options.bearerToken)) {
    return fail('sync_invalid_configuration');
  }
  const deadline = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60_000) return fail('sync_invalid_configuration');
  const origin = endpoint.origin;
  const vault = options.vaultId;
  let token = options.bearerToken;
  let closed = false;
  const active = new Set<AbortController>();

  async function request(path: string, cap: number, signal?: AbortSignal, body?: Uint8Array): Promise<Uint8Array> {
    if (closed) return fail('sync_closed');
    if (signal?.aborted) return fail('sync_aborted');
    const controller = new AbortController();
    let abortCode: BrowserSyncTransportCode = 'sync_aborted';
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    const timer = setTimeout(() => { abortCode = 'sync_timeout'; controller.abort(); }, deadline);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort!: (reason: BrowserSyncTransportError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new BrowserSyncTransportError(closed ? 'sync_closed' : abortCode));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (path !== '/v1/hello') headers.Authorization = `Bearer ${token}`;
      if (body) headers['Content-Type'] = 'application/octet-stream';
      const url = origin + path;
      const response = await Promise.race([fetchImpl(url, {
        method: body ? 'PUT' : 'GET', headers, body: body as Uint8Array<ArrayBuffer> | undefined,
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }), interrupted]);
      reader = response.body?.getReader();
      // Native fetch enforces redirect:error; this also rejects a misbehaving injected transport.
      if (response.redirected || (response.url && response.url !== url)) return fail('sync_invalid_response');
      if (response.status !== 200) return fail(response.status === 401 || response.status === 403 ? 'sync_authorization_failed' :
        response.status === 409 ? 'sync_relay_conflict' : response.status === 413 ? 'sync_limit' : 'sync_transport');
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail('sync_invalid_response');
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^[0-9]+(?![\s\S])/.test(length) || !Number.isSafeInteger(Number(length)))) return fail('sync_invalid_response');
      if (length !== null && Number(length) > cap) return fail('sync_response_limit');
      if (!reader) return fail('sync_invalid_response');
      const buffer = new Uint8Array(cap);
      let size = 0;
      for (;;) {
        const result = await Promise.race([reader.read(), interrupted]);
        if (result.done) break;
        if (result.value.byteLength > cap - size) return fail('sync_response_limit');
        buffer.set(result.value, size);
        size += result.value.byteLength;
      }
      if (controller.signal.aborted) return fail(closed ? 'sync_closed' : abortCode);
      return buffer.slice(0, size);
    } catch (error) {
      if (error instanceof BrowserSyncTransportError) throw error;
      return fail(controller.signal.aborted ? (closed ? 'sync_closed' : abortCode) : 'sync_transport');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      active.delete(controller);
      // Cancellation must not await a peer-controlled stream. Aborting fetch also releases its network request.
      if (reader) void reader.cancel().catch(() => {});
      controller.abort();
    }
  }
  return {
    hello: signal => request('/v1/hello', SYNC_CONTROL_BYTES, signal),
    upload(updateId, exactWire, signal) {
      if (!id.test(updateId) || !(exactWire instanceof Uint8Array)) return Promise.reject(new BrowserSyncTransportError('sync_invalid_request'));
      if (exactWire.byteLength > SYNC_WIRE_BYTES) return Promise.reject(new BrowserSyncTransportError('sync_limit'));
      // Snapshot before any await; retries are controlled by the durable wire ledger, not fetch.
      return request(`/v1/vaults/${vault}/updates/${updateId}`, SYNC_CONTROL_BYTES, signal, exactWire.slice());
    },
    pull(cursorJson, through, signal) {
      if (typeof cursorJson !== 'string' || cursorJson.length > SYNC_CONTROL_BYTES || new TextEncoder().encode(cursorJson).byteLength > SYNC_CONTROL_BYTES || !cursorJson.length ||
          (through !== undefined && (!decimal.test(through) || BigInt(through) > 18446744073709551615n))) {
        return Promise.reject(new BrowserSyncTransportError('sync_invalid_request'));
      }
      const query = new URLSearchParams({ cursor: cursorJson, limit: '64' });
      if (through !== undefined) query.set('through', through);
      return request(`/v1/vaults/${vault}/updates?${query}`, SYNC_PAGE_BYTES, signal);
    },
    close() { closed = true; token = ''; for (const controller of active) controller.abort(); },
  };
}
