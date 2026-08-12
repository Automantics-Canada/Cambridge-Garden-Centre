/**
 * Backfill thumbnails for tickets uploaded before thumbnail generation existed,
 * and retry any whose generation failed at upload time.
 *
 * Deliberately a supervised CLI rather than lazy generation on first view: with
 * lazy generation an unlucky operator pays the cost at an unpredictable moment,
 * and the first person to open a month-end batch would absorb all of it.
 *
 *   Dry run (default, writes nothing):
 *     npm run backfill:thumbnails
 *   Apply:
 *     npm run backfill:thumbnails -- --apply
 *   Bound a run:
 *     npm run backfill:thumbnails -- --apply --limit=100 --concurrency=3
 *
 * Safety properties:
 *   - Dry run is the default; --apply is required to write anything.
 *   - Selects only rows where thumbnailUrl IS NULL, so it resumes naturally and
 *     is safe to re-run after a partial or interrupted pass.
 *   - Storage keys are a pure function of the original path, so a repeat run
 *     overwrites the same object instead of accumulating duplicates.
 *   - Bounded concurrency, per-download timeout and byte ceiling.
 *   - Source URLs must match the configured Supabase origin; anything else is
 *     refused rather than fetched.
 *   - The original image is never modified, moved or deleted.
 *   - A failing ticket is recorded and the run continues; the ids are printed
 *     at the end so a follow-up run can be scoped or investigated.
 *   - The database is updated only after the thumbnail upload has succeeded.
 */
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { uploadTicketThumbnail } from '../services/supabaseStorage.js';
import {
  generateThumbnail,
  deriveThumbnailPath,
  storagePathFromPublicUrl,
  THUMBNAIL_CONTENT_TYPE,
} from '../services/thumbnail.service.js';

const prisma = new PrismaClient();

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;
const DEFAULT_LIMIT = 500;

interface Options {
  apply: boolean;
  limit: number;
  concurrency: number;
}

function parseOptions(argv: string[]): Options {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const limit = Number(get('limit') ?? DEFAULT_LIMIT);
  const concurrency = Number(get('concurrency') ?? DEFAULT_CONCURRENCY);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be between 1 and ${MAX_CONCURRENCY}`);
  }

  return { apply: argv.includes('--apply'), limit, concurrency };
}

/** Only the configured Supabase storage origin is fetchable. */
function assertAllowedSource(url: string): void {
  let parsed: URL;
  let configured: URL;
  try {
    parsed = new URL(url);
    configured = new URL(env.supabaseUrl);
  } catch {
    throw new Error('Malformed source or configured Supabase URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== configured.hostname) {
    throw new Error(`Refusing to download from untrusted origin "${parsed.hostname}"`);
  }
}

async function download(url: string): Promise<Buffer> {
  assertAllowedSource(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`Source responded ${response.status}`);
    }

    const declared = Number(response.headers.get('content-length') || '0');
    if (declared > MAX_SOURCE_BYTES) {
      throw new Error(`Source is ${declared} bytes, over the ${MAX_SOURCE_BYTES} limit`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // Re-check: content-length may be absent or wrong.
    if (buffer.length > MAX_SOURCE_BYTES) {
      throw new Error(`Source is ${buffer.length} bytes, over the ${MAX_SOURCE_BYTES} limit`);
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

interface Outcome {
  ticketId: string;
  status: 'generated' | 'skipped' | 'failed';
  detail?: string;
  sourceBytes?: number;
  thumbBytes?: number;
}

async function processTicket(
  ticket: { id: string; imageUrl: string },
  options: Options
): Promise<Outcome> {
  const objectPath = storagePathFromPublicUrl(ticket.imageUrl, env.supabaseStorageBucket);
  if (!objectPath) {
    return { ticketId: ticket.id, status: 'skipped', detail: 'imageUrl is not a public storage object URL' };
  }

  const thumbnailPath = deriveThumbnailPath(objectPath);

  if (!options.apply) {
    return { ticketId: ticket.id, status: 'skipped', detail: `dry run -> would write ${thumbnailPath}` };
  }

  try {
    const source = await download(ticket.imageUrl);
    const thumbnail = await generateThumbnail(source);
    const uploaded = await uploadTicketThumbnail(
      thumbnail.buffer,
      thumbnailPath,
      THUMBNAIL_CONTENT_TYPE
    );

    // Only now is the row updated: a thumbnailUrl always points at bytes that
    // exist. Scoped to rows still NULL so a concurrent run cannot double-write.
    const updated = await prisma.ticket.updateMany({
      where: { id: ticket.id, thumbnailUrl: null },
      data: { thumbnailUrl: uploaded.publicUrl },
    });

    if (updated.count === 0) {
      return { ticketId: ticket.id, status: 'skipped', detail: 'already backfilled by another run' };
    }

    return {
      ticketId: ticket.id,
      status: 'generated',
      sourceBytes: thumbnail.sourceBytes,
      thumbBytes: thumbnail.bytes,
    };
  } catch (error) {
    return {
      ticketId: ticket.id,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  const tickets = await prisma.ticket.findMany({
    where: { thumbnailUrl: null },
    select: { id: true, imageUrl: true },
    orderBy: { receivedAt: 'asc' },
    take: options.limit,
  });

  console.log(
    `${options.apply ? 'APPLY' : 'DRY RUN'} — ${tickets.length} ticket(s) without a thumbnail ` +
    `(limit ${options.limit}, concurrency ${options.concurrency})`
  );
  if (!options.apply) {
    console.log('No writes will be made. Re-run with --apply to generate.');
  }

  const outcomes: Outcome[] = [];
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, tickets.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= tickets.length) return;
        const ticket = tickets[index]!;
        const outcome = await processTicket(ticket, options);
        outcomes.push(outcome);
        const suffix =
          outcome.status === 'generated'
            ? `${outcome.sourceBytes} -> ${outcome.thumbBytes} bytes`
            : outcome.detail ?? '';
        console.log(`  [${outcome.status}] ${outcome.ticketId} ${suffix}`);
      }
    })
  );

  const generated = outcomes.filter((o) => o.status === 'generated');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');

  console.log('\nSummary');
  console.log(`  generated: ${generated.length}`);
  console.log(`  skipped:   ${skipped.length}`);
  console.log(`  failed:    ${failed.length}`);

  if (generated.length > 0) {
    const before = generated.reduce((a, o) => a + (o.sourceBytes ?? 0), 0);
    const after = generated.reduce((a, o) => a + (o.thumbBytes ?? 0), 0);
    console.log(`  bytes:     ${before} -> ${after}`);
  }

  if (failed.length > 0) {
    console.log('\nFailed ticket ids (safe to re-run; they remain NULL):');
    for (const failure of failed) {
      console.log(`  ${failure.ticketId}  ${failure.detail ?? ''}`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
