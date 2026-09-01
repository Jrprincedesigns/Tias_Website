-- Storage for wig photographs: intake shots from members, arrival documentation
-- and before/after work from the studio.
--
-- Buckets are Postgres rows, so this belongs in a migration rather than a few
-- clicks in the dashboard — it travels with the repo and reproduces on a fresh
-- project.
--
-- Guarded on the storage schema existing so the file is harmless against a
-- plain PostgreSQL instance, which is what the integration tests run against.

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'No storage schema (not a Supabase database) — skipping bucket creation.';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'wig-photos',
    'wig-photos',
    -- Private. These are photographs of a customer's property, often taken in
    -- their home. Every read goes through a signed URL minted by the app.
    false,
    20971520,                                    -- 20 MB
    array[
      'image/jpeg',
      'image/png',
      'image/webp',
      -- iPhones shoot HEIC by default. Some upload paths convert it to JPEG and
      -- some do not, and a member whose photo is silently rejected will assume
      -- the whole form is broken.
      'image/heic',
      'image/heif'
    ]
  )
  on conflict (id) do nothing;
end
$$;

-- No row level security policies are added on purpose.
--
-- storage.objects has RLS enabled by Supabase, and nothing but the app's
-- service role touches this bucket — that role bypasses RLS. Customers never
-- hold a key: they upload through a signed URL the app mints for one specific
-- path, and read through signed URLs with an expiry. Adding permissive policies
-- here would widen access to exactly the people the signed-URL flow exists to
-- keep out.
