export interface PolicyOptions {
  connect?: readonly string[];
  upgradeInsecure?: boolean;
}
export const SUPABASE_HOST: string;
export const TMDB_IMAGE_HOST: string;
export const GOOGLE_FONTS_STYLE_HOST: string;
export const GOOGLE_FONTS_FILE_HOST: string;
export function cspDirectives(options?: PolicyOptions): Record<string, readonly string[]>;
export function buildCsp(options?: PolicyOptions): string;
export function securityHeaders(options?: PolicyOptions): { key: string; value: string }[];
export function securityHeaderMap(options?: PolicyOptions): Record<string, string>;
export function applySecurityHeaders<T extends { headers?: unknown }>(config: T): T;
