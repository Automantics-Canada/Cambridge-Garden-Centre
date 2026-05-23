import { prisma } from './db/prisma.js';
async function main() {
    console.log("--- Listing all users ---");
    const users = await prisma.user.findMany({ select: { id: true, email: true, name: true, role: true } });
    console.log(users);
    console.log("\n--- Listing orders with drivers and deliveryStatus ---");
    const orders = await prisma.order.findMany({
        select: {
            id: true,
            spruceOrderId: true,
            driverId: true,
            deliveryStatus: true,
            deliveries: {
                select: {
                    id: true,
                    status: true,
                    driverId: true
                }
            }
        }
    });
    console.log(orders);
    console.log("\n--- Listing all deliveries ---");
    const deliveries = await prisma.delivery.findMany({
        select: {
            id: true,
            orderId: true,
            driverId: true,
            status: true
        }
    });
    console.log(deliveries);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
}).finally(() => {
    prisma.$disconnect();
});
//# sourceMappingURL=test-unassign.js.map