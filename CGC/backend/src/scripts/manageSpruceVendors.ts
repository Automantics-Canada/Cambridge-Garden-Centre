/**
 * Manages the Spruce vendor-code → supplier mapping.
 *
 * The Item Tracking report names vendors as codes (`BESTWAYS01`,
 * `UNILOCKL01`) that match no supplier's stored name, so the importer resolves
 * them only through this table — recorded once by a person, exact thereafter.
 *
 *   List:     npm run vendors:list
 *   Add:      npm run vendors:add -- BESTWAYS01 "<supplier name>"
 *   Retire:   npm run vendors:deactivate -- BESTWAYS01
 *
 * A retired code is kept but no longer resolves, so an old report re-imported
 * after a supplier change cannot silently re-point at it.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function usage(): never {
  console.log(
    'Usage:\n' +
    '  npm run vendors:list\n' +
    '  npm run vendors:add -- CODE "Supplier Name"\n' +
    '  npm run vendors:deactivate -- CODE'
  );
  process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'list' || command === undefined) {
    const mappings = await prisma.supplierSpruceVendor.findMany({
      include: { supplier: { select: { name: true, active: true } } },
      orderBy: { code: 'asc' },
    });
    if (mappings.length === 0) {
      console.log('No vendor codes recorded yet.');
      return;
    }
    for (const m of mappings) {
      console.log(
        `${m.code.padEnd(14)} -> ${m.supplier.name}` +
        `${m.active ? '' : ' (retired)'}` +
        `${m.supplier.active ? '' : ' (supplier inactive)'}`
      );
    }
    return;
  }

  if (command === 'add') {
    const [code, supplierName] = args;
    if (!code || !supplierName) usage();

    const supplier = await prisma.supplier.findFirst({
      where: { name: { equals: supplierName, mode: 'insensitive' } },
      select: { id: true, name: true, active: true },
    });
    if (!supplier) {
      console.error(`No supplier named "${supplierName}". Use the name exactly as stored.`);
      process.exit(1);
    }
    if (!supplier.active) {
      console.error(`Supplier "${supplier.name}" is inactive; activate it first.`);
      process.exit(1);
    }

    const saved = await prisma.supplierSpruceVendor.upsert({
      where: { code: code.toUpperCase() },
      update: { supplierId: supplier.id, active: true },
      create: { code: code.toUpperCase(), supplierId: supplier.id },
    });
    console.log(`${saved.code} -> ${supplier.name}`);
    return;
  }

  if (command === 'deactivate') {
    const [code] = args;
    if (!code) usage();

    try {
      await prisma.supplierSpruceVendor.update({
        where: { code: code.toUpperCase() },
        data: { active: false },
      });
      console.log(`${code.toUpperCase()} retired; it no longer resolves.`);
    } catch {
      console.error(`No mapping for "${code.toUpperCase()}".`);
      process.exit(1);
    }
    return;
  }

  usage();
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
