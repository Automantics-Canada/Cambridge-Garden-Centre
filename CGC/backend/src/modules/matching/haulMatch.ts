import { compareUnits, normaliseUnit } from '../../lib/units.js';
import { numberSearchKey } from '../../lib/ticketNumber.js';
import {
  billableHauls,
  type BillableHaul,
  type HaulLoad,
} from '../dispatch/dispatchLoadRules.js';
import {
  percentDifference,
  withinTolerance,
  type LineTotals,
  type MatchCheck,
  type MatchDecision,
} from './matchEngine.js';
import { onSamePo } from './poKey.js';
import type { HaulTolerances } from './tolerances.js';

/**
 * Checking a trucking company's invoice line against the load dispatch sent.
 *
 * The client (Oct 2026, Q14): "trucking invoices vary — I want a spot for a
 * rate on every single dispatch load. The dispatcher sets the rate for each
 * load dispatched and it is matched up when the invoice comes in." So a haul
 * line is not checked against an order line and its scale tickets, as a
 * material line is. It is checked against the dispatcher's own record of the
 * load (DispatchLoad): who hauled it, at what rate, per what.
 *
 * Loads are read only through `billableHauls`: each load is one haul, except
 * the loads of one brokered trip (A4: one truck collects several POs), which
 * are one haul at the trip's rate, billed and paid once. CGC's own trucks bill
 * nobody and are never candidates.
 *
 * The evidence that identifies the load, strongest first: the ticket or load
 * number on the line, then its PO or order number, then the carrier and the
 * day (and the quantity, to tell two loads that day apart). A load found by
 * carrier and date alone is a guess, so it never passes without a person.
 *
 * Pure, like matchEngine.ts: rows in, a decision out, nothing read or written.
 */

/** Ticket numbers shorter than this are not trusted to identify a load (as ticketCopies.ts). */
const MIN_TICKET_KEY_LENGTH = 3;

/** One dispatch load, with what the matcher needs to recognise and describe it. */
export interface CandidateLoad extends HaulLoad {
  sequence: number;
  /** The Spruce order number the load is for. */
  documentNumber: string;
  /**
   * The day the load was hauled: the order's delivery date where Spruce gave
   * one, else the day its stop was completed, else the day the load was
   * recorded.
   */
  haulDate: Date;
  /** The ticket or load number dispatch recorded on the load, if any. */
  ticketNumber: string | null;
  /** Every PO the load's order carries: the order's own and its lines' supplier POs. */
  poNumbers: string[];
  /** Numbers of the tickets linked to the load's order (the drivers' photos). */
  orderTicketNumbers: string[];
  /** An order line that stands for the order on the desk (MatchResult.orderId). */
  orderLineId: string | null;
  /** The line that paid the load, for wording. Null when unpaid. */
  claim: { invoiceNumber: string; lineNumber: number } | null;
}

/** A haul that could be what the line bills: one load, or the loads of one trip on one day. */
export interface HaulCandidate {
  haul: BillableHaul;
  /** `YYYY-MM-DD` the haul ran. */
  day: string;
  loads: CandidateLoad[];
}

export interface HaulLineSubject {
  id: string;
  poNumber: string | null;
  ticketNumber: string | null;
  /** The day the line says the haul ran, where it prints one. */
  serviceDate: Date | null;
  quantity: number | null;
  unit: string | null;
  unitRate: number | null;
  /** The invoice's supplier: the trucking company. */
  supplierId: string | null;
  invoiceDate: Date | null;
}

export interface HaulDecision extends MatchDecision {
  loadIds: string[];
}

/** Another invoice line, not yet settled, whose verdict counts some of the same loads. */
export interface CompetingHaulLine {
  invoiceLineId: string;
  invoiceNumber: string;
  lineNumber: number;
  loadIds: string[];
}

export interface HaulMatchOptions {
  tolerances: HaulTolerances;
  /** Unsettled lines elsewhere that bill some of the candidate loads. */
  competingLines?: CompetingHaulLine[];
}

/** The units a haul is billed in. A line in any other unit is not a haul by itself. */
const HAUL_UNITS = new Set(['LOAD', 'HOUR', 'TONNE']);

