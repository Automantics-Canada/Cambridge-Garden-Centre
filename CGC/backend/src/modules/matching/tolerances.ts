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
