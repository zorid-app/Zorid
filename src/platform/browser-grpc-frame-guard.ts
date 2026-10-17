import { BrowserSyncTransportError } from './browser-sync-transport.ts';

export interface GrpcWebFrameLimits {
  readonly maxMessageBytes: number;
  readonly maxTrailerBytes: number;
  readonly maxBodyBytes: number;
}
export interface GrpcWebFrameGuardOptions {
  readonly signal?: AbortSignal;
  /** A private bounded copy; only expose it after Connect validates final status. */
  readonly onMessage?: (bytes: Uint8Array) => void;
  readonly onDone?: () => void;
  readonly abortError?: () => Error;
}
const fail = (code: 'sync_invalid_response' | 'sync_response_limit'): never => {
  throw new BrowserSyncTransportError(code);
};

/** Inspect only gRPC-Web's five-byte envelope headers, before Connect sees them.
 * This is not a protobuf or trailer decoder. No allocation uses an unchecked
 * peer-declared length; Connect remains responsible for protobuf and final status. */
export function guardGrpcWebFrames(
  source: ReadableStream<Uint8Array>, limits: GrpcWebFrameLimits,
  options: GrpcWebFrameGuardOptions = {},
): ReadableStream<Uint8Array> {
  if (![limits.maxMessageBytes, limits.maxTrailerBytes, limits.maxBodyBytes]
    .every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid gRPC frame limits');
  const reader = source.getReader(), header = new Uint8Array(5);
  let headerUsed = 0, remaining = 0, frameFlags = 0, message: Uint8Array | undefined;
  let messageOffset = 0, dataFrames = 0, trailerFrames = 0, frames = 0;
  let declaredBytes = 0, receivedBytes = 0, ended = false;
  let pending: Uint8Array = new Uint8Array(0);
  let pendingOffset = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cancelSource = (reason?: unknown) => { void reader.cancel(reason).catch(() => {}); };
  const finish = () => {
    if (ended) return;
    ended = true; options.signal?.removeEventListener('abort', abort); options.onDone?.();
  };
  const abort = () => {
    if (ended) return;
    const error = options.abortError?.() ?? new BrowserSyncTransportError('sync_aborted');
    finish(); cancelSource(error); controller.error(error);
  };
  const completedFrame = () => {
    if (frameFlags === 0) {
      const captured = message!; message = undefined; options.onMessage?.(captured);
    }
  };
  async function available(): Promise<boolean> {
    if (pendingOffset < pending.byteLength) return true;
    const result = await reader.read();
    if (ended) return false;
    if (result.done) return false;
    if (!(result.value instanceof Uint8Array)) return fail('sync_invalid_response');
    receivedBytes += result.value.byteLength;
    if (receivedBytes > limits.maxBodyBytes) return fail('sync_response_limit');
    pending = result.value; pendingOffset = 0;
    return true;
  }
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    },
    async pull(value) {
      if (ended) return;
      try {
        for (;;) {
          if (!await available()) {
            if (ended) return;
            if (headerUsed !== 0 || remaining !== 0) return fail('sync_invalid_response');
            finish(); value.close(); return;
          }
          if (ended) return;
          if (pendingOffset === pending.length) continue; // A valid empty source chunk.
          if (remaining === 0) {
            const count = Math.min(5 - headerUsed, pending.length - pendingOffset);
            header.set(pending.subarray(pendingOffset, pendingOffset + count), headerUsed);
            headerUsed += count; pendingOffset += count;
            if (headerUsed !== 5) continue;
            // Do not forward even the header until flags/count/length are bounded.
            frameFlags = header[0];
            if (frameFlags !== 0 && frameFlags !== 0x80) return fail('sync_invalid_response');
            if (trailerFrames !== 0 || ++frames > 2) return fail('sync_invalid_response');
            const length = new DataView(header.buffer).getUint32(1, false);
            if (frameFlags === 0) {
              if (++dataFrames > 1) return fail('sync_invalid_response');
              if (length > limits.maxMessageBytes) return fail('sync_response_limit');
            } else {
              if (++trailerFrames > 1) return fail('sync_invalid_response');
              if (length > limits.maxTrailerBytes) return fail('sync_response_limit');
            }
            declaredBytes += 5 + length;
            if (declaredBytes > limits.maxBodyBytes) return fail('sync_response_limit');
            remaining = length; headerUsed = 0;
            if (frameFlags === 0) { message = new Uint8Array(length); messageOffset = 0; }
            value.enqueue(header.slice());
            if (remaining === 0) completedFrame();
            return;
          }
          // Forward at most one bounded slice per pull, respecting backpressure.
          const count = Math.min(remaining, pending.length - pendingOffset, 128 * 1024);
          const chunk = pending.subarray(pendingOffset, pendingOffset + count);
          if (frameFlags === 0) { message!.set(chunk, messageOffset); messageOffset += count; }
          pendingOffset += count; remaining -= count;
          value.enqueue(chunk.slice());
          if (remaining === 0) completedFrame();
          return;
        }
      } catch (error) {
        if (!ended) { finish(); cancelSource(error); value.error(error); }
      }
    },
    cancel(reason) { finish(); cancelSource(reason); },
  }, { highWaterMark: 0 });
}
