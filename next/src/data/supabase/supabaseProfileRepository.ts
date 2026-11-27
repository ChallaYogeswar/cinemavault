import type { SupabaseClient } from '@supabase/supabase-js';
import { err, ok, type Result } from '@/domain/result';
import type { ProfileRepository } from '@/data/repositories/profileRepository';
import { mapDbError, networkError } from './dbErrors';

/** Reads the caller's own profile row (RLS allows nothing else). Role resolution is elsewhere. */
function nameOf(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || !('display_name' in row)) return null;
  const value = row.display_name;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function createSupabaseProfileRepository(client: SupabaseClient): ProfileRepository {
  return {
    async load(userId): Promise<Result<unknown>> {
      try {
        const { data, error, status } = await client
          .from('profiles')
          .select('role')
          .eq('id', userId)
          .maybeSingle();
        if (error) return { ok: false, error: mapDbError(error, status) };
        return ok(data);
      } catch (cause) {
        return err('network', networkError(cause).message, cause);
      }
    },

    async loadDisplayName(userId): Promise<Result<string | null>> {
      try {
        const { data, error, status } = await client
          .from('profiles')
          .select('display_name')
          .eq('id', userId)
          .maybeSingle();
        if (error) return { ok: false, error: mapDbError(error, status) };
        return ok(nameOf(data));
      } catch (cause) {
        return err('network', networkError(cause).message, cause);
      }
    },

    async updateDisplayName(userId, name): Promise<Result<string | null>> {
      try {
        // Asking for the row back is how a refused or missing update is told from a saved one:
        // row-level security answers "0 rows", not an error.
        const { data, error, status } = await client
          .from('profiles')
          .update({ display_name: name })
          .eq('id', userId)
          .select('display_name')
          .maybeSingle();
        if (error) return { ok: false, error: mapDbError(error, status) };
        if (!data)
          return err('not_found', 'Your profile could not be found, so nothing was saved.');
        return ok(nameOf(data));
      } catch (cause) {
        return err('network', networkError(cause).message, cause);
      }
    },
  };
}
