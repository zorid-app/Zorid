import type { BaseQueryResult } from './query.ts';
import { displayBaseProperty } from './presentation-common.ts';
import { sharedBaseCoverage, sharedBasePreview } from './shared-query.ts';

export type BaseExportFormat = 'csv' | 'tsv' | 'markdown' | 'paths';

/** Export an admitted result, never DOM rows or another query implementation. */
export function exportBaseResults(result: BaseQueryResult, format: BaseExportFormat,
  label: (property: string) => string = property => property.replace(/^(?:note|file|formula)\./, '')): string {
  if (sharedBasePreview(result)) throw new Error('Wait for indexing to finish before exporting results.');
  const coverage = sharedBaseCoverage(result);
  if (coverage && (!coverage.generationComplete || !coverage.metadataComplete)) throw new Error('Some saved files or properties are unavailable. Refresh before exporting.');
  if (result.counts.returned !== result.rows.length) throw new Error('The result is not fully materialized. Refresh before exporting.');
  if (format === 'paths') return result.rows.map(row => row.path).join('\n');
  const cells = [result.properties.map(label), ...result.rows.map(row => result.properties.map(property =>
    row.values[property] ? displayBaseProperty(row.values[property], result.shared !== undefined) : ''))];
  if (format === 'markdown') {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    const line = (values: readonly string[]) => `| ${values.map(escape).join(' | ')} |`;
    return [line(cells[0]), line(result.properties.map(() => '---')), ...cells.slice(1).map(line)].join('\n');
  }
  const delimiter = format === 'csv' ? ',' : '\t';
  const escape = (value: string) => value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return cells.map(row => row.map(escape).join(delimiter)).join('\r\n');
}
