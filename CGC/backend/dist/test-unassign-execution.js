import { DispatchService } from './modules/dispatch/dispatch.service.js';
import { prisma } from './db/prisma.js';
async function testExecution() {
    // Let's find an assigned order
    const assignedDelivery = await prisma.delivery.findFirst({
        where: {
            driverId: { not: null },
            status: 'PLACED'
        },
        select: {
            orderId: true,
            id: true,
            driverId: true
        }
    });
    if (!assignedDelivery) {
        console.log("No assigned delivery found to test with.");
        return;
    }
    console.log(`Found assigned delivery to test with: Order ID = ${assignedDelivery.orderId}, Delivery ID = ${assignedDelivery.id}, Driver ID = ${assignedDelivery.driverId}`);
    try {
        const result = await DispatchService.unassignDriver(assignedDelivery.orderId);
        console.log("Unassignment SUCCESS:", result);
    }
    catch (error) {
        console.error("Unassignment FAILED with error:", error);
    }
}
testExecution().catch(console.error).finally(() => prisma.$disconnect());
//# sourceMappingURL=test-unassign-execution.js.map