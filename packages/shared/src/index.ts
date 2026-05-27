export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type Result<T, E = ZoridError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends ZoridError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export class ZoridError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = 'ZoridError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type DisposableLike = Disposable | (() => void | Promise<void>);

export class DisposableStack implements Disposable {
  #items: DisposableLike[] = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  use<T extends DisposableLike>(item: T): T {
    if (this.#disposed) {
      throw new ZoridError('disposed', 'Cannot add a disposable after the stack has been disposed.');
    }
    this.#items.push(item);
    return item;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    for (const item of this.#items.splice(0).reverse()) {
      try {
        if (typeof item === 'function') await item();
        else await item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more disposables failed.');
    }
  }
}

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type VaultPath = Brand<string, 'VaultPath'>;
export type PluginId = Brand<string, 'PluginId'>;

export function asPluginId(value: string): PluginId {
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    throw new ZoridError('invalid-plugin-id', `Invalid plugin id: ${value}`);
  }
  return value as PluginId;
}

export function normalizeVaultPath(path: string): VaultPath {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new ZoridError('invalid-vault-path', `Vault path must stay inside the vault: ${path}`);
  }
  return parts.join('/') as VaultPath;
}
