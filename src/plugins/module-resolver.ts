import { Plugin } from './plugin.ts';

export type PluginRequire = (specifier: string) => unknown;
export type ModuleNamespace = Readonly<Record<string, unknown>>;

const aliases: Readonly<Record<string, string>> = {
  '@codemirror/text': '@codemirror/state',
  '@codemirror/rangeset': '@codemirror/state',
  '@codemirror/gutter': '@codemirror/view',
  '@codemirror/panel': '@codemirror/view',
  '@codemirror/rectangular-selection': '@codemirror/view',
  '@codemirror/tooltip': '@codemirror/view',
  '@codemirror/fold': '@codemirror/language',
  '@codemirror/highlight': '@codemirror/language',
  '@codemirror/matchbrackets': '@codemirror/language',
  '@codemirror/stream-parser': '@codemirror/language',
  '@codemirror/comment': '@codemirror/commands',
  '@codemirror/history': '@codemirror/commands',
  '@codemirror/closebrackets': '@codemirror/autocomplete',
};

export const sharedModuleNames = [
  'obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/language',
  '@codemirror/commands', '@codemirror/autocomplete', '@codemirror/collab',
  '@codemirror/lint', '@codemirror/search', '@lezer/common', '@lezer/lr', '@lezer/highlight',
] as const;
export type SharedModuleName = typeof sharedModuleNames[number];
export type SharedPluginModules = Partial<Record<SharedModuleName, ModuleNamespace>> & {
  obsidian: ModuleNamespace & { Plugin: typeof Plugin };
};

export interface ModuleResolverOptions {
  modules: SharedPluginModules;
  nativeRequire?: PluginRequire;
  /** Mirrors the audited desktop emulation mode; not a claim about Capacitor. */
  emulateMobile?: boolean;
  diagnostic?: (message: string) => void;
}

/** The caller must supply the very same namespaces used by the active editor. */
export function createPluginRequire(options: ModuleResolverOptions): PluginRequire {
  if (options.modules.obsidian.Plugin !== Plugin) {
    throw new Error('The obsidian namespace must use the shared Plugin constructor');
  }
  const modules = new Map<string, ModuleNamespace>();
  for (const name of sharedModuleNames) {
    const namespace = options.modules[name];
    if (namespace) modules.set(name, namespace);
  }
  const knownNames = new Set<string>(sharedModuleNames);
  const diagnostic = options.diagnostic ?? (message => console.error(new Error(message)));
  return specifier => {
    const canonical = Object.hasOwn(aliases, specifier) ? aliases[specifier] : specifier;
    if (canonical !== specifier && specifier !== '@codemirror/text') {
      diagnostic(`Deprecated plugin import: ${specifier}; use ${canonical}`);
    }
    if (knownNames.has(canonical)) {
      if (!modules.has(canonical)) throw new Error(`Host has not supplied shared module: ${canonical}`);
      return modules.get(canonical);
    }
    if (options.emulateMobile) {
      diagnostic(`Node module unavailable in mobile emulation: ${specifier}`);
      return null;
    }
    if (options.nativeRequire) return options.nativeRequire(specifier);
    throw new Error(`Plugin module unavailable: ${specifier}`);
  };
}
