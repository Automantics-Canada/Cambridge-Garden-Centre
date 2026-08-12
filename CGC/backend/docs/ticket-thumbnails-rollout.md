# Ticket thumbnails — rollout runbook

Nothing in this document has been executed. No migration was applied and no
backfill was run against any environment.

## Why

Proof-of-delivery photos arrive from phone cameras at full resolution — a
sample measured in production is **615 KB at 1800×2391** — and the tickets list
rendered them into a 48 CSS px box. A 50-row page therefore transferred roughly
**30 MB**. Supabase's `render/image` transform endpoint returns **403** on the
current plan, so the resize is done in the backend instead.

Measured on synthetic fixtures (`npx tsx tests/fixtures/measure.ts`):

| fixture | source dims | source bytes | thumb bytes | thumb dims | reduction |
|---|---|---:|---:|---|---:|
| phone photo, portrait (JPEG q90) | 1800x2391 | 99,129 | 368 | 128x128 | 99.6% |
| phone photo, landscape (JPEG q90) | 2391x1800 | 123,260 | 876 | 128x128 | 99.3% |
| flatbed scan (PNG) | 1010x752 | 38,125 | 988 | 128x128 | 97.4% |
| small photo (JPEG q90) | 747x827 | 34,423 | 772 | 128x128 | 97.8% |
| already WebP | 1800x2391 | 26,378 | 400 | 128x128 | 98.5% |
| **all five** | | **321,315** | **3,404** | | **98.9%** |

These are synthetic. Real production photographs will compress differently.
Re-measure after rollout; do not quote these as production figures.

## Order of operations

### 1. Apply the migration

```bash
cd CGC/backend
npx prisma migrate deploy
```

Adds `Ticket.thumbnailUrl TEXT NULL`. Additive and nullable — existing rows are
untouched and the application already falls back to `imageUrl` when the column
is null. Safe to deploy before the application code.

**Rollback:**

```sql
ALTER TABLE "public"."Ticket" DROP COLUMN "thumbnailUrl";
```

Dropping the column loses only the pointers. The thumbnail objects remain in
storage under `ticket-thumbnails/` and would be recreated at the same
deterministic keys if the column is re-added and the backfill re-run.

### 2. Deploy the backend

New uploads generate a thumbnail automatically. Generation is best-effort: if
it fails, the original is still stored, `thumbnailUrl` stays null, the upload
still succeeds, and a line is logged naming the object and the retry command.

### 3. Deploy the frontend

List and grid views prefer `thumbnailUrl` and fall back to `imageUrl`. The
review modal and the download action always use the original.

### 4. Backfill existing tickets

Dry run first. This is the default; it writes nothing.

```bash
cd CGC/backend
npm run backfill:thumbnails
```

Then apply, starting small:

```bash
npm run backfill:thumbnails -- --apply --limit=25 --concurrency=3
```

Inspect the output, then continue. Re-running is safe — it only selects rows
where `thumbnailUrl IS NULL`, so completed rows are skipped and an interrupted
run resumes where it stopped.

```bash
npm run backfill:thumbnails -- --apply --limit=500 --concurrency=3
```

**Flags**

| Flag | Default | Meaning |
|---|---|---|
| `--apply` | off | Required to write. Without it the run is a dry run. |
| `--limit=N` | 500 | Maximum rows considered in one run. |
| `--concurrency=N` | 3 | Parallel workers, capped at 8. |

**Failure behaviour**

- A failing ticket is recorded and the run continues; it does not abort the batch.
- Failed ids are printed at the end and the process exits non-zero.
- Failed rows keep `thumbnailUrl = NULL`, so the next run retries them.
- The row is updated **only after** the thumbnail upload succeeds, so a
  `thumbnailUrl` never points at bytes that do not exist.
- The update is scoped to rows still null, so two concurrent runs cannot
  double-write the same row.
- Originals are never modified, moved or deleted by any path in this feature.

**Bounds**

- Downloads: 20s timeout, 25 MB ceiling, redirects refused.
- Source URLs must match the configured Supabase origin; anything else is refused.
- Decoding is capped at 40 megapixels to bound the worst-case allocation.

### 5. Verify

- A newly uploaded ticket has a non-null `thumbnailUrl`.
- The tickets list renders thumbnails and the transferred bytes drop sharply.
- The review modal still shows the full-resolution original.
- Download still returns the original file.
- Rows that failed backfill still display via the `imageUrl` fallback.
- Re-measure the Tickets page with the Resource Timing API and compare against
  the pre-change capture.

## Notes

- `sharp` is the image library. Its Linux binaries (`@img/sharp-linux-x64`,
  `@img/sharp-linuxmusl-x64`, and arm variants) are present in
  `package-lock.json` as optional dependencies, so `npm ci` on Railway resolves
  the correct platform build. Verified: lockfile v3 carries all 16 Linux entries.
- Thumbnails are written with `cache-control: public, max-age=31536000,
  immutable`. This is only sound because the key is derived from the original's
  path, which already contains a uuid and a timestamp — a given URL can never
  point at different bytes. Do not copy that header onto a mutable key.
- EXIF is applied then dropped: orientation is baked into the pixels, and no
  metadata — including any GPS coordinates from the driver's phone — survives
  into the thumbnail.
