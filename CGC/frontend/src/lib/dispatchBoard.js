export function mergeUnassignedOrders(unassignedOrders = [], unassignedDeliveries = []) {
  const ordersById = new Map();

  for (const order of unassignedOrders) {
    if (order?.id) ordersById.set(order.id, order);
  }

  for (const delivery of unassignedDeliveries) {
    const order = delivery?.order;
    if (order?.id && !ordersById.has(order.id)) {
      ordersById.set(order.id, order);
    }
  }

  return [...ordersById.values()];
}
