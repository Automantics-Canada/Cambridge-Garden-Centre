import { DeliveryStatus, Prisma } from '@prisma/client';
import { businessDayRange } from '../../lib/businessDay.js';

export class DeliveryQueryError extends Error {
  readonly status = 400;
}

function queryString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new DeliveryQueryError(`${name} must be a single value`);
  return value;
}

function positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = queryString(value, 'pagination');
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DeliveryQueryError('page and limit must be positive integers');
  }
  return Math.min(parsed, max);
}

export function parseDeliveryQuery(query: Record<string, unknown>) {
  const filters: Prisma.DeliveryWhereInput = {};
  const driverId = queryString(query.driverId, 'driverId');
  const status = queryString(query.status, 'status');
  const priority = queryString(query.priority, 'priority');
  const date = queryString(query.date, 'date');
  const search = queryString(query.search, 'search')?.trim();

  if (driverId) filters.driverId = driverId;
  if (status) {
    if (!Object.values(DeliveryStatus).includes(status as DeliveryStatus)) {
      throw new DeliveryQueryError(`Invalid status: ${status}`);
    }
    filters.status = status as DeliveryStatus;
  }
  if (priority) {
    const parsedPriority = Number(priority);
    if (!Number.isInteger(parsedPriority) || parsedPriority < 1) {
      throw new DeliveryQueryError('priority must be a positive integer');
    }
    filters.priority = parsedPriority;
  }
  const conditions: Prisma.DeliveryWhereInput[] = [];
  if (date) {
    const range = businessDayRange(date);
    if (!range) throw new DeliveryQueryError(`Invalid date: ${date}`);
    // A stop belongs to the day its order goes out. Stops made before orders
    // were dispatched whole know no such day, only when they were created.
    conditions.push({
      OR: [
        { document: { is: { deliveryDate: new Date(`${date}T00:00:00.000Z`) } } },
        { documentId: null, createdAt: range },
      ],
    });
  }
  if (search) {
    conditions.push({
      OR: [
        { document: { is: { documentNumber: { contains: search, mode: 'insensitive' } } } },
        { document: { is: { customerName: { contains: search, mode: 'insensitive' } } } },
        { order: { is: { spruceOrderId: { contains: search, mode: 'insensitive' } } } },
        { order: { is: { customerName: { contains: search, mode: 'insensitive' } } } },
        { order: { is: { product: { contains: search, mode: 'insensitive' } } } },
        { driver: { is: { name: { contains: search, mode: 'insensitive' } } } },
      ],
    });
  }
  if (conditions.length > 0) filters.AND = conditions;

  return {
    filters,
    page: positiveInt(query.page, 1),
    limit: positiveInt(query.limit, 50, 100),
    wantsEnvelope: query.page !== undefined || query.limit !== undefined,
  };
}
