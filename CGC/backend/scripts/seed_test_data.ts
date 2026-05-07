import { prisma } from '../src/db/prisma.js';

async function seed() {
  const admin = await prisma.user.findFirst();
  if (!admin) {
    console.error('No user found to assign as creator. Please create a user first.');
    return;
  }

  const suppliersData = [
    { name: 'Stone Creek Aggregates', type: 'SUPPLIER' as any },
    { name: 'Valley Topsoil & Fill', type: 'SUPPLIER' as any },
    { name: 'North River Landscaping Supplies', type: 'SUPPLIER' as any },
    { name: 'Urban Mulch & Bark', type: 'SUPPLIER' as any },
  ];

  for (const sData of suppliersData) {
    let s = await prisma.supplier.findFirst({
      where: { name: sData.name }
    });
    
    if (!s) {
      s = await prisma.supplier.create({
        data: sData
      });
    }
    
    // Add negotiated rates
    const rates = [];
    if (s.name === 'Stone Creek Aggregates') {
      rates.push({ productName: '3/4 Clear Gravel', rate: 25.00, unit: 'MT' });
    } else if (s.name === 'Valley Topsoil & Fill') {
      rates.push({ productName: 'Screened Topsoil', rate: 18.00, unit: 'CY' });
    } else if (s.name === 'North River Landscaping Supplies') {
      rates.push({ productName: 'River Stone 2-5 inch', rate: 45.00, unit: 'MT' });
    } else if (s.name === 'Urban Mulch & Bark') {
      rates.push({ productName: 'Mulch Black', rate: 30.00, unit: 'CY' });
    }

    for (const r of rates) {
      await prisma.negotiatedRate.create({
        data: {
          supplierId: s.id,
          productName: r.productName,
          rate: r.rate,
          unit: r.unit,
          effectiveFrom: new Date('2024-01-01'),
          createdById: admin.id,
        },
      });
    }
  }

  console.log('Seed completed.');
}

seed().catch(console.error);