const DAY_MS = 86_400_000;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const dayStart = (date: Date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

/** A ticket number's comparison key, or null when it is too short to identify a load. */
export function haulTicketKey(value: string | null | undefined): string | null {
  const key = numberSearchKey(value ?? '');
  return key.length >= MIN_TICKET_KEY_LENGTH ? key : null;
}

/**
 * A carrier's hauls in the window around `anchor`.
 *
 * Loads are taken a day at a time before they are grouped: a trip reference
 * is free text, and one reused on another day is another trip. Grouping by
 * the reference alone would merge them into one haul and pay one line for
 * both. The window is days either side of the anchor, counted in whole days.
 */
export function haulCandidates(
  loads: ReadonlyArray<CandidateLoad>,
  carrierSupplierId: string | null,
  anchor: Date | null,
  windowDays: number
): HaulCandidate[] {
  if (!carrierSupplierId) return [];
  const inWindow = loads.filter(
    (load) =>
      load.carrierSupplierId === carrierSupplierId &&
      (anchor === null || Math.abs(dayStart(load.haulDate) - dayStart(anchor)) <= windowDays * DAY_MS)
  );

  const byDay = new Map<string, CandidateLoad[]>();
  for (const load of inWindow) {
    const day = isoDay(load.haulDate);
    byDay.set(day, [...(byDay.get(day) ?? []), load]);
  }

  const candidates: HaulCandidate[] = [];
  for (const [day, dayLoads] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const byId = new Map(dayLoads.map((load) => [load.id, load]));
    for (const haul of billableHauls(dayLoads)) {
      candidates.push({ haul, day, loads: haul.loadIds.map((id) => byId.get(id)!) });
    }
  }
  return candidates;
}

/** "721001 load 2", or "trip T-12 (721001 load 1, 721002 load 1)". */
export function describeHaul(candidate: HaulCandidate): string {
  const each = candidate.loads.map((load) => `${load.documentNumber} load ${load.sequence}`);
  return candidate.haul.tripRef
    ? `trip ${candidate.haul.tripRef} on ${candidate.day} (${each.join(', ')})`
    : `${each[0]} on ${candidate.day}`;
}

const UNIT_WORDS: Record<string, string> = { LOAD: 'load', HOUR: 'hour', TONNE: 'tonne' };
const per = (unit: string | null) => (unit ? UNIT_WORDS[unit] ?? unit.toLowerCase() : 'unit');
const money = (value: number) => `$${value.toFixed(2)}`;

function ticketMatches(candidate: HaulCandidate, key: string): boolean {
  return candidate.loads.some(
    (load) =>
      haulTicketKey(load.ticketNumber) === key ||
      load.orderTicketNumbers.some((number) => haulTicketKey(number) === key)
  );
}

function poMatches(candidate: HaulCandidate, poNumber: string): boolean {
  const key = numberSearchKey(poNumber);
  return candidate.loads.some(
    (load) =>
      load.poNumbers.some((po) => onSamePo(po, poNumber)) ||
      // Truckers often write CGC's own order (job) number in the PO column.
      (key !== '' && numberSearchKey(load.documentNumber) === key)
  );
}

/** Paid, at least in part, by a line other than this one. */
function claimedElsewhere(candidate: HaulCandidate, lineId: string): CandidateLoad[] {
  return candidate.loads.filter(
    (load) => load.claimedByLineItemId !== null && load.claimedByLineItemId !== lineId
  );
}

type Method = 'ticket' | 'po' | 'date';

interface Identification {
  pool: HaulCandidate[];
  method: Method | null;
  /** Things the line said that the found load does not bear out. */
  notes: string[];
  /** The line's PO names a different order from the load its ticket found. */
  poDisagrees: boolean;
}

/**
 * Narrows the candidates on the line's evidence, strongest first. Each step
 * only narrows when it finds something; a ticket number nobody recorded on a
 * load is noted, not fatal, because dispatch may not have written it down.
 */
function identify(line: HaulLineSubject, candidates: HaulCandidate[]): Identification {
  let pool = candidates;
  let method: Method | null = null;
  const notes: string[] = [];
  let poDisagrees = false;

  const key = haulTicketKey(line.ticketNumber);
  if (key) {
    // The number dispatch wrote on the load itself names that load. A ticket
    // only linked to the load's order names the order, which may have had
    // several loads, so it counts only when no load carries the number.
    const onLoad = pool.filter((candidate) =>
      candidate.loads.some((load) => haulTicketKey(load.ticketNumber) === key)
    );
    const byTicket = onLoad.length > 0 ? onLoad : pool.filter((candidate) => ticketMatches(candidate, key));
    if (byTicket.length > 0) {
      pool = byTicket;
      method = 'ticket';
    } else {
      notes.push(`ticket ${line.ticketNumber} is not recorded on any of this carrier's loads`);
    }
  }

  if (line.poNumber) {
    const byPo = pool.filter((candidate) => poMatches(candidate, line.poNumber!));
    if (byPo.length > 0) {
      pool = byPo;
      method ??= 'po';
    } else if (method === 'ticket') {
      poDisagrees = true;
      notes.push(`the line's PO ${line.poNumber} is not on the order of the load its ticket names`);
    } else {
      notes.push(`no load of this carrier is for PO or order ${line.poNumber}`);
    }
  }

  if (method === null) {
    // Carrier and date alone, and only for a line billed per load, hour or
    // tonne: a fuel surcharge or a flat fee on the same invoice must not be
    // guessed onto a load, or confirming it would claim the load and block
    // the line that really bills it.
    const unit = normaliseUnit(line.unit);
    if (!unit || !HAUL_UNITS.has(unit)) pool = [];
    // With a haul date on the line only that day counts: a load from five
    // days earlier is not evidence of this one.
    if (line.serviceDate) {
      const day = isoDay(line.serviceDate);
      pool = pool.filter((candidate) => candidate.day === day);
    }
    // A haul another invoice already paid is not a fresh guess for this one.
    const unpaid = pool.filter((candidate) => claimedElsewhere(candidate, line.id).length === 0);
    if (unpaid.length > 0) pool = unpaid;
    if (pool.length > 0) method = 'date';
  } else if (pool.length > 1 && line.serviceDate) {
    const day = isoDay(line.serviceDate);
    const sameDay = pool.filter((candidate) => candidate.day === day);
    if (sameDay.length > 0) pool = sameDay;
  }

  // Two loads still fit: the billed quantity may tell them apart.
  if (pool.length > 1 && line.quantity !== null) {
    const byQuantity = pool.filter(
      (candidate) =>
        candidate.haul.quantity !== null &&
        compareUnits(line.unit, candidate.haul.rateUnit).comparable &&
        withinTolerance(percentDifference(Number(candidate.haul.quantity), line.quantity!), 0)
    );
    if (byQuantity.length > 0) pool = byQuantity;
  }

  return { pool, method, notes, poDisagrees };
}

const EMPTY_TOTALS = (): LineTotals => ({
  agreedRate: null,
  rateDiscrepancy: null,
  quantityDiscrepancy: null,
  rateUnitMismatch: false,
});

function windowText(line: HaulLineSubject, windowDays: number): string {
  const anchor = line.serviceDate ?? line.invoiceDate;
  if (!anchor) return '';
  return ` within ${windowDays} day${windowDays === 1 ? '' : 's'} of ${isoDay(anchor)}`;
}

/** The rate check: the billed price per unit against the dispatcher's. */
function rateCheck(
  line: HaulLineSubject,
  candidate: HaulCandidate,
  tolerances: HaulTolerances,
  totals: LineTotals
): MatchCheck {
  const haul = candidate.haul;
  if (haul.rateConflict) {
    return {
      name: 'haulRate',
      passed: false,
      code: 'TRIP_RATES_DIFFER',
      detail: `The loads of trip ${haul.tripRef} carry different rates on the dispatch board. Dispatch must set one rate for the trip`,
      found: line.unitRate,
    };
  }
  if (haul.rate === null) {
    return {
      name: 'haulRate',
      passed: false,
      code: 'NO_RATE_SET',
      detail: 'Dispatch has not set a haul rate on this load. Set it on the dispatch board, then re-run the check',
      found: line.unitRate,
    };
  }
  const rate = Number(haul.rate);
  if (line.unitRate === null) {
    return {
      name: 'haulRate',
      passed: false,
      detail: `No rate could be read from the invoice line (dispatch agreed ${money(rate)} per ${per(haul.rateUnit)})`,
      expected: rate,
    };
  }
  const units = compareUnits(line.unit, haul.rateUnit);
  if (!units.comparable) {
    totals.rateUnitMismatch = true;
    return {
      name: 'haulRate',
      passed: false,
      code: 'UNIT_MISMATCH',
      detail: `Dispatch agreed ${money(rate)} per ${per(haul.rateUnit)} and the line is billed per ${line.unit ?? 'an unrecorded unit'}, so the rate was not compared`,
      expected: rate,
      found: line.unitRate,
    };
  }

  const difference = percentDifference(rate, line.unitRate);
  const passed = withinTolerance(difference, tolerances.haulPriceTolerancePct);
  const delta = Number((line.unitRate - rate).toFixed(4));
  totals.agreedRate = rate;
  if (!passed) totals.rateDiscrepancy = delta;

  const direction = line.unitRate > rate ? 'above' : 'below';
  return {
    name: 'haulRate',
    passed,
    ...(passed ? {} : { code: 'RATE_MISMATCH' as const }),
    detail: passed
      ? delta === 0
        ? `Billed ${money(line.unitRate)} per ${per(haul.rateUnit)}, the rate dispatch set`
        : `Billed ${money(line.unitRate)} per ${per(haul.rateUnit)}, within ${tolerances.haulPriceTolerancePct}% of the ${money(rate)} dispatch set`
      : Number.isFinite(difference)
        ? `Billed ${money(line.unitRate)} per ${per(haul.rateUnit)} against the ${money(rate)} dispatch set, ${difference.toFixed(1)}% ${direction} it (${tolerances.haulPriceTolerancePct}% allowed)`
        : `Billed ${money(line.unitRate)} per ${per(haul.rateUnit)} against a dispatch rate of $0.00`,
    expected: rate,
    found: line.unitRate,
    delta,
  };
}

/**
 * The quantity check, where dispatch recorded an expected quantity. Expected
 * hours and tonnes are an estimate, so a small difference is reported, not
 * held against the line; only one past `haulQuantityReviewPct` stops it.
 */
function quantityCheck(
  line: HaulLineSubject,
  candidate: HaulCandidate,
  tolerances: HaulTolerances,
  totals: LineTotals
): MatchCheck | null {
  const haul = candidate.haul;
  if (haul.quantity === null || line.quantity === null) return null;
  if (!compareUnits(line.unit, haul.rateUnit).comparable) return null;

  const expected = Number(haul.quantity);
  const difference = percentDifference(expected, line.quantity);
  const delta = Number((line.quantity - expected).toFixed(4));
  const noun = `${per(haul.rateUnit)}s`;
  const tripNote = haul.tripRef && haul.rateUnit === 'LOAD' ? ' (a trip by the load is one load, whatever orders it served)' : '';

  if (withinTolerance(difference, 0)) {
    return {
      name: 'haulQuantity',
      passed: true,
      detail: `Billed ${line.quantity} ${noun}, as dispatch expected${tripNote}`,
      expected,
      found: line.quantity,
    };
  }
  const passed = withinTolerance(difference, tolerances.haulQuantityReviewPct);
  if (!passed) totals.quantityDiscrepancy = delta;
  return {
    name: 'haulQuantity',
    passed,
    detail: passed
      ? `Billed ${line.quantity} ${noun} where dispatch expected ${expected}. Noted only: the expected quantity is an estimate`
      : `Billed ${line.quantity} ${noun} where dispatch expected ${expected}${tripNote}, more than ${tolerances.haulQuantityReviewPct}% off`,
    expected,
    found: line.quantity,
    delta,
  };
}

/**
 * Is this trucking invoice line one load (or trip) dispatch sent, billed at
 * the rate dispatch set, and not already paid?
 *
 * `loads` may hold any loads; only this carrier's within the date window are
 * considered. The approved amount follows from `totals.agreedRate`: the
 * dispatcher's rate times the billed quantity, as for material lines.
 */
export function matchHaulLine(
  line: HaulLineSubject,
  loads: ReadonlyArray<CandidateLoad>,
  options: HaulMatchOptions
): HaulDecision {
  const { tolerances } = options;
  const anchor = line.serviceDate ?? line.invoiceDate;
  const candidates = haulCandidates(loads, line.supplierId, anchor, tolerances.haulDateWindowDays);
  const { pool, method, notes, poDisagrees } = identify(line, candidates);
  const totals = EMPTY_TOTALS();
  const noted = (text: string) => (notes.length === 0 ? text : `${text}. Note: ${notes.join('; ')}`);

  if (pool.length === 0) {
    const checks: MatchCheck[] = [
      {
        name: 'haulLoad',
        passed: false,
        code: 'NO_LOAD_FOUND',
        detail: noted(
          `No load hauled by this carrier is recorded on the dispatch board${windowText(line, tolerances.haulDateWindowDays)}. ` +
            'Check with dispatch which load this is'
        ),
      },
    ];
    return {
      status: 'UNMATCHED',
      orderId: null,
      ticketIds: [],
      candidateOrderIds: [],
      checks,
      reason: checks[0]!.detail,
      totals,
      loadIds: [],
    };
  }

  if (pool.length > 1) {
    const orderIds = [...new Set(pool.map((candidate) => candidate.loads[0]!.orderLineId).filter((id): id is string => id !== null))];
    const checks: MatchCheck[] = [
      {
        name: 'haulLoad',
        passed: false,
        detail: noted(
          `${pool.length} dispatched loads fit this line equally well: ${pool.map(describeHaul).join('; ')}. Choose the right one`
        ),
        found: pool.length,
      },
    ];
    return {
      status: 'CONFLICT',
      orderId: null,
      ticketIds: [],
      candidateOrderIds: orderIds,
      checks,
      reason: `${pool.length} dispatched loads fit this line equally well; a person must choose`,
      totals,
      loadIds: [],
    };
  }

  const candidate = pool[0]!;
  const checks: MatchCheck[] = [];

  const how =
    method === 'ticket'
      ? `found by ticket ${line.ticketNumber}`
      : method === 'po'
        ? `found by PO or order ${line.poNumber}`
        : 'found by carrier and date only';
  checks.push({
    name: 'haulLoad',
    passed: method !== 'date' && !poDisagrees,
    detail: noted(
      method === 'date'
        ? `Dispatch load ${describeHaul(candidate)}, ${how}: nothing on the line names it, so check this is the load billed`
        : `Dispatch load ${describeHaul(candidate)}, ${how}`
    ),
  });

  const paidElsewhere = claimedElsewhere(candidate, line.id);
  if (paidElsewhere.length > 0) {
    const first = paidElsewhere.find((load) => load.claim) ?? paidElsewhere[0]!;
    checks.push({
      name: 'loadReuse',
      passed: false,
      code: 'LOAD_ALREADY_CLAIMED',
      detail: first.claim
        ? `${candidate.haul.tripRef ? `Trip ${candidate.haul.tripRef}` : `Load ${first.documentNumber} load ${first.sequence}`} was already paid on invoice ${first.claim.invoiceNumber} line ${first.claim.lineNumber}. Paying this line would pay for that haul twice`
        : `${candidate.haul.tripRef ? `Trip ${candidate.haul.tripRef}` : `Load ${first.documentNumber} load ${first.sequence}`} was already paid on another invoice. Paying this line would pay for that haul twice`,
      found: paidElsewhere.length,
    });
  } else {
    checks.push({
      name: 'loadReuse',
      passed: true,
      detail: 'This haul has not been paid on another invoice',
    });
  }

  checks.push(rateCheck(line, candidate, tolerances, totals));
  const quantity = quantityCheck(line, candidate, tolerances, totals);
  if (quantity) checks.push(quantity);

  // Another line nobody has ruled on bills the same haul: a repeat invoice,
  // or the same load listed twice. Both lines see each other, so neither is
  // passed (and confirmed by Verify) just for being read first.
  const competing = (options.competingLines ?? []).filter(
    (other) =>
      other.invoiceLineId !== line.id && other.loadIds.some((id) => candidate.haul.loadIds.includes(id))
  );
  if (competing.length > 0) {
    const first = competing[0]!;
    checks.push({
      name: 'duplicateBilling',
      passed: false,
      detail: `This haul is also billed on invoice ${first.invoiceNumber} line ${first.lineNumber}, which has not been reviewed yet. Check whether one of them is a repeat`,
      found: competing.length,
    });
  }

  const failed = checks.filter((check) => !check.passed);
  return {
    status: failed.length === 0 ? 'MATCHED' : 'PARTIAL',
    orderId: candidate.loads[0]!.orderLineId,
    ticketIds: [],
    candidateOrderIds: [],
    checks,
    reason: failed.length === 0 ? 'Every check passed' : failed.map((check) => check.detail).join('; '),
    totals,
    loadIds: candidate.haul.loadIds,
  };
}
