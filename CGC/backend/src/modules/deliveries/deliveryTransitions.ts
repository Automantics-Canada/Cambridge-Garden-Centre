/**
 * Server-side delivery state machine.
 *
 * `updateStatus` previously wrote whatever `req.body.status` contained. Any
 * caller who could reach a delivery could move it to any state: re-open a
 * DELIVERED stop, resurrect a CANCELLED one, or jump an UNASSIGNED delivery
 * straight to DELIVERED without ever having been assigned or leaving the yard.
 * A DRIVER could also cancel work, which is an operations decision.
 *
 * This module is pure and takes the delivery record as a parameter, matching
 * `services/authorization.ts`, so every allow/deny branch is testable without a
 * database.
 */
import type { DeliveryStatus, UserRole } from '@prisma/client';

/**
 * Legal successors for each state.
 *
 * Derived from the flow the app actually drives, not invented:
 * DispatchBoard.jsx assigns at `PLACED`; DriverMobileView.jsx moves
 * `PLACED -> IN_TRANSIT` ("Driver confirmed and started delivery") and then
 * `IN_TRANSIT -> DELIVERED` ("Complete delivery"). `OUT_FOR_DELIVERY` is in the
 * enum and reachable from dispatch, so it is kept as a legal staging state.
 */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  UNASSIGNED: ['PLACED', 'CANCELLED'],
  PLACED: ['UNASSIGNED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['IN_TRANSIT', 'ON_HOLD', 'DELAYED', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'ON_HOLD', 'DELAYED', 'CANCELLED'],
  ON_HOLD: ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'DELAYED', 'CANCELLED'],
  DELAYED: ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'CANCELLED'],
  // Terminal. Reversing a completed or cancelled delivery is an operations
  // correction with financial consequences downstream (tickets, invoice
  // matching), so it does not happen through this endpoint.
  DELIVERED: [],
  CANCELLED: [],
} as const;

/** States from which nothing may move. */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = ['DELIVERED', 'CANCELLED'];

/**
 * The subset a DRIVER may perform on its own delivery.
 *
 * Drivers advance their own stop and may flag a problem. They may not cancel,
 * un-assign, or otherwise make dispatch decisions.
 */
export const DRIVER_ALLOWED_TARGETS: readonly DeliveryStatus[] = [
  'OUT_FOR_DELIVERY',
  'IN_TRANSIT',
  'DELIVERED',
  'ON_HOLD',
  'DELAYED',
];

/**
 * The roles that may correct a finished stop (spec §8: past days are
 * "read-only except status corrections by an admin").
 *
 * A stop is finished when DELIVERED or CANCELLED, whatever day it was due. An
 * unfinished stop from an earlier day is not history: it is Carried over work,
 * still live, and a driver may be on it now, so it is never locked here.
 */
export const HISTORY_CORRECTION_ROLES: readonly UserRole[] = ['ADMIN', 'OWNER'];

/**
 * Whether `role` is an office user kept off a finished stop.
 *
 * Drivers are left to the current-stop rule, which already refuses them any
 * stop but the one on their screen, and a finished stop never is.
 */
export function isLockedFinishedStop(status: DeliveryStatus, role: UserRole): boolean {
  return (
    TERMINAL_STATUSES.includes(status) &&
    role !== 'DRIVER' &&
    !HISTORY_CORRECTION_ROLES.includes(role)
  );
}

export const FINISHED_STOP_REFUSAL = 'Only an admin or owner may correct a finished stop';

/**
 * Evidence a state requires before it can be entered.
 *
 * `DELIVERED` is the proof-of-delivery gate: the whole AP chain downstream
 * (ticket linking, invoice verification) treats a delivered stop as evidence
 * that goods arrived, so completing without a delivery photo puts an unbacked
 * record into that chain.
 *
 * Pickup photos are deliberately NOT required for `IN_TRANSIT`: the driver app
 * enters IN_TRANSIT first and uploads the pickup photo afterwards, so requiring
 * it would break the real sequence.
 */
