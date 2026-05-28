import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type {
  EditorAPI,
  EditorChange,
  EditorCommandContribution,
  EditorExtensionContribution,
  EditorHandle,
  EditorUpdateEvent,
  OpenDocumentOptions,
} from '@zorid/platform-api';
import { type Disposable, normalizeVaultPath, type VaultPath } from '@zorid/shared';

export interface EditorDocumentStore {
  read(path: VaultPath): Promise<string>;
  write(path: VaultPath, contents: string): Promise<void>;
}

export class MarkdownEditorHandle implements EditorHandle {
  readonly id: string;
  readonly path: VaultPath;
  #initialText: string;
  #text: string;
  #store: EditorDocumentStore;
  #listeners = new Set<(event: EditorUpdateEvent) => void>();
  state: EditorState;

  constructor(path: VaultPath, text: string, store: EditorDocumentStore) {
    this.id = `editor:${path}`;
    this.path = path;
    this.#initialText = text;
    this.#text = text;
    this.#store = store;
    this.state = EditorState.create({ doc: text, extensions: [markdown()] });
  }

  getText(): string {
    return this.#text;
  }
  setText(value: string): void {
    this.#text = value;
    this.state = EditorState.create({ doc: value, extensions: [markdown()] });
    this.#emit();
  }
  dispatch(change: EditorChange): void {
    const from = change.from ?? 0;
    const to = change.to ?? this.#text.length;
    this.setText(`${this.#text.slice(0, from)}${change.insert}${this.#text.slice(to)}`);
  }
  async save(): Promise<void> {
    await this.#store.write(this.path, this.#text);
    this.markSaved();
  }
  focus(): void {
    /* focus is host-owned in the desktop shell; no-op for headless service. */
  }
  onUpdate(listener: (event: EditorUpdateEvent) => void): Disposable {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
  dispose(): void {
    this.#listeners.clear();
  }
  isDirty(): boolean {
    return this.#text !== this.#initialText;
  }
  markSaved(): void {
    this.#initialText = this.#text;
    this.#emit();
  }
  #emit(): void {
    const event = { text: this.#text, dirty: this.isDirty() };
    for (const listener of this.#listeners) listener(event);
  }
}

export class EditorService implements EditorAPI {
  #store: EditorDocumentStore;
  #active?: MarkdownEditorHandle;
  #extensions: EditorExtensionContribution[] = [];
  #commands: EditorCommandContribution[] = [];

  constructor(store: EditorDocumentStore) {
    this.#store = store;
  }
  getActiveEditor(): EditorHandle | null {
    return this.#active ?? null;
  }
  activeEditor(): EditorHandle | undefined {
    return this.#active;
  }
  async openDocument(path: VaultPath, _options: OpenDocumentOptions = {}): Promise<EditorHandle> {
    const text = await this.#store.read(path);
    this.#active = new MarkdownEditorHandle(path, text, this.#store);
    return this.#active;
  }
  async open(path: VaultPath): Promise<EditorHandle> {
    return this.openDocument(path);
  }
  async save(handle: EditorHandle): Promise<void> {
    await handle.save();
  }
  registerExtension(extension: EditorExtensionContribution) {
    this.#extensions.push(extension);
    return {
      dispose: () => {
        this.#extensions = this.#extensions.filter((item) => item.id !== extension.id);
      },
    };
  }
  registerCommand(command: EditorCommandContribution) {
    this.#commands.push(command);
    return {
      dispose: () => {
        this.#commands = this.#commands.filter((item) => item.id !== command.id);
      },
    };
  }
  registeredExtensions(): readonly EditorExtensionContribution[] {
    return [...this.#extensions];
  }
  registeredCommands(): readonly EditorCommandContribution[] {
    return [...this.#commands];
  }
}

export function createInMemoryEditorStore(initial: Record<string, string> = {}): EditorDocumentStore {
  const files = new Map(Object.entries(initial));
  return {
    read: async (path) => files.get(path) ?? '',
    write: async (path, contents) => {
      files.set(path, contents);
    },
  };
}

export function createEditorService(
  store = createInMemoryEditorStore({ [normalizeVaultPath('Untitled.md')]: '' }),
): EditorService {
  return new EditorService(store);
}
