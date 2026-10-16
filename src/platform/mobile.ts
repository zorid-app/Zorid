import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { VaultAdapter, VaultEntry } from '../core/types';
import { vaultPath } from './path.ts';
import { base64ToBytes, bytesToBase64 } from './binary.ts';

/** Files are ordinary UTF-8 Markdown in Documents/Zorid on native mobile. */
export class MobileAdapter implements VaultAdapter {
  private readonly filesystem: typeof Filesystem;
  constructor(filesystem = Filesystem) { this.filesystem = filesystem; }
  private readonly directory = Directory.Documents;
  private readonly root = 'Zorid';
  private readonly listeners = new Set<(paths?: readonly string[]) => void>();
  private nativePath(input: string, root = false): string {
    const path = vaultPath(input, root);
    return path ? `${this.root}/${path}` : this.root;
  }
  private changed(paths?: readonly string[]): void { this.listeners.forEach(listener => listener(paths)); }
  async initialize(): Promise<void> {
    if (await this.exists(this.root)) {
      if ((await this.filesystem.stat({ path: this.root, directory: this.directory })).type !== 'directory') throw new Error('The mobile vault path is not a folder');
    } else await this.filesystem.mkdir({ path: this.root, directory: this.directory, recursive: true });
  }
  private async exists(path: string): Promise<boolean> {
    try { await this.filesystem.stat({ path, directory: this.directory }); return true; }
    catch (error) {
      // Filesystem versions/platforms use differing missing-file codes. Verify
      // the parent directory listing so permission failures are not swallowed.
      const slash = path.lastIndexOf('/');
      const parent = slash < 0 ? '' : path.slice(0, slash);
      if (parent && !(await this.exists(parent))) return false;
      const listing = await this.filesystem.readdir({ path: parent, directory: this.directory });
      if (!listing.files.some(file => file.name === path.slice(slash + 1))) return false;
      throw error;
    }
  }
  async list(): Promise<VaultEntry[]> {
    const entries: VaultEntry[] = [];
    const walk = async (relative: string): Promise<void> => {
      const result = await this.filesystem.readdir({ path: this.nativePath(relative, true), directory: this.directory });
      for (const file of result.files) {
        if (file.name.startsWith('.')) continue;
        const path = relative ? `${relative}/${file.name}` : file.name;
        entries.push({ path, type: file.type === 'directory' ? 'folder' : 'file', mtime: file.mtime, size: file.size });
        if (file.type === 'directory') await walk(path);
      }
    };
    await walk('');
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async stat(input: string): Promise<VaultEntry | null> {
    const path = vaultPath(input), native = this.nativePath(path);
    try {
      const entry = await this.filesystem.stat({ path: native, directory: this.directory });
      return { path, type: entry.type === 'directory' ? 'folder' : 'file', mtime: entry.mtime, size: entry.size };
    } catch (error) {
      if (!(await this.exists(native))) return null;
      throw error;
    }
  }
  async read(path: string): Promise<string> {
    const result = await this.filesystem.readFile({ path: this.nativePath(path), directory: this.directory, encoding: Encoding.UTF8 });
    return typeof result.data === 'string' ? result.data : result.data.text();
  }
  async readBinary(path: string): Promise<Uint8Array> {
    const result = await this.filesystem.readFile({ path: this.nativePath(path), directory: this.directory });
    return typeof result.data === 'string' ? base64ToBytes(result.data) : new Uint8Array(await result.data.arrayBuffer());
  }
  async write(path: string, data: string): Promise<void> {
    return this.writeEncoded(path, data, Encoding.UTF8);
  }
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.writeEncoded(path, bytesToBase64(data));
  }
  private async writeEncoded(path: string, data: string, encoding?: Encoding): Promise<void> {
    const destination = this.nativePath(path);
    if (await this.exists(destination)) {
      if ((await this.filesystem.stat({ path: destination, directory: this.directory })).type !== 'file') throw new Error('Path is a folder');
    }
    const slash = destination.lastIndexOf('/');
    const temporary = `${destination.slice(0, slash)}/.zorid-write-${crypto.randomUUID()}`;
    await this.filesystem.writeFile({ path: temporary, directory: this.directory, data, ...(encoding ? { encoding } : {}), recursive: true });
    try { await this.filesystem.rename({ from: temporary, to: destination, directory: this.directory }); }
    catch (error) { await this.filesystem.deleteFile({ path: temporary, directory: this.directory }).catch(() => {}); throw error; }
    this.changed([vaultPath(path)]);
  }
  async mkdir(path: string): Promise<void> {
    const native = this.nativePath(path);
    if (await this.exists(native)) {
      if ((await this.filesystem.stat({ path: native, directory: this.directory })).type !== 'directory') throw new Error('Path is a file');
      return;
    }
    await this.filesystem.mkdir({ path: native, directory: this.directory, recursive: true });
    this.changed();
  }
  async rename(input: string, output: string): Promise<void> {
    const from = vaultPath(input);
    const to = vaultPath(output);
    if (from === to) return;
    if (to.startsWith(`${from}/`)) throw new Error('Cannot move a folder into itself');
    if (await this.exists(this.nativePath(to))) throw new Error('Destination already exists');
    const slash = to.lastIndexOf('/');
    if (slash > 0) await this.mkdir(to.slice(0, slash));
    await this.filesystem.rename({ from: this.nativePath(from), to: this.nativePath(to), directory: this.directory });
    this.changed();
  }
  async trash(input: string): Promise<void> {
    const path = vaultPath(input);
    if (path === '.trash' || path.startsWith('.trash/')) throw new Error('Cannot trash the recovery folder');
    await this.rename(path, `.trash/${Date.now()}-${crypto.randomUUID()}/${path}`);
  }
  subscribe(listener: (paths?: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    let closed = false;
    let busy = false;
    let previous: Map<string, string> | undefined;
    // The filesystem plugin has no portable native watcher. A metadata scan
    // detects edits made through the platform's document provider as well.
    const timer = setInterval(async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const current = new Map((await this.list()).map(file => [file.path, `${file.type}:${file.mtime}:${file.size}`]));
        if (!closed) {
          if (!previous) listener();
          else {
            const changed = [...current].filter(([path, signature]) => previous!.get(path) !== signature).map(([path]) => path);
            for (const path of previous.keys()) if (!current.has(path)) changed.push(path);
            if (changed.length) listener(changed);
          }
        }
        previous = current;
      } catch { /* Direct file operations report actionable storage errors. */ }
      finally { busy = false; }
    }, 2000);
    return () => { closed = true; clearInterval(timer); this.listeners.delete(listener); };
  }
}
