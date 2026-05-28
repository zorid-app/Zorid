import { createHash } from 'node:crypto';
import { constants, type FSWatcher, watch as fsWatch, mkdirSync, realpathSync } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { VaultAPI, VaultChangeEvent, VaultFileStat } from '@zorid/platform-api';
import { type Disposable, normalizeVaultPath, type VaultPath, ZoridError } from '@zorid/shared';

export interface FolderVaultOptions {
  readonly root: string;
}

export class FolderVault implements VaultAPI {
  readonly root: string;
  readonly profile;
  readonly #realRoot: string;

  constructor(options: FolderVaultOptions) {
    mkdirSync(options.root, { recursive: true });
    this.root = path.resolve(options.root);
    this.#realRoot = realpathSync(this.root);
    const id = `folder:${createHash('sha256').update(this.#realRoot).digest('hex').slice(0, 16)}`;
    this.profile = { id, kind: 'folder' as const, rootLabel: path.basename(this.#realRoot) };
  }

  resolve(vaultPath: VaultPath): string {
    const full = path.resolve(this.root, vaultPath);
    this.#assertLexicallyInside(full, vaultPath);
    return full;
  }

  async #resolveExisting(vaultPath: VaultPath): Promise<string> {
    const full = this.resolve(vaultPath);
    const real = await realpath(full);
    this.#assertReallyInside(real, vaultPath);
    return real;
  }

  async #resolveWritable(vaultPath: VaultPath): Promise<string> {
    const full = this.resolve(vaultPath);
    await this.#ensureWritableParent(path.dirname(full), vaultPath);
    try {
      const info = await lstat(full);
      if (info.isSymbolicLink())
        throw new ZoridError('vault.path.escape', `Path escapes vault through symlink: ${vaultPath}`);
      const existing = await realpath(full);
      this.#assertReallyInside(existing, vaultPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return full;
  }

  async #ensureWritableParent(parent: string, vaultPath: VaultPath): Promise<void> {
    this.#assertLexicallyInside(parent, vaultPath);
    const relative = path.relative(this.root, parent);
    const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new ZoridError('vault.path.escape', `Path escapes vault through symlink: ${vaultPath}`);
        const real = await realpath(current);
        this.#assertReallyInside(real, vaultPath);
        if (!info.isDirectory())
          throw new ZoridError('vault.path.not-directory', `Vault path parent is not a directory: ${vaultPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    await mkdir(parent, { recursive: true });
    this.#assertReallyInside(await realpath(parent), vaultPath);
  }

  #assertLexicallyInside(full: string, vaultPath: VaultPath): void {
    if (!full.startsWith(this.root + path.sep) && full !== this.root)
      throw new ZoridError('vault.path.escape', `Path escapes vault: ${vaultPath}`);
  }

  #assertReallyInside(real: string, vaultPath: VaultPath): void {
    if (!real.startsWith(this.#realRoot + path.sep) && real !== this.#realRoot)
      throw new ZoridError('vault.path.escape', `Path escapes vault through symlink: ${vaultPath}`);
  }

  async readText(vaultPath: VaultPath): Promise<string> {
    return readFile(await this.#resolveExisting(vaultPath), 'utf8');
  }
  async read(vaultPath: VaultPath): Promise<string> {
    return this.readText(vaultPath);
  }
  async writeText(vaultPath: VaultPath, contents: string): Promise<void> {
    const full = await this.#resolveWritable(vaultPath);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        full,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      await handle.writeFile(contents, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP')
        throw new ZoridError('vault.path.escape', `Path escapes vault through symlink: ${vaultPath}`);
      throw error;
    } finally {
      await handle?.close();
    }
  }
  async write(vaultPath: VaultPath, contents: string): Promise<void> {
    return this.writeText(vaultPath, contents);
  }
  async createFolder(vaultPath: VaultPath): Promise<void> {
    await mkdir(await this.#resolveWritable(vaultPath), { recursive: true });
  }
  async delete(vaultPath: VaultPath): Promise<void> {
    const full = this.resolve(vaultPath);
    const info = await lstat(full);
    if (info.isSymbolicLink()) await unlink(full);
    else if (info.isDirectory()) await rm(await this.#resolveExisting(vaultPath), { recursive: true, force: true });
    else await unlink(await this.#resolveExisting(vaultPath));
  }
  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const fromFull = this.resolve(from);
    const fromInfo = await lstat(fromFull);
    const source = fromInfo.isSymbolicLink() ? fromFull : await this.#resolveExisting(from);
    await rename(source, await this.#resolveWritable(to));
  }

  async list(vaultPath = normalizeVaultPath('')): Promise<readonly VaultFileStat[]> {
    const dir = await this.#resolveExisting(vaultPath);
    const entries = await readdir(dir, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        const child = normalizeVaultPath(path.posix.join(vaultPath, entry.name));
        const info = await stat(await this.#resolveExisting(child));
        return {
          path: child,
          kind: info.isDirectory() ? 'directory' : 'file',
          mtimeMs: info.mtimeMs,
          size: info.size,
        } satisfies VaultFileStat;
      }),
    );
  }

  async stat(vaultPath: VaultPath): Promise<VaultFileStat | null> {
    try {
      const info = await stat(await this.#resolveExisting(vaultPath));
      return {
        path: vaultPath,
        kind: info.isDirectory() ? 'directory' : 'file',
        mtimeMs: info.mtimeMs,
        size: info.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  watch(listener: (event: VaultChangeEvent) => void): Disposable;
  watch(vaultPath: VaultPath, callback: (event: VaultChangeEvent) => void): Disposable;
  watch(
    vaultPathOrListener: VaultPath | ((event: VaultChangeEvent) => void),
    callback?: (event: VaultChangeEvent) => void,
  ): Disposable {
    const vaultPath = typeof vaultPathOrListener === 'function' ? normalizeVaultPath('') : vaultPathOrListener;
    const listener = typeof vaultPathOrListener === 'function' ? vaultPathOrListener : callback;
    if (!listener) throw new ZoridError('vault.watch.listener-missing', 'Vault watch listener is required.');
    const full = realpathSync(this.resolve(vaultPath));
    this.#assertReallyInside(full, vaultPath);
    const watcher: FSWatcher = fsWatch(full, { recursive: true }, (type, filename) => {
      if (filename)
        listener({ path: normalizeVaultPath(String(filename)), type: type === 'rename' ? 'changed' : 'changed' });
    });
    return { dispose: () => watcher.close() };
  }
}

export function createVaultService(root: string): FolderVault {
  return new FolderVault({ root });
}
