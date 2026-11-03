/**
 * How much a delivery is allowed to differ from its order before a person is
 * asked about it.
 *
 * These are judgements about a business, not constants, so they live in
 * `SystemSetting` and are read at the start of a matching run rather than being
 * written into the comparison code. Aggregate is sold by weight off a truck
 * scale: a load ordered at 24 tonnes arriving at 24.3 is normal, and a system
 * that flagged it would be ignored within a week.
 *
 * The defaults below are a starting position, not a recommendation. They should
 * be set against the client's own tolerance for short loads once there is a
 * month of real verdicts to look at.
 */

export interface Tolerances {
  /** Percent a delivered quantity may differ from the ordered quantity. */
  quantityTolerancePct: number;
  /** Days either side of the order date a ticket may be dated. */
  dateWindowDays: number;
  /** Percent a billed rate may differ from the agreed rate. */
  priceTolerancePct: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  quantityTolerancePct: 2,
  dateWindowDays: 3,
  priceTolerancePct: 1,
};

export const TOLERANCE_SETTING_KEYS = {
  quantityTolerancePct: 'match.quantityTolerancePct',
  dateWindowDays: 'match.dateWindowDays',
  priceTolerancePct: 'match.priceTolerancePct',
} as const;

/**
 * Builds tolerances from stored settings, ignoring anything unusable.
 *
 * A malformed or negative setting falls back to the default rather than
 * throwing: a typo in a settings row should not stop every invoice in the
 * system from being checked, and a silently wider tolerance is the more
 * dangerous failure, so out-of-range values are rejected rather than clamped.
 */
export function resolveTolerances(
  settings: ReadonlyArray<{ key: string; value: unknown }> = []
): Tolerances {
  const byKey = new Map(settings.map((setting) => [setting.key, setting.value]));

  const read = (key: string, fallback: number): number => {
    const raw = byKey.get(key);

    // `Number(null)` and `Number('')` are both 0, and zero is a legitimate
    // tolerance meaning "must match exactly". Reading an absent or blank
    // setting as zero would quietly demand exact agreement on every load and
    // flag the entire ledger, so only a real number is accepted.
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN;

    if (!Number.isFinite(value) || value < 0 || value > 100) return fallback;
    return value;
  };

  return {
    quantityTolerancePct: read(
      TOLERANCE_SETTING_KEYS.quantityTolerancePct,
      DEFAULT_TOLERANCES.quantityTolerancePct
    ),
    dateWindowDays: read(
      TOLERANCE_SETTING_KEYS.dateWindowDays,
      DEFAULT_TOLERANCES.dateWindowDays
    ),
    priceTolerancePct: read(
      TOLERANCE_SETTING_KEYS.priceTolerancePct,
      DEFAULT_TOLERANCES.priceTolerancePct
    ),
  };
}

/**
 * How far a trucking invoice line may stray from the dispatch load it bills
 * (client, Oct 2026, Q14: the dispatcher sets a rate on every load and the
 * invoice is matched against it). Kept apart from `Tolerances` because a haul
 * is judged against the dispatcher's own figures, not against an order and its
 * scale tickets, and the client may want them set differently.
 *
 * Stored in `SystemSetting` like the others, so the office can change them
 * without a release.
 */
export interface HaulTolerances {
  /** Percent a billed haul rate may differ from the dispatcher's rate. */
  haulPriceTolerancePct: number;
  /**
   * Days either side of the line's haul date (or the invoice date) a load may
   * be dated. A week covers a carrier billing last week's loads; it also
   * bounds a trip reference reused weeks later, which must never match.
   */
  haulDateWindowDays: number;
  /**
   * A billed quantity this many percent away from the load's expected
   * quantity stops the line; nearer than that it is noted only. Expected
   * hours and tonnes are the dispatcher's estimate, not a measurement.
   */
  haulQuantityReviewPct: number;
}

export const DEFAULT_HAUL_TOLERANCES: HaulTolerances = {
  haulPriceTolerancePct: 1,
  haulDateWindowDays: 7,
  haulQuantityReviewPct: 25,
};

export const HAUL_TOLERANCE_SETTING_KEYS = {
  haulPriceTolerancePct: 'match.haulPriceTolerancePct',
  haulDateWindowDays: 'match.haulDateWindowDays',
  haulQuantityReviewPct: 'match.haulQuantityReviewPct',
} as const;

/**
 * Haul tolerances from stored settings, with the same rule as
 * `resolveTolerances`: anything unusable falls back to the default rather
 * than widening silently. A date window is capped at 31 days, because a
 * wider one would let a trip reference reused next month match this one.
 */
export function resolveHaulTolerances(
  settings: ReadonlyArray<{ key: string; value: unknown }> = []
): HaulTolerances {
  const byKey = new Map(settings.map((setting) => [setting.key, setting.value]));
  const read = (key: string, fallback: number, max: number): number => {
    const raw = byKey.get(key);
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN;
    if (!Number.isFinite(value) || value < 0 || value > max) return fallback;
    return value;
  };
  return {
    haulPriceTolerancePct: read(
      HAUL_TOLERANCE_SETTING_KEYS.haulPriceTolerancePct,
      DEFAULT_HAUL_TOLERANCES.haulPriceTolerancePct,
      100
    ),
    haulDateWindowDays: read(
      HAUL_TOLERANCE_SETTING_KEYS.haulDateWindowDays,
      DEFAULT_HAUL_TOLERANCES.haulDateWindowDays,
      31
    ),
    haulQuantityReviewPct: read(
      HAUL_TOLERANCE_SETTING_KEYS.haulQuantityReviewPct,
      DEFAULT_HAUL_TOLERANCES.haulQuantityReviewPct,
      100
    ),
  };
}