export const REQUIRED_EVIDENCE: Partial<Record<DeliveryStatus, keyof DeliveryEvidence>> = {
  DELIVERED: 'deliveryPhotoUrl',
};

export interface DeliveryEvidence {
  pickupPhotoUrl: string | null;
  deliveryPhotoUrl: string | null;
}

export interface TransitionRequest {
  from: DeliveryStatus;
  to: unknown;
  role: UserRole;
  evidence: DeliveryEvidence;
}

export type TransitionDenialCode =
  | 'INVALID_STATUS'
  | 'TERMINAL_STATE'
  | 'ILLEGAL_TRANSITION'
  | 'ROLE_NOT_PERMITTED'
  | 'FINISHED_STOP_ADMIN_ONLY'
  | 'MISSING_EVIDENCE';

export type TransitionResult =
  | { allowed: true; to: DeliveryStatus }
  | { allowed: false; code: TransitionDenialCode; reason: string };

const ALL_STATUSES = Object.keys(DELIVERY_TRANSITIONS) as DeliveryStatus[];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (ALL_STATUSES as string[]).includes(value);
}

/**
 * Decides whether a status change may proceed.
 *
 * Order matters: an unknown value is rejected before anything else, and the
 * role check runs before the evidence check so a driver attempting a forbidden
 * cancel is told it is forbidden rather than being asked for a photo.
 *
 * An office user who may not correct history is refused a finished stop (403)
 * before the state machine is consulted, so they are told who may change it
 * rather than that nobody can. Admins and owners go on to the state machine,
 * which today allows no move out of DELIVERED or CANCELLED at all (409).
 */
export function evaluateTransition(request: TransitionRequest): TransitionResult {
  const { from, to, role, evidence } = request;

  if (!isDeliveryStatus(to)) {
    return {
      allowed: false,
      code: 'INVALID_STATUS',
      reason: `Unknown delivery status: ${String(to)}`,
    };
  }

  if (isLockedFinishedStop(from, role)) {
    return { allowed: false, code: 'FINISHED_STOP_ADMIN_ONLY', reason: FINISHED_STOP_REFUSAL };
  }

  // A no-op repeat is not an error, but it must not re-stamp timestamps or
  // append history, so it is still refused as an illegal transition.
  if (to === from) {
    return {
      allowed: false,
      code: 'ILLEGAL_TRANSITION',
      reason: `Delivery is already ${from}`,
    };
  }

  if (TERMINAL_STATUSES.includes(from)) {
    return {
      allowed: false,
      code: 'TERMINAL_STATE',
      reason: `${from} is final and cannot be changed`,
    };
  }

  if (!DELIVERY_TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      code: 'ILLEGAL_TRANSITION',
      reason: `Cannot move a delivery from ${from} to ${to}`,
    };
  }

  if (role === 'DRIVER' && !DRIVER_ALLOWED_TARGETS.includes(to)) {
    return {
      allowed: false,
      code: 'ROLE_NOT_PERMITTED',
      reason: `A driver may not set a delivery to ${to}`,
    };
  }

  const requiredField = REQUIRED_EVIDENCE[to];
  if (requiredField && !evidence[requiredField]) {
    return {
      allowed: false,
      code: 'MISSING_EVIDENCE',
      reason: `${to} requires ${requiredField} to be present`,
    };
  }

  return { allowed: true, to };
}

/** HTTP status for each denial, so the controller does not re-derive it. */
export const DENIAL_HTTP_STATUS: Record<TransitionDenialCode, number> = {
  INVALID_STATUS: 400,
  ILLEGAL_TRANSITION: 409,
  TERMINAL_STATE: 409,
  ROLE_NOT_PERMITTED: 403,
  FINISHED_STOP_ADMIN_ONLY: 403,
  MISSING_EVIDENCE: 422,
};
