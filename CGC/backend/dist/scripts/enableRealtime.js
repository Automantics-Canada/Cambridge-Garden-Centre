import { prisma } from '../db/prisma.js';
async function main() {
    console.log('🚀 Running database migration to enable Supabase Realtime replication...');
    const query = `
    DO $$
    BEGIN
      -- Ensure publication exists
      IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
      END IF;

      -- Add Ticket table
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Ticket') THEN
        BEGIN
          ALTER PUBLICATION supabase_realtime ADD TABLE "Ticket";
        EXCEPTION WHEN duplicate_object THEN
          RAISE NOTICE 'Table Ticket is already in publication supabase_realtime';
        END;
      END IF;

      -- Add Invoice table
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Invoice') THEN
        BEGIN
          ALTER PUBLICATION supabase_realtime ADD TABLE "Invoice";
        EXCEPTION WHEN duplicate_object THEN
          RAISE NOTICE 'Table Invoice is already in publication supabase_realtime';
        END;
      END IF;

      -- Add Order table
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Order') THEN
        BEGIN
          ALTER PUBLICATION supabase_realtime ADD TABLE "Order";
        EXCEPTION WHEN duplicate_object THEN
          RAISE NOTICE 'Table Order is already in publication supabase_realtime';
        END;
      END IF;

      -- Add Delivery table
      IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'Delivery') THEN
        BEGIN
          ALTER PUBLICATION supabase_realtime ADD TABLE "Delivery";
        EXCEPTION WHEN duplicate_object THEN
          RAISE NOTICE 'Table Delivery is already in publication supabase_realtime';
        END;
      END IF;
    END $$;
  `;
    try {
        await prisma.$executeRawUnsafe(query);
        console.log('✅ Supabase Realtime replication enabled successfully for Ticket, Invoice, Order, and Delivery tables!');
    }
    catch (error) {
        console.error('❌ Failed to enable Supabase Realtime replication:', error);
    }
    finally {
        await prisma.$disconnect();
    }
}
main();
//# sourceMappingURL=enableRealtime.js.map