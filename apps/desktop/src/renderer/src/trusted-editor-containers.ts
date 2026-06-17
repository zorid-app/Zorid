import { adaptEditorContainerContribution } from '@zorid/editor/internal/editor-container-adapter';
import type { EditorWindowContext, EditorWindowContribution } from '@zorid/editor/internal/editor-window-contributions';
import type { EditorContainerContribution } from '@zorid/platform-api';
import { slashMenuEditorContainer } from '@zorid/plugin-slash-menu/editor-containers';
import type { EditorContainerMatchDto } from './types.js';

interface TrustedEditorContainerLoader {
  readonly pluginId: string;
  readonly containerEntry: string;
  readonly containerExport: string;
  readonly contribution: EditorContainerContribution;
}

export const trustedEditorContainerLoaders: ReadonlyMap<string, TrustedEditorContainerLoader> = new Map([
  [
    'zorid.core.slash-menu.cursor',
    {
      pluginId: 'zorid.core.slash-menu',
      containerEntry: './src/editor-containers.ts',
      containerExport: 'slashMenuEditorContainer',
      contribution: slashMenuEditorContainer,
    },
  ],
]);

export interface CreateTrustedEditorContainerOptions {
  readonly match: EditorContainerMatchDto;
  readonly getText: () => string;
  readonly close?: (containerId: string) => void;
}

export function createTrustedEditorContainerContribution({
  match,
  getText,
  close,
}: CreateTrustedEditorContainerOptions): EditorWindowContribution {
  const loader = trustedEditorContainerLoaders.get(match.containerId);
  if (
    !loader ||
    loader.pluginId !== match.pluginId ||
    loader.containerEntry !== match.containerEntry ||
    loader.containerExport !== match.containerExport ||
    loader.contribution.id !== match.containerId
  )
    throw new Error(`Trusted editor container is not allowlisted: ${match.containerId}`);
  return adaptEditorContainerContribution({
    pluginId: match.pluginId as Parameters<typeof adaptEditorContainerContribution>[0]['pluginId'],
    contribution: loader.contribution,
    getText,
    ...(close === undefined ? {} : { close }),
  });
}

export function createTrustedEditorContainerContributions(
  matches: readonly EditorContainerMatchDto[],
  context: Pick<CreateTrustedEditorContainerOptions, 'getText' | 'close'>,
): readonly EditorWindowContribution[] {
  return matches.map((match) => createTrustedEditorContainerContribution({ ...context, match }));
}

export type { EditorWindowContext };
