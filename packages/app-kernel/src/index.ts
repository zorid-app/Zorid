import {
  type AppAPI,
  apiInfoFixture,
  type CapabilityName,
  type CommandContribution,
  type EventBusAPI,
  type SettingsContribution,
} from '@zorid/platform-api';
import { type Disposable, DisposableStack, type JsonValue, ZoridError } from '@zorid/shared';

export class ServiceRegistry {
  #services = new Map<string, unknown>();

  register<T>(id: string, service: T): Disposable {
    if (this.#services.has(id)) throw new ZoridError('service.duplicate', `Service already registered: ${id}`);
    this.#services.set(id, service);
    return {
      dispose: () => {
        this.#services.delete(id);
      },
    };
  }

  require<T>(id: string): T {
    if (!this.#services.has(id)) throw new ZoridError('service.missing', `Service is not registered: ${id}`);
    return this.#services.get(id) as T;
  }

  optional<T>(id: string): T | undefined {
    return this.#services.get(id) as T | undefined;
  }
}

export class EventBus implements EventBusAPI {
  #listeners = new Map<string, Set<(payload: unknown) => void>>();

  on<T = unknown>(event: string, listener: (payload: T) => void): Disposable {
    const listeners = this.#listeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener as (payload: unknown) => void);
    this.#listeners.set(event, listeners);
    return {
      dispose: () => {
        listeners.delete(listener as (payload: unknown) => void);
      },
    };
  }

  emit<T = unknown>(event: string, payload: T): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload);
  }
}

export class CommandRegistry {
  #commands = new Map<string, CommandContribution>();

  register(command: CommandContribution): Disposable {
    if (this.#commands.has(command.id))
      throw new ZoridError('command.duplicate', `Command already registered: ${command.id}`);
    this.#commands.set(command.id, command);
    return {
      dispose: () => {
        this.#commands.delete(command.id);
      },
    };
  }

  async execute(id: string, args?: JsonValue): Promise<unknown> {
    const command = this.#commands.get(id);
    if (!command) throw new ZoridError('command.missing', `Command not found: ${id}`);
    return command.callback?.(args);
  }

  list(): readonly CommandContribution[] {
    return [...this.#commands.values()];
  }
}

export class SettingsRegistry {
  #settings = new Map<string, SettingsContribution>();

  register(section: SettingsContribution): Disposable {
    if (this.#settings.has(section.id))
      throw new ZoridError('settings.duplicate', `Settings section already registered: ${section.id}`);
    this.#settings.set(section.id, section);
    return {
      dispose: () => {
        this.#settings.delete(section.id);
      },
    };
  }

  list(): readonly SettingsContribution[] {
    return [...this.#settings.values()];
  }
}

export interface CapabilityDiagnostic {
  readonly code: 'plugin.capability.missing';
  readonly capability: CapabilityName;
  readonly pluginId?: string;
}

export class CapabilityRegistry {
  #capabilities: ReadonlySet<CapabilityName>;
  #diagnostics: CapabilityDiagnostic[] = [];

  constructor(capabilities: Iterable<CapabilityName>) {
    this.#capabilities = new Set(capabilities);
  }

  has(capability: CapabilityName): boolean {
    return this.#capabilities.has(capability);
  }

  requireAll(capabilities: readonly CapabilityName[], pluginId?: string): readonly CapabilityName[] {
    const missing = capabilities.filter((capability) => !this.has(capability));
    for (const capability of missing)
      this.#diagnostics.push(
        pluginId === undefined
          ? { code: 'plugin.capability.missing', capability }
          : { code: 'plugin.capability.missing', capability, pluginId },
      );
    return missing;
  }

  diagnostics(): readonly CapabilityDiagnostic[] {
    return [...this.#diagnostics];
  }
}

export interface ZoridKernel {
  readonly app: AppAPI;
  readonly services: ServiceRegistry;
  readonly events: EventBus;
  readonly commands: CommandRegistry;
  readonly settings: SettingsRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly disposables: DisposableStack;
}

export function createZoridKernel(
  options: { version?: string; capabilities?: Iterable<CapabilityName> } = {},
): ZoridKernel {
  return {
    app: { version: options.version ?? '0.1.0', apiLevel: apiInfoFixture.apiLevel, apiInfo: () => apiInfoFixture },
    services: new ServiceRegistry(),
    events: new EventBus(),
    commands: new CommandRegistry(),
    settings: new SettingsRegistry(),
    capabilities: new CapabilityRegistry(options.capabilities ?? []),
    disposables: new DisposableStack(),
  };
}
