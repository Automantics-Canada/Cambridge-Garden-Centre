import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PRODUCTS = [
  'Type A Gravel',
  '3/4" Crushed Stone',
  'Screened Topsoil',
  'Triple Mix Soil',
  'River Rock (Small)',
  'River Rock (Medium)',
  'Premium Mulch (Black)',
  'Sand (Concrete)',
  'Blinker Sand',
  'Natural Cedar Mulch',
  'Pea Gravel',
  'Recycled Grass'
];

async function seed() {
  console.log('🌱 Seeding products...');
  for (const name of PRODUCTS) {
    try {
      await prisma.product.upsert({
        where: { name },
        update: {},
        create: { name }
      });
      console.log(`✅ Product: ${name}`);
    } catch (e) {
      console.error(`❌ Error seeding ${name}`, e);
    }
  }
  console.log('✨ Seeding complete.');
  await prisma.$disconnect();
}

seed();
