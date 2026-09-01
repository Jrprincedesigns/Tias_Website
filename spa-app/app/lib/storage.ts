import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

/**
 * Wig photographs.
 *
 * The bucket is private and the browser never holds a key. To upload, the app
 * mints a signed URL scoped to one exact path; to view, it mints a signed read
 * URL that expires. The service role key stays here, on the server.
 *
 * Paths are `{memberId}/intake/{uuid}.{ext}`. The member id prefix is what lets
 * the app verify, on submit, that a path the browser hands back is one it was
 * actually given — see recordIntakePhotos.
 */

export const PHOTO_BUCKET = 'wig-photos';

/** How long a read link stays good. Long enough to look at, not to share. */
const READ_URL_TTL_SECONDS = 60 * 10;

let client: SupabaseClient | undefined;

function storage(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to upload or read photos',
    );
  }

  // Built on first use rather than at import, for the same reason the pool is:
  // a missing variable should fail the endpoint that needs it, not the server.
  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export interface SignedUpload {
  path: string;
  token: string;
  signedUrl: string;
}

/**
 * A one-path upload ticket for a member.
 *
 * The caller supplies only the file extension — the path itself is generated
 * here, so a member cannot choose where their file lands or overwrite anyone
 * else's.
 */
export async function createUploadTicket(
  memberId: string,
  extension: string,
): Promise<SignedUpload> {
  const path = `${memberId}/intake/${randomUUID()}.${extension}`;

  const { data, error } = await storage().storage
    .from(PHOTO_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new Error(`Could not prepare the upload: ${error?.message ?? 'unknown error'}`);
  }
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

/** A temporary link for viewing one photo. Null when the object is missing. */
export async function createViewUrl(path: string): Promise<string | null> {
  const { data, error } = await storage().storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(path, READ_URL_TTL_SECONDS);

  if (error || !data) return null;
  return data.signedUrl;
}
