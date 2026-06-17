import type { PluginStatus, VaultEntry, VaultProfile } from '@zorid/platform-api';
import type {
  BacklinkDto,
  BaseDto,
  CommandDto,
  DataViewResultDto,
  EditorContainerMatchDto,
  FieldDto,
  FileFieldsDto,
  FileRendererMatchDto,
  IndexStatusDto,
  MarkdownEmbedDto,
  OutlineItemDto,
  SearchCandidateDto,
  SearchResultDto,
  SettingsSectionDto,
  TagDto,
  TypeDto,
} from '../../index.js';
import type { VaultWindowRole } from '../../main/vault-window-manager.js';

export type {
  BacklinkDto,
  BaseDto,
  CommandDto,
  DataViewResultDto,
  EditorContainerMatchDto,
  FieldDto,
  FileFieldsDto,
  FileRendererMatchDto,
  IndexStatusDto,
  MarkdownEmbedDto,
  OutlineItemDto,
  SearchCandidateDto,
  SearchResultDto,
  SettingsSectionDto,
  TagDto,
  TypeDto,
};
export type WindowRole = VaultWindowRole;
export type VaultProfileDto = VaultProfile;
export type { PluginStatus, VaultEntry };

export interface RecentVaultDto {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
}
export interface EditorSnapshotDto {
  readonly profile?: VaultProfileDto;
  readonly indexStatus: IndexStatusDto;
}

export interface SettingProperty {
  readonly name: string;
  readonly title: string;
  readonly type: string;
  readonly description?: string;
  readonly defaultValue?: unknown;
  readonly enumValues?: readonly string[];
}
