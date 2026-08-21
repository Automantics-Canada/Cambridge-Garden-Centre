import type { ParsedSpruceRow } from './spruceReportTypes.js';

/**
 * Pairing an imported document's lines with the rows already stored for it.
 *
 * The three Spruce reports print one document's lines in *different orders* —
 * on the sample day, document 2608-712590 opens with a comment line in the
 * Customer Order Summary and with `BCAM28GG` in the Item Tracking report, and
 * 2608-712622's delivery sheet puts its delivery charge first where the other
 * two put it last. Identity by place in the document therefore overwrote a
 * different product onto each existing row on every cross-report re-import,
 * with the row's deliveries, tickets and invoices still attached to it.
 *
 * Lines are instead paired by what they are, in decreasing certainty:
 *
 *   1. item code + description + unit + quantity   (the same line, surely)
 *   2. item code + description + unit              (quantity changed in Spruce)
 *   3. item code alone, when exactly one survives  (description was renamed)
 *   4. description + unit + quantity, on rows with no code
 *      (legacy rows awaiting their first coded import, and comment lines)
 *   5. description + unit alone, when exactly one survives
 *
 * Anything left is either new (create) or genuinely ambiguous (conflict).
 * Ambiguity is refused rather than resolved arbitrarily: when two stored rows
 * carry the same code and neither's quantity matches, picking one could move
 * an invoiced line's identity onto the other. A conflict aborts the whole
 * document — the importer applies nothing it cannot stand behind.
 *
 * This module is pure: it decides, the importer writes.
 */

/** The fields of a stored Order a reconciliation needs to see. */
export interface ExistingLine {
  id: string;
  product: string;
  /** Prisma Decimal arrives as a Decimal or string depending on the query; both read as numbers here. */
  quantity: unknown;
  unit: string | null;
  spruceItemNumber: string | null;
  lineNumber: number | null;
  /** Existing line-level PO, when one can disambiguate otherwise identical rows. */
  poNumber?: string | null;
  /**
   * True when the row carries workflow state — an invoice, a driver, a
   * dispatch — that a wrong pairing would silently re-point. Ambiguous
   * matches against such a row become conflicts instead of guesses.
   */
  hasOperationalLinks?: boolean;
}

/** Field-level changes for one existing row. Only differing fields appear. */
export interface LinePatch {
  product?: string;
  quantity?: string;
  unit?: string;
  spruceItemNumber?: string;
}

/** An existing row the report pairs with, and what will change on it. */
export type PairedLine =
  | { kind: 'unchanged'; id: string; incomingIndex: number }
  | { kind: 'update'; id: string; incomingIndex: number; patch: LinePatch };

/** An incoming row this module refuses to place. The importer aborts its document. */
export interface ReconciliationConflict {
  incomingIndex: number;
  reason: string;
}

export interface ReconciliationPlan {
  /** Every incoming row that found an existing counterpart, in report order. */
  paired: PairedLine[];
  /** Indices into the incoming rows with no existing counterpart; the importer creates these. */
  createIndices: number[];
  /**
   * Existing rows this report does not mention — a line deleted or credited in
   * Spruce since the last import. Reported, never deleted here: such a row may
   * already carry deliveries, tickets or invoices that outlive the report.
   */
  absentIds: string[];
  /** Incoming rows that could not be placed without guessing. */
  conflicts: ReconciliationConflict[];
}

function normaliseCode(text: string): string {
  return text.trim().toUpperCase();
}

