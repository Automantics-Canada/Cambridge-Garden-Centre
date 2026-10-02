import process from 'node:process';

/**
 * Empties the order data while keeping the schema, the people and the setup.
 *
 * Usage (from CGC/backend, run by a person, never by CI or an agent):
 *
 *   DATABASE_URL=... node scripts/wipe-order-data.mjs
 *       Dry run. Prints the database host and name, the rows each table would
 *       lose, and the links that would be cleared. Changes nothing.
 *
 *   DATABASE_URL=... WIPE_CONFIRM_HOST=<host of DATABASE_URL> \
 *     node scripts/wipe-order-data.mjs --apply
 *       Empties the tables in one transaction and prints the counts after.
 *       WIPE_CONFIRM_HOST must equal the host in DATABASE_URL exactly, so a
 *       command copied from one environment cannot run against another.
 *
 *   --include-tickets-invoices
 *       Also empties tickets, invoices, their lines and their OCR jobs.
 *
 * DATABASE_URL must be set in the environment: this script does not read
 * .env, so it cannot pick up a database nobody named. Behind a transaction
 * pooler, point DATABASE_URL at the direct connection for the run.
 *
 * What it empties (order side, always):
 *   OrderDocument, Order, OrderChange, OrderOverride, Delivery,
 *   DeliveryHistory, ImportBatch, ImportBatchFile, SpruceImportJob,
 *   SpruceImportRowError, TicketOrderMatch, MatchResult, TicketClaim.
 *   A table that does not exist yet is skipped and reported.
 *
 *   MatchResult holds verdicts reached against orders, and every TicketClaim is
 *   made by resolving one of those verdicts. With the orders gone the verdicts
 *   are wrong, and a claim left without its verdict blocks the invoice from
 *   being re-read ("not attached to a verdict that could be reopened"), so the
 *   two go together. Matching recomputes verdicts on its next run.
 *
 * What it keeps but unlinks:
 *   Ticket.linkedOrderId and InvoiceLineItem.matchedOrderId point at orders.
 *   They are cleared (a linked ticket goes back to UNLINKED, as matching does
 *   when it removes a link) so the orders can be deleted without touching the
 *   tickets and invoices themselves. With --include-tickets-invoices,
 *   EmailIngestionEvent.createdInvoiceId is cleared the same way; the event
 *   log stays, so the mailbox poller does not ingest the same emails again.
 *
 * What it never touches: every other table, including User, Driver,
 * Supplier*, NegotiatedRate, SystemSetting, Product, Unit, AuditLog,
 * WhatsAppMessage, _prisma_migrations, and any schema other than the one
 * named by DATABASE_URL (public by default), so Supabase auth and storage are
 * out of reach. Files in Supabase Storage are not deleted.
 *
 * Why DELETE and not TRUNCATE: TRUNCATE refuses any table another table holds
 * a foreign key to, whatever the rows say, and TRUNCATE ... CASCADE would
 * follow Ticket.linkedOrderId and empty the tickets. DELETE checks each row,
 * so the run can never reach further than the list above. Before anything is
 * deleted, every foreign key in the database pointing into the listed tables
 * is read from the catalogue; one the script does not know how to clear stops
 * the run, dry or not. After deleting, every table is counted again, and the
 * transaction rolls back unless the listed tables are empty and every other
 * table holds exactly the rows it held before.
 */

const ORDER_TABLES = [
  'OrderDocument',
  'Order',
  'OrderChange',
  'OrderOverride',
  'Delivery',
  'DeliveryHistory',
  'ImportBatch',
  'ImportBatchFile',
  'SpruceImportJob',
  'SpruceImportRowError',
  'TicketOrderMatch',
  'MatchResult',
  'TicketClaim',
];

const TICKET_INVOICE_TABLES = ['Ticket', 'Invoice', 'InvoiceLineItem', '_InvoiceLineItemToTicket', 'OcrJob'];

/**
 * Foreign keys from a kept table into an emptied one, and how each is cleared.
 * Only applied when `table` is kept; a key not listed here stops the run.
 */
const DETACH_RULES = [
  {
    table: 'Ticket',
    column: 'linkedOrderId',
    references: 'Order',
    sql: (t) =>
      `UPDATE ${t} SET "linkedOrderId" = NULL, "linkMethod" = NULL, ` +
      `"status" = CASE WHEN "status"::text = 'LINKED' THEN 'UNLINKED'::"TicketStatus" ELSE "status" END ` +
      `WHERE "linkedOrderId" IS NOT NULL`,
  },
  {
    table: 'InvoiceLineItem',
    column: 'matchedOrderId',
    references: 'Order',
    sql: (t) => `UPDATE ${t} SET "matchedOrderId" = NULL WHERE "matchedOrderId" IS NOT NULL`,
  },
  {
    table: 'EmailIngestionEvent',
    column: 'createdInvoiceId',
    references: 'Invoice',
    sql: (t) => `UPDATE ${t} SET "createdInvoiceId" = NULL WHERE "createdInvoiceId" IS NOT NULL`,
  },
];

