/**
 * Signed URLs for wig photographs.
 *
 * The `wig-photos` bucket is private (see 0002_wig_photos_bucket.sql): these are
 * pictures of a customer's property, often taken in their home. Nothing is
 * served from a public URL. The app holds the service-role key and mints a
 * short-lived signed URL per read, which is why the key must never reach the
 * browser — only the signed URL does.
 *
 * Talks to the Storage REST API directly rather than pulling in
 * @supabase/supabase-js. One POST is all this needs, and a dependency added for
 * one call is a dependency to keep patched forever.
 *
 * Every failure here is soft. A photo that will not sign should leave a gap in
 * a gallery, never take down the panel around it — so callers get null for that
 * path and render their placeholder.
 */

const BUCKET = 'wig-photos';

/** An hour: long enough to read a page and reload it, short enough to expire. */
const EXPIRES_IN_SECONDS = 3600;

let warnedMissingConfig = false;

function config(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[photos] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — photos will render as placeholders',
      );
    }
    return null;
  }
  return { url: url.replace(/\/+$/, ''), key };
}

/**
 * Signs many paths in one request.
 *
 * Returns a Map from storage path to signed URL. A path that cannot be signed —
 * missing object, revoked key, network trouble — is simply absent from the map
 * rather than present with a broken value, so a caller cannot mistake one for
 * the other.
 */
export async function signPhotoUrls(paths: readonly string[]): Promise<Map<string, string>> {
  const signed = new Map<string, string>();

  const unique = Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
  if (unique.length === 0) return signed;

  const conf = config();
  if (!conf) return signed;

  try {
    const response = await fetch(`${conf.url}/storage/v1/object/sign/${BUCKET}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conf.key}`,
        apikey: conf.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: EXPIRES_IN_SECONDS, paths: unique }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(`[photos] signing failed: ${response.status} ${response.statusText}`);
      return signed;
    }

    // Shape: [{ path, signedURL, error }] — `error` is per item, so one missing
    // object does not cost the whole batch.
    const rows = (await response.json()) as Array<{
      path?: string | null;
      signedURL?: string | null;
      error?: string | null;
    }>;

    if (!Array.isArray(rows)) return signed;

    for (const row of rows) {
      if (!row || row.error || !row.path || !row.signedURL) continue;
      // signedURL comes back relative, e.g. /object/sign/wig-photos/<path>?token=…
      const suffix = row.signedURL.startsWith('/') ? row.signedURL : `/${row.signedURL}`;
      signed.set(row.path, `${conf.url}/storage/v1${suffix}`);
    }
  } catch (error) {
    console.warn('[photos] signing failed:', error instanceof Error ? error.message : error);
  }

  return signed;
}
