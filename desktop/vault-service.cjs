'use strict';
const fs = require('node:fs/promises');
const { watch, constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Own implementation: every operation is scoped to one explicitly selected vault.
function normalizePath(input, allowRoot = false) {
  if (typeof input !== 'string' || /[\u0000-\u001f]/.test(input) || input.includes('\\') || /^[A-Za-z]:/.test(input) || path.isAbsolute(input)) throw new Error('Invalid vault path');
  const parts = input.split('/');
  if (parts.some(part => part === '..' || part === '.')) throw new Error('Invalid vault path');
  const result = parts.filter(Boolean).join('/');
  if (!result && !allowRoot) throw new Error('A file or folder path is required');
  return result;
}

class VaultService {
  constructor(root) { this.root = root; }
  static async open(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('An absolute vault folder is required');
    const resolved = await fs.realpath(root);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Vault must be a folder');
    return new VaultService(resolved);
  }
  async resolve(input, allowRoot = false) {
    const relative = normalizePath(input, allowRoot);
    // Reject symlinks even when they point inside the vault: moving a linked
    // ancestor otherwise creates surprising access outside the selected tree.
    let current = this.root;
    for (const part of relative.split('/').filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not supported in vault paths');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
  }
  async list(input = '') {
    const relative = normalizePath(input, true);
    const root = await this.resolve(relative, true);
    const entries = [];
    const walk = async (directory, prefix) => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
        const absolute = await this.resolve(itemPath);
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() && !stat.isDirectory()) continue;
        entries.push({ path: itemPath, type: stat.isDirectory() ? 'folder' : 'file', mtime: stat.mtimeMs, size: stat.size });
        if (stat.isDirectory()) await walk(absolute, itemPath);
      }
    };
    await walk(root, relative);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async stat(input) {
    const relative = normalizePath(input);
    const target = await this.resolve(relative);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported in vault paths');
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Unsupported vault entry');
      return { path: relative, type: stat.isDirectory() ? 'folder' : 'file', mtime: stat.mtimeMs, size: stat.size };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async read(input) {
    const target = await this.resolve(input);
    const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await file.readFile('utf8'); } finally { await file.close(); }
  }
  async readBinary(input) {
    const target = await this.resolve(input);
    const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return new Uint8Array(await file.readFile()); } finally { await file.close(); }
  }
  async write(input, content) {
    if (typeof content !== 'string') throw new Error('Note contents must be text');
    return this.writeBinary(input, Buffer.from(content, 'utf8'));
  }
  async writeBinary(input, data) {
    if (!(data instanceof Uint8Array)) throw new Error('Attachment contents must be a Uint8Array');
    // Capture the caller's selected byte view before asynchronous filesystem work.
    const content = Buffer.from(data);
    const target = await this.resolve(input);
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true });
    await this.resolve(input);
    const temporary = path.join(directory, `.zorid-write-${randomUUID()}`);
    let mode = 0o600;
    try { mode = (await fs.stat(target)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await file.writeFile(content);
      await file.sync();
      await file.close();
      await this.resolve(input);
      await fs.rename(temporary, target);
    } catch (error) {
      await file.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async mkdir(input) {
    await fs.mkdir(await this.resolve(input), { recursive: true });
  }
  async rename(from, to) {
    const source = await this.resolve(from);
    const destination = await this.resolve(to);
    if (source === destination) return;
    if (destination.startsWith(`${source}${path.sep}`)) throw new Error('Cannot move a folder into itself');
    try { await fs.lstat(destination); throw new Error('A file or folder already exists at the destination'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await this.resolve(to);
    await fs.rename(source, destination);
  }
  async trash(input) {
    const relative = normalizePath(input);
    if (relative === '.trash' || relative.startsWith('.trash/')) throw new Error('Cannot trash the recovery folder');
    const source = await this.resolve(relative);
    const destinationRelative = `.trash/${Date.now()}-${randomUUID()}/${relative}`;
    const destination = await this.resolve(destinationRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await this.resolve(destinationRelative);
    await fs.rename(source, destination);
  }
  subscribe(listener) {
    let closed = false;
    let scanning = false;
    let previous = new Map();
    const watcher = watch(this.root, { recursive: true }, (event, file) => {
      const relative = file?.toString().split(path.sep).join('/');
      if (!relative || relative.split('/').some(part => part.startsWith('.'))) return;
      listener({ type: event, path: relative });
    });
    watcher.on('error', error => listener({ type: 'error', message: error.message }));
    // Native watch events can be coalesced or absent on mounted filesystems.
    // Poll metadata as a fallback, also detecting notes written by other apps.
    const timer = setInterval(async () => {
      if (closed || scanning) return;
      scanning = true;
      try {
        const current = new Map((await this.list()).map(entry => [entry.path, `${entry.mtime}:${entry.size}:${entry.type}`]));
        if (!closed) {
          for (const [file, signature] of current) if (previous.get(file) !== signature) listener({ type: 'change', path: file });
          for (const file of previous.keys()) if (!current.has(file)) listener({ type: 'rename', path: file });
        }
        previous = current;
      } catch (error) { if (!closed) listener({ type: 'error', message: error.message }); }
      finally { scanning = false; }
    }, 750);
    timer.unref();
    return () => { closed = true; clearInterval(timer); watcher.close(); };
  }
}
module.exports = { VaultService, normalizePath };
