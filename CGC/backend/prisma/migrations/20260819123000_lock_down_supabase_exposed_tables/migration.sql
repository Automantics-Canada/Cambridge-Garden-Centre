-- Prisma-created tables inherit Supabase's public-schema grants. Without RLS,
-- the anon key could read, insert, update, or delete these rows through the
-- Data API. The application reaches both tables through Railway's database
-- connection or the Edge Function's service-role client, so browser roles do
-- not need direct access and intentionally receive no policies.

ALTER TABLE public."OrderDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SupplierProductAlias" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."OrderDocument" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."SupplierProductAlias" FROM anon, authenticated;
