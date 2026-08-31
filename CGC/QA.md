# Local QA commands

All database integration and browser tests are destructive by design. They are
hard-limited to the disposable `cgc_integration` database on a loopback host and
also require an explicit opt-in. Never point these commands at staging or
production.

## Disposable database

From `CGC/backend` in PowerShell:

```powershell
npm run qa:db:start
$env:CGC_TEST_CONFIRM_DISPOSABLE = '1'
npm run qa:prepare
```

`qa:prepare` applies the complete migration chain to the disposable database,
checks schema drift, and seeds sanitized ADMIN, AP, and DRIVER fixtures. To
destroy the local container and its volume afterward, run `npm run qa:db:stop`.
When `DATABASE_URL` is unset, QA commands use only
`postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_integration`; an explicitly
provided URL is still rejected unless it targets loopback and that exact
database name.

## Test commands

With the disposable database running and the opt-in set:

```powershell
# CGC/backend
npm run test:unit
npm run test:integration
npm run qa:release

# CGC/frontend
npm test
npm run lint
npm run build
npm run test:e2e
```

`npm test` in the backend is unit-only and cannot clear a database. PostgreSQL
integration tests and Playwright each reject missing opt-in, non-loopback hosts,
and database names other than `cgc_integration`. `qa:release` runs clean installs,
audits, migrations and drift checks, backend/frontend tests and builds,
Playwright, and `git diff --check`.

## Live OCR providers

Live Textract/Groq smoke tests are separately opt-in and accept generated,
sanitized fixtures only:

```powershell
# Set only the provider credentials needed for this local smoke run.
$env:CGC_LIVE_OCR_TESTS = '1'
npm run test:live-providers
```

Do not use client documents. Groq fallback remains disabled unless explicitly
enabled, and provider credentials must never be committed or written to test
artifacts.

## Private document-storage rollout

Staging and production must use a private `SUPABASE_STORAGE_BUCKET`. The API
fails startup when the configured bucket is public. Roll out in this order:

1. mark the dedicated non-production bucket private;
2. apply the forward migration that converts durable public URLs to
   `storage://` references;
3. deploy the backend and worker, which read private objects with the service
   role and issue short-lived signed links;
4. deploy the frontend and run authenticated document/upload UAT.

These are separate deployment targets. Do not change a production bucket or
apply the production migration as part of local QA.
