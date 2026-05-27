import type { JsonValue } from '@zorid/shared';
import type { PluginStatus, VaultEntry, VaultProfile } from '@zorid/platform-api';
import type { BacklinkDto, BaseDto, CommandDto, DataViewResultDto, FieldValidationDiagnosticDto, FileFieldsDto, IndexStatusDto, MarkdownEmbedDto, OutlineItemDto, SearchResultDto, SettingsSectionDto, SettingValueDto, TagDto, TypeDto } from './main/runtime.js';

export interface DesktopBridge {
  openVault(): Promise<VaultProfile | undefined>;
  getVaultProfile(): Promise<VaultProfile | undefined>;
  listVault(path?: string): Promise<readonly VaultEntry[]>;
  readVaultText(path: string): Promise<string>;
  writeVaultText(path: string, contents: string): Promise<void>;
  createVaultFolder(path: string): Promise<void>;
  createMarkdownFile(path: string, contents?: string): Promise<void>;
  renameVaultPath(from: string, to: string): Promise<void>;
  deleteVaultPath(path: string): Promise<void>;
  getIndexStatus(): Promise<IndexStatusDto>;
  rebuildIndex(): Promise<IndexStatusDto>;
  searchIndex(query: string): Promise<readonly SearchResultDto[]>;
  getBacklinks(path: string): Promise<readonly BacklinkDto[]>;
  listTags(): Promise<readonly TagDto[]>;
  getOutline(path: string): Promise<readonly OutlineItemDto[]>;
  listTypes(): Promise<readonly TypeDto[]>;
  getFileFields(path: string): Promise<FileFieldsDto>;
  updateFileField(path: string, key: string, value: unknown): Promise<FileFieldsDto>;
  setFileType(path: string, typeName?: string): Promise<FileFieldsDto>;
  listBases(): Promise<readonly BaseDto[]>;
  renderDataView(basePath: string, viewId?: string): Promise<DataViewResultDto>;
  getMarkdownEmbeds(path: string): Promise<readonly MarkdownEmbedDto[]>;
  onIndexUpdated(callback: () => void): () => void;
  listCommands(): Promise<readonly CommandDto[]>;
  executeCommand(id: string, args?: JsonValue): Promise<unknown>;
  listPluginStatuses(): Promise<readonly PluginStatus[]>;
  listSettingsSections(): Promise<readonly SettingsSectionDto[]>;
  getSettingValue(sectionId: string, pluginId?: string): Promise<SettingValueDto>;
  setSettingValue(sectionId: string, value: JsonValue, pluginId?: string): Promise<SettingValueDto>;
}

export const preloadApiName = 'zoridDesktop' as const;

export function renderDesktopPlaceholder(root: HTMLElement): void {
  root.innerHTML = '<main data-zorid-shell><aside data-region="left-sidebar"></aside><section data-region="editor"></section><aside data-region="right-sidebar"></aside></main>';
}