const USAGE =
  'Usage: DATABASE_URL=... node scripts/wipe-order-data.mjs [--apply] [--include-tickets-invoices]\n' +
  '       --apply also needs WIPE_CONFIRM_HOST=<exact host of DATABASE_URL>';

class Refusal extends Error {}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const pad = (text, width) => String(text).padEnd(width);

function parseArgs(argv) {
  const known = new Set(['--apply', '--include-tickets-invoices', '--help', '-h']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Refusal(`Unknown argument: ${unknown.join(' ')}\n${USAGE}`);
  return {
    apply: argv.includes('--apply'),
    includeTicketsInvoices: argv.includes('--include-tickets-invoices'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

/** Host, port, database and schema — never the user, password or full URL. */
function describeTarget(rawUrl) {
  if (!rawUrl) throw new Refusal(`DATABASE_URL is not set.\n${USAGE}`);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Refusal('DATABASE_URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Refusal('DATABASE_URL is not a PostgreSQL URL.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Refusal('DATABASE_URL must name a host and a database.');
  return {
    host: url.hostname,
    port: url.port || '5432',
    database,
    schema: url.searchParams.get('schema') || 'public',
  };
}

async function existingTables(tx, schema) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT c.relname::text AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY 1`,
    schema
  );
  return rows.map((row) => row.name);
}

async function foreignKeys(tx) {
  return tx.$queryRawUnsafe(
    `SELECT cn.nspname::text AS "childSchema", c.relname::text AS child,
            pn.nspname::text AS "parentSchema", p.relname::text AS parent,
            con.conname::text AS name,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) AS k(attnum)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
            EXISTS(SELECT 1 FROM unnest(con.conkey) AS k(attnum)
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                    WHERE a.attnotnull) AS "notNull"
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE con.contype = 'f'`
  );
}

async function countRows(tx, schema, tables) {
  const counts = {};
  for (const table of tables) {
    const [row] = await tx.$queryRawUnsafe(
      `SELECT count(*)::bigint AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)}`
    );
    counts[table] = Number(row.n);
  }
  return counts;
}

/**
 * Works out what to empty, what to unlink, and in which order to delete.
 * Throws a Refusal for any foreign key into the emptied set it cannot clear.
 */
function buildPlan({ schema, present, fks, includeTicketsInvoices }) {
  const wanted = [...ORDER_TABLES, ...(includeTicketsInvoices ? TICKET_INVOICE_TABLES : [])];
  const presentSet = new Set(present);
  const wipe = wanted.filter((table) => presentSet.has(table));
  const missing = wanted.filter((table) => !presentSet.has(table));
  const wipeSet = new Set(wipe);
  const inWipe = (fk) => fk.parentSchema === schema && wipeSet.has(fk.parent);
  const childInWipe = (fk) => fk.childSchema === schema && wipeSet.has(fk.child);

  const detach = [];
  const blockers = [];
  for (const fk of fks) {
    if (!inWipe(fk) || childInWipe(fk)) continue;
    const rule = DETACH_RULES.find(
      (r) =>
        fk.childSchema === schema &&
        r.table === fk.child &&
        r.references === fk.parent &&
        fk.columns.length === 1 &&
        fk.columns[0] === r.column
    );
    if (!rule || fk.notNull) {
      blockers.push(`${fk.childSchema}.${fk.child}(${fk.columns.join(', ')}) -> ${fk.parent} [${fk.name}]`);
    } else {
      detach.push(rule);
    }
  }
  if (blockers.length > 0) {
    throw new Refusal(
      'Refusing to run: these foreign keys point into tables this script empties, and it does not know ' +
        'how to clear them without deleting rows from a table it must keep:\n  ' +
        blockers.join('\n  ') +
        '\nAdd the table to the emptied list or a rule to DETACH_RULES after deciding what it should do.'
    );
  }

  // Children before parents, so each DELETE finds nothing still pointing at it.
  const edges = fks.filter((fk) => inWipe(fk) && childInWipe(fk) && fk.child !== fk.parent);
  const order = [];
  const remaining = new Set(wipe);
  while (remaining.size > 0) {
    const next = [...remaining].filter(
      (table) => !edges.some((fk) => fk.parent === table && remaining.has(fk.child))
    );
    if (next.length === 0) {
      throw new Refusal(`Refusing to run: circular foreign keys among ${[...remaining].join(', ')}.`);
    }
    for (const table of next.sort()) {
      order.push(table);
      remaining.delete(table);
    }
  }

  return { wipe, missing, detach, deleteOrder: order };
}

function printTable(title, counts, tables) {
  console.log(title);
  const width = Math.max(...tables.map((t) => t.length), 10) + 2;
  for (const table of tables) console.log(`  ${pad(table, width)}${counts[table]}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // Read before importing Prisma, which may load a .env file into process.env.
  const rawUrl = process.env.DATABASE_URL;
  const confirmHost = process.env.WIPE_CONFIRM_HOST;
  const target = describeTarget(rawUrl);

  console.log(
    `Database: host=${target.host} port=${target.port} database=${target.database} schema=${target.schema}`
  );
  console.log(
    `Mode: ${args.apply ? 'APPLY' : 'DRY RUN (nothing is changed; pass --apply to empty the tables)'}` +
      (args.includeTicketsInvoices ? ', including tickets and invoices' : '')
  );

  if (args.apply && confirmHost !== target.host) {
    throw new Refusal(
      `Refusing --apply: WIPE_CONFIRM_HOST must equal the database host exactly (${target.host}). ` +
        (confirmHost ? 'It does not.' : 'It is not set.')
    );
  }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: rawUrl, log: [] });
  const schema = target.schema;

  try {
    await prisma.$transaction(
      async (tx) => {
        if (!args.apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);

        const present = await existingTables(tx, schema);
        const plan = buildPlan({
          schema,
          present,
          fks: await foreignKeys(tx),
          includeTicketsInvoices: args.includeTicketsInvoices,
        });
        const kept = present.filter((table) => !plan.wipe.includes(table));

        if (args.apply && plan.wipe.length > 0) {
          // Nothing may write to these tables, or link to them, mid-run.
          await tx.$executeRawUnsafe(
            `LOCK TABLE ${plan.wipe.map((t) => `${quoteIdent(schema)}.${quoteIdent(t)}`).join(', ')} ` +
              'IN ACCESS EXCLUSIVE MODE'
          );
        }

        const before = await countRows(tx, schema, present);
        const linked = {};
        for (const rule of plan.detach) {
          const [row] = await tx.$queryRawUnsafe(
            `SELECT count(*)::bigint AS n FROM ${quoteIdent(schema)}.${quoteIdent(rule.table)} ` +
              `WHERE ${quoteIdent(rule.column)} IS NOT NULL`
          );
          linked[`${rule.table}.${rule.column}`] = Number(row.n);
        }

        printTable(`Tables to empty (rows ${args.apply ? 'before' : 'now'}):`, before, plan.wipe);
        for (const table of plan.missing) console.log(`  ${table}: skipped, table does not exist`);
        console.log('Links to clear in kept tables (rows):');
        if (plan.detach.length === 0) console.log('  none');
        for (const rule of plan.detach) {
          console.log(`  ${rule.table}.${rule.column} -> ${rule.references}: ${linked[`${rule.table}.${rule.column}`]}`);
        }
        printTable('Kept tables (rows, never emptied):', before, kept);

        if (!args.apply) return;

        for (const rule of plan.detach) {
          await tx.$executeRawUnsafe(rule.sql(`${quoteIdent(schema)}.${quoteIdent(rule.table)}`));
        }
        for (const table of plan.deleteOrder) {
          await tx.$executeRawUnsafe(`DELETE FROM ${quoteIdent(schema)}.${quoteIdent(table)}`);
        }

        const after = await countRows(tx, schema, present);
        const notEmpty = plan.wipe.filter((table) => after[table] !== 0);
        const changed = kept.filter((table) => after[table] !== before[table]);
        if (notEmpty.length > 0 || changed.length > 0) {
          throw new Error(
            'Rolled back: the result was not what was planned. ' +
              (notEmpty.length ? `Still holding rows: ${notEmpty.join(', ')}. ` : '') +
              (changed.length ? `Kept tables whose row count changed: ${changed.join(', ')}.` : '')
          );
        }

        printTable('After (committed):', after, plan.wipe);
        console.log(`Kept tables unchanged: ${kept.length}`);
      },
      { maxWait: 15_000, timeout: 300_000 }
    );
  } finally {
    await prisma.$disconnect();
  }

  if (!args.apply) console.log('Dry run complete. Nothing was changed.');
  else console.log('Done.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof Refusal) {
      console.error(error.message);
      process.exit(2);
    }
    // Prisma's messages name the host and user at most, never the password.
    console.error(`Failed: ${error?.message ?? error}`);
    process.exit(1);
  }
);