function normaliseDescription(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normaliseUnit(text: string | null | undefined): string {
  return (text ?? '').trim().toLowerCase();
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

function sameQuantity(a: number, b: unknown): boolean {
  const other = toNumber(b);
  return other !== null && Math.abs(a - other) < 1e-9;
}

/** A report without a unit column says nothing about the stored one. */
function unitsCompatible(incoming: string | undefined, stored: string | null): boolean {
  return incoming === undefined || normaliseUnit(incoming) === normaliseUnit(stored);
}

/**
 * Pairs one document's incoming lines against its stored lines.
 *
 * `existing` may contain rows from any era: legacy rows have no
 * `spruceItemNumber` yet and are adopted through their description, gaining
 * the code on the first update. Rows are never reordered, deleted or merged —
 * a plan is the only output, and applying it is the importer's job.
 */
export function reconcileDocumentLines(
  incoming: ParsedSpruceRow[],
  existing: ExistingLine[]
): ReconciliationPlan {
  const plan: ReconciliationPlan = {
    paired: [],
    createIndices: [],
    absentIds: [],
    conflicts: [],
  };

  // Candidates in a deterministic order — position in the document first, then
  // id — so identical rows pair the same way however the database returned them.
  const candidates = [...existing].sort((a, b) =>
    ((a.lineNumber ?? Number.MAX_SAFE_INTEGER) - (b.lineNumber ?? Number.MAX_SAFE_INTEGER)) ||
    a.id.localeCompare(b.id)
  );
  const matched = new Set<string>();

  const take = (line: ExistingLine): void => { matched.add(line.id); };
  const unmatched = (): ExistingLine[] => candidates.filter(line => !matched.has(line.id));

  for (const [index, row] of incoming.entries()) {
    const pool = unmatched();

    // --- Coded rows: match by item code first.
    if (row.itemNumber) {
      const code = normaliseCode(row.itemNumber);
      const codeMatches = pool.filter(
        line => line.spruceItemNumber != null &&
          normaliseCode(line.spruceItemNumber) === code
      );

      const exact = codeMatches.filter(line =>
        normaliseDescription(line.product) === normaliseDescription(row.product) &&
        unitsCompatible(row.unit, line.unit) &&
        sameQuantity(row.quantity, line.quantity)
      );
      if (exact.length === 1) {
        take(exact[0]!);
        plan.paired.push(pairFor(index, row, exact[0]!));
        continue;
      }
      if (exact.length > 1) {
        const poMatch = matchByIncomingPo(exact, row);
        if (poMatch) {
          take(poMatch);
          plan.paired.push(pairFor(index, row, poMatch));
          continue;
        }
        if (exact.every(line => !line.hasOperationalLinks)) {
          take(exact[0]!);
          plan.paired.push(pairFor(index, row, exact[0]!));
          continue;
        }
        plan.conflicts.push({
          incomingIndex: index,
          reason: `several operationally-linked stored lines are identical for item ${code}; ` +
            'the report does not identify which relationship belongs to this line',
        });
        continue;
      }

      const sameContent = codeMatches.filter(line =>
        normaliseDescription(line.product) === normaliseDescription(row.product) &&
        unitsCompatible(row.unit, line.unit)
      );
      if (sameContent.length === 1) {
        take(sameContent[0]!);
        plan.paired.push(pairFor(index, row, sameContent[0]!));
        continue;
      }
      if (sameContent.length > 1) {
        // Same code, description and unit; only the quantities differ. With
        // identical quantities the rows are interchangeable and either will
        // do; otherwise choosing is a guess that could move an invoiced line.
        if (sameContent.every(line => !line.hasOperationalLinks)) {
          take(sameContent[0]!);
          plan.paired.push(pairFor(index, row, sameContent[0]!));
          continue;
        }
        plan.conflicts.push({
          incomingIndex: index,
          reason: `several stored lines carry item ${code} with different quantities and one or more are invoiced or dispatched; ` +
            'pairing them cannot be done safely from this report',
        });
        continue;
      }

      // The reports sometimes abbreviate the description differently while
      // keeping a repeated code (BSKID/USKID/MSKID). Quantity is then the only
      // shared discriminator, and the real Aug 14 reports contain several
      // documents where it is unique among that code's lines.
      const sameAmount = codeMatches.filter(line => sameQuantity(row.quantity, line.quantity));
      if (sameAmount.length === 1) {
        take(sameAmount[0]!);
        plan.paired.push(pairFor(index, row, sameAmount[0]!));
        continue;
      }
      if (sameAmount.length > 1) {
        const poMatch = matchByIncomingPo(sameAmount, row);
        if (poMatch) {
          take(poMatch);
          plan.paired.push(pairFor(index, row, poMatch));
          continue;
        }
        if (sameAmount.every(line => !line.hasOperationalLinks)) {
          take(sameAmount[0]!);
          plan.paired.push(pairFor(index, row, sameAmount[0]!));
          continue;
        }
        plan.conflicts.push({
          incomingIndex: index,
          reason: `several operationally-linked stored lines carry item ${code} with quantity ${row.quantity}; ` +
            'the report does not identify which relationship belongs to this line',
        });
        continue;
      }

      if (codeMatches.length === 1) {
        // The one survivor of this code: Spruce may have renamed it.
        take(codeMatches[0]!);
        plan.paired.push(pairFor(index, row, codeMatches[0]!));
        continue;
      }
      if (codeMatches.length > 1) {
        plan.conflicts.push({
          incomingIndex: index,
          reason: `several stored lines carry item ${code} with descriptions this report does not match`,
        });
        continue;
      }

      // No stored row has this code — but a legacy row imported before codes
      // were recorded may still be this very line. Adopt it by description.
      const adopted = matchWithoutCode(pool, row);
      if (adopted.kind === 'matched') {
        take(adopted.line);
        plan.paired.push({
          kind: 'update',
          id: adopted.line.id,
          incomingIndex: index,
          patch: { ...(adopted.patch ?? {}), spruceItemNumber: row.itemNumber.trim() },
        });
        continue;
      }
      if (adopted.kind === 'conflict') {
        plan.conflicts.push({ incomingIndex: index, reason: adopted.reason });
        continue;
      }

      plan.createIndices.push(index);
      continue;
    }

    // --- Uncoded rows (comments, deposits, charges): description only.
    const outcome = matchWithoutCode(pool, row);
    if (outcome.kind === 'matched') {
      take(outcome.line);
      plan.paired.push(
        outcome.patch
          ? { kind: 'update', id: outcome.line.id, incomingIndex: index, patch: outcome.patch }
          : { kind: 'unchanged', id: outcome.line.id, incomingIndex: index }
      );
      continue;
    }
    if (outcome.kind === 'conflict') {
      plan.conflicts.push({ incomingIndex: index, reason: outcome.reason });
      continue;
    }

    plan.createIndices.push(index);
  }

  for (const line of unmatched()) plan.absentIds.push(line.id);

  function pairFor(index: number, row: ParsedSpruceRow, line: ExistingLine): PairedLine {
    const patch: LinePatch = {};

    if (normaliseDescription(row.product) !== normaliseDescription(line.product)) {
      patch.product = row.product;
    }
    if (!sameQuantity(row.quantity, line.quantity)) {
      patch.quantity = row.quantity.toString();
    }
    if (row.unit !== undefined && !unitsCompatible(row.unit, line.unit)) {
      patch.unit = row.unit;
    }
    if (
      row.itemNumber &&
      normaliseCode(row.itemNumber) !== (line.spruceItemNumber ?? '').trim().toUpperCase()
    ) {
      patch.spruceItemNumber = row.itemNumber.trim();
    }

    return Object.keys(patch).length === 0
      ? { kind: 'unchanged', id: line.id, incomingIndex: index }
      : { kind: 'update', id: line.id, incomingIndex: index, patch };
  }

  return plan;
}

type UncodedOutcome =
  | { kind: 'none' }
  | { kind: 'matched'; line: ExistingLine; patch?: LinePatch }
  | { kind: 'conflict'; reason: string };

/**
 * Matches an incoming row against rows that carry no item code — legacy rows
 * awaiting their first coded import, and comment or charge lines, which never
 * have one. Quantity agreement pairs confidently; description agreement alone
 * pairs only when exactly one candidate remains.
 */
function matchWithoutCode(pool: ExistingLine[], row: ParsedSpruceRow): UncodedOutcome {
  const uncoded = pool.filter(line => line.spruceItemNumber == null);

  const desc = normaliseDescription(row.product);
  const descMatches = uncoded.filter(
    line => normaliseDescription(line.product) === desc && unitsCompatible(row.unit, line.unit)
  );

  const exact = descMatches.filter(line => sameQuantity(row.quantity, line.quantity));
  if (exact.length > 0) {
    const line = exact.length === 1
      ? exact[0]!
      : matchByIncomingPo(exact, row) ??
        (exact.every(candidate => !candidate.hasOperationalLinks) ? exact[0]! : undefined);
    if (!line) {
      return {
        kind: 'conflict',
        reason: `several operationally-linked stored lines read "${row.product}" with the same quantity; ` +
          'the report does not identify which relationship belongs to this line',
      };
    }
    const patch: LinePatch = {};
    if (row.unit !== undefined && !unitsCompatible(row.unit, line.unit)) patch.unit = row.unit;
    return Object.keys(patch).length > 0
      ? { kind: 'matched', line, patch }
      : { kind: 'matched', line };
  }

  if (descMatches.length === 1) {
    const line = descMatches[0]!;
    const patch: LinePatch = {};
    if (!sameQuantity(row.quantity, line.quantity)) patch.quantity = row.quantity.toString();
    if (row.unit !== undefined && !unitsCompatible(row.unit, line.unit)) patch.unit = row.unit;
    return Object.keys(patch).length > 0
      ? { kind: 'matched', line, patch }
      : { kind: 'matched', line };
  }

  if (descMatches.length > 1) {
    return {
      kind: 'conflict',
      reason: `several stored lines read "${row.product}" with different quantities and none matches this row's; ` +
        `pairing ${row.itemNumber ? `${row.itemNumber} (${row.product})` : `"${row.product}"`} cannot be done safely from this report`,
    };
  }

  return { kind: 'none' };
}

function matchByIncomingPo(
  candidates: ExistingLine[],
  row: ParsedSpruceRow
): ExistingLine | undefined {
  const po = row.poNumber?.trim().toUpperCase();
  if (!po) return undefined;
  const matches = candidates.filter(
    candidate => candidate.poNumber?.trim().toUpperCase() === po
  );
  return matches.length === 1 ? matches[0] : undefined;
}
