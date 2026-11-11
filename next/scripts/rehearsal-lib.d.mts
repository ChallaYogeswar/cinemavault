export type Row = Record<string, unknown> & { id: string };
export const PRODUCTION_PROJECT_REFS: readonly string[];
export const COLUMNS: readonly string[];
export function assertSafeTargets(options: {
  sourceUrl?: string;
  destUrl: string;
  productionRefs?: readonly string[];
}): void;
export function readAllRows(
  client: unknown,
  options?: { pageSize?: number; maxPages?: number },
): Promise<Row[]>;
export function digestRows(rows: readonly Row[]): string;
export function diffRows(
  source: readonly Row[],
  target: readonly Row[],
): {
  sourceCount: number;
  targetCount: number;
  missing: string[];
  extra: string[];
  changed: { id: string; fields: { column: string; source: unknown; target: unknown }[] }[];
  identical: boolean;
};
export function profileRows(rows: readonly Row[]): Record<string, number>;
export function rehearse(options: {
  source: { readAll(): Promise<Row[]> };
  dest: unknown;
  apply: boolean;
  batchSize?: number;
  log?: (line: string) => void;
}): Promise<{
  profile: Record<string, number>;
  sourceDigest: string;
  applied: boolean;
  targetDigest?: string;
  identical?: boolean;
  diff?: ReturnType<typeof diffRows>;
}>;
