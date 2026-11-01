import { classifyLine } from '../orders/import/lineClass.js';

/**
 * How an order's goods reach the customer: one of five ways.
 *
 * Spruce has no field for it. Counter staff write it into the order instead —
 * "Pickup Direct at Permacon," as the ship-to, a "FOB UNILOCK AYR" comment, a
 * "Unilock Direct Delivery" line — and a CGC truck's involvement shows in the
 * Deliveries report, the Order report's SCH and CGC's own delivery charges.
 * These rules read those, for any supplier, as the manager's spec of 22/10/2026
 * ("Order Fulfilment Types") lays them out. A vendor or PO on the lines is
 * never a signal on its own: 721436 (Unilock PO, the customer collects) and
 * 721443 (Willson PO, a CGC truck delivers) both carry one.
 *
 * The client's answers of Oct 2026 settled the rest: "FOB <supplier>" means
 * the customer collects there more than 95% of the time; a supplier's own
 * truck is rarely used, and the sign of one is a freight line on the PO, which
 * the app cannot read yet; a PO on the goods means a CGC truck collects at
 * that supplier; and dispatch decides which pit a "PitBlk" order comes from.
 * So the exceptions are the office's to set on the order: the type itself
 * (`override`) and the pit or supplier to load at (`pit`). Either wins over
 * anything the reports say.
 *
 * Pure, and read whenever an order is shown, so every order already imported
 * is classified too and a corrected rule corrects them all.
 */

export type FulfilmentType =
  /** The customer collects at CGC's yard. */
  | 'yard_pickup'
  /** A CGC truck takes yard stock to the site. */
  | 'yard_delivery'
  /** A CGC truck collects at a supplier or pit (A), then delivers to the site (B). */
  | 'supplier_haul_delivery'
  /** The customer collects at the supplier. */
  | 'external_pickup'
  /** The supplier's own truck delivers to the site. */
  | 'supplier_direct_ship';

export const FULFILMENT_TYPES: readonly FulfilmentType[] = [
  'yard_pickup',
  'yard_delivery',
  'supplier_haul_delivery',
  'external_pickup',
  'supplier_direct_ship',
];

export const isFulfilmentType = (value: unknown): value is FulfilmentType =>
  typeof value === 'string' && (FULFILMENT_TYPES as readonly string[]).includes(value);

/**
 * The customer collects: at CGC's yard, or at the supplier. No CGC truck and
 * no stop, so `OrderDocument.isPickup` is true for these (see derivePickup).
 */
export const customerCollects = (type: FulfilmentType) => type === 'yard_pickup' || type === 'external_pickup';

export type FulfilmentCheck =
  /** An external order that a CGC truck also seems to carry: staff decide. */
  | 'ON_CGC_DELIVERY_SCHEDULE'
  | 'SUPPLIER_NOT_NAMED'
  /** A delivery via a pit with no supplier PO: matched on "PitBlk" alone. */
  | 'NO_SUPPLIER_PO'
  /** A direct ship no line has raised a supplier PO for yet. */
  | 'NO_SUPPLIER_PO_YET'
  /**
   * The Order report leaves out an order that mentions a supplier delivery.
   * Usually a quotation: the one real example, 721522, was one (client, Oct 2026).
   */
  | 'NOT_IN_ORDER_REPORT'
  /**
   * "Unilock Direct Delivery", "drop ship": the order says a supplier's truck
   * delivers. The client rarely uses supplier delivery and signals it with a
   * freight line on the PO, which the app cannot read yet, so the wording
   * alone no longer hides the order from dispatch: it stays CGC work, and
   * staff confirm (or set "Direct ship" on the order).
   */
  | 'SUPPLIER_DELIVERY_NOTED'
  /**
   * A CGC delivery with no date that no Deliveries report has listed. The
   * client (Oct 2026): such an order, with a delivery charge, is a delivery
   * that was most likely done already, on an earlier day's report.
   */
  | 'NOT_ON_DELIVERIES_REPORT'
  | 'PICKUP_AND_DIRECT_BOTH_NOTED';

/** Where the goods are, for the types that involve a supplier or pit. */
export interface FulfilmentPlace {
  /** The supplier: "Unilock", "Willson", "GALTGRAV01"; null for a pit nobody named. */
  name: string | null;
  /** "Ayr", "Cambridge"; null where none is given. */
  location: string | null;
  /** The supplier's address on file, where it is that location's. */
  address: string | null;
  /** The supplier PO raised for these goods. */
  po: string | null;
}

export interface Fulfilment {
  type: FulfilmentType;
  /** Empty for the yard types. One per supplier for a delivery via suppliers. */
  places: FulfilmentPlace[];
  /**
   * What decided it, as printed, so staff can see why. STAFF: the office set
   * the type on the order. H2: the office named the pit or supplier to load at.
   */
  signal: { id: 'D1' | 'D2' | 'P1' | 'P2' | 'H1' | 'H2' | 'STAFF'; text: string } | null;
  checks: FulfilmentCheck[];
}

export interface FulfilmentLine {
  itemCode: string | null;
  description: string | null;
  lineClass: string | null;
  poNumber: string | null;
  vendorCode: string | null;
  vendorLocation: string | null;
  /** The supplier the line or its vendor code is linked to, where one is. */
  supplierName: string | null;
  supplierAddress: string | null;
  /** That supplier's id, for finding the PO raised with the pit dispatch chose. */
  supplierId?: string | null;
}

/** The pit or supplier dispatch chose to load at (`OrderDocument.pickupSupplierId`). */
export interface DispatchPit {
  id: string;
  name: string;
  address: string | null;
  /** Which of its yards, as dispatch typed it (`OrderDocument.pickupLocation`). */
  location: string | null;
}

export interface FulfilmentInput {
  /** What the import decided; the fallback between yard pickup and yard delivery. */
  isPickup: boolean;
  shippingAddress: string | null;
  deliveryInstructions: string | null;
  orderNotes: string | null;
  /** The Order report's Delivery column: "SCH" for a scheduled delivery. */
  deliveryFlag: string | null;
  /** Which reports have listed the order. */
  sourceReports: readonly string[];
  /** The delivery date as it stands; null when Spruce has none. */
  deliveryDate: Date | null;
  lines: FulfilmentLine[];
  /**
   * The type dispatch set on the order (`OrderDocument.fulfilmentOverride`).
   * It wins over every signal; null or unknown means "as the reports say".
   */
  override?: string | null;
  /** Where dispatch said to load: wins over the PO's vendor for a CGC delivery. */
  pit?: DispatchPit | null;
}

const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** "UNILOCK AYR" → "Unilock Ayr"; a code with digits stays as printed. */
function titled(text: string): string {
  return text
    .split(' ')
    .filter(Boolean)
    .map(word => (/\d/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

/** "D1": "{Supplier} Direct Delivery", with trailing words such as "Charge" allowed. */
const DIRECT_DELIVERY = /\b([a-z][a-z&'.-]*(?:\s+[a-z][a-z&'.-]*){0,2})\s+direct\s+deliver(?:y|ed)\b/i;
/** "D2": other direct-to-site wording. */
const DIRECT_SHIP = /\b(?:direct\s+ship(?:ped|ment)?|ship(?:ped)?\s+direct|drop\s*-?\s*ship(?:ped|ment)?)\b/i;
/** "P1": "Pickup at {Supplier}," and its variants; stops at the comma the report appends. */
const PICKUP_AT = /\bpick\s*-?\s*up\s+(?:direct\s+)?(?:at|@|from)\s+([a-z][a-z .&'-]*?)\s*(?:,|$)/i;
/** The comment form CGC already used for direct pickups: "**Pickup direct pricing @ Quikrete.**". */
const PICKUP_DIRECT_COMMENT = /pick\s*-?\s*up\s+direct\b[^@]*@\s*([^*\n]+?)[\s.*]*$/i;
/** "P2": a line, note or instruction that starts "FOB {Supplier} {Location}". */
const FOB = /^\s*f\.?o\.?b\.?\s+([a-z][a-z&'.-]*)(?:\s+(.+?))?\s*$/i;
/** Words that name CGC itself, never a supplier. */
const CGC_ITSELF = /^(?:cgc|cambridge|yard|the\s+yard|cambridge\s+garden(?:\s+cent(?:re|er))?)\b/i;
/** A supplier word that is really CGC's own yard: "Pick up at yard", "FOB CGC". */
const isCgc = (word: string) => CGC_ITSELF.test(word.trim());

/**
 * A line such as "Unilock Direct Delivery": a supplier's delivery, not one of
 * CGC's own delivery charges, though Spruce files it under a MISCDEL code.
 */
export const isSupplierDeliveryLine = (description: string | null | undefined) =>
  DIRECT_DELIVERY.test(squash(description));

const classOf = (line: FulfilmentLine) => line.lineClass ?? classifyLine(line.itemCode, line.description);
const isGoods = (line: FulfilmentLine) => classOf(line) === 'PRODUCT';
const isComment = (line: FulfilmentLine) => classOf(line) === 'COMMENT';

/** Pit stock, as opposed to "YrdBlk", yard stock. */
const PIT = /\bpit\s*blk\b/i;

/** The lines whose vendor the supplier word names: UNILOCK → UNILOCKL01. */
function linesOf(word: string, lines: FulfilmentLine[]) {
  const key = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (!key) return [];
  return lines.filter(line =>
    line.poNumber &&
    ((line.vendorCode && line.vendorCode.toUpperCase().replace(/[^A-Z]/g, '').startsWith(key.slice(0, 6))) ||
      (line.supplierName && line.supplierName.toUpperCase().replace(/[^A-Z]/g, '').startsWith(key.slice(0, 6))))
  );
}

/** The supplier's address on file, where it is the named yard's (or no yard is named). */
function addressAt(onFile: string | null | undefined, location: string | null): string | null {
  const address = onFile?.trim() || null;
  return address && (!location || address.toLowerCase().includes(location.toLowerCase())) ? address : null;
}

/** A place for an external order: the supplier as the text names it, the PO from its vendor's lines. */
function externalPlace(word: string | null, location: string | null, lines: FulfilmentLine[]): FulfilmentPlace {
  const linked = word ? linesOf(word, lines)[0] : undefined;
  const yard = location ? titled(squash(location)) : null;
  return {
    name: word ? titled(word.trim()) : null,
    location: yard,
    address: addressAt(linked?.supplierAddress, yard),
    po: linked?.poNumber ?? null,
  };
}

/** The supplier's name for a haul: its name on file, else its code (title-cased when it is a word). */
function vendorName(line: FulfilmentLine): string | null {
  return line.supplierName?.trim() || (line.vendorCode ? titled(line.vendorCode.trim()) : null);
}

/**
 * Where dispatch said to load. The PO is the one raised with that very
 * supplier record, if any line has one; never another supplier's, which their
 * counter would not know. Matched by record, not by name: "Example Pit" and
 * "Example Quarry" share the prefix `linesOf` goes by.
 */
function pitPlace(pit: DispatchPit, lines: FulfilmentLine[]): FulfilmentPlace {
  const linked = lines.find(line => line.poNumber && line.supplierId === pit.id);
  const location = pit.location?.trim() || null;
  return { name: pit.name, location, address: addressAt(pit.address, location), po: linked?.poNumber ?? null };
}

/** Goods bought in on a supplier PO: one place per supplier, yard and PO, in line order. */
function boughtPlaces(goods: FulfilmentLine[]): FulfilmentPlace[] {
  const places: FulfilmentPlace[] = [];
  const seen = new Set<string>();
  for (const line of goods) {
    if (!line.poNumber || !(line.vendorCode || line.supplierName)) continue;
    const name = vendorName(line);
    const location = line.vendorLocation?.trim() || null;
    const key = JSON.stringify([name, location, line.poNumber]);
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ name, location, address: addressAt(line.supplierAddress, location), po: line.poNumber });
  }
  return places;
}

const UNNAMED: FulfilmentPlace = { name: null, location: null, address: null, po: null };

const STAFF = { id: 'STAFF' as const, text: 'Set by dispatch' };

/**
 * The type dispatch set, with the places it needs. A haul goes to the pit
 * dispatch named, else the place the order's own wording names (an FOB order
 * collected by a CGC truck after all: the FOB yard and its PO, not the Item
 * Tracking vendor's other yard), else the suppliers on its POs.
 */
function staffChoice(
  type: FulfilmentType,
  order: FulfilmentInput,
  context: { goods: FulfilmentLine[]; pickupPlace: FulfilmentPlace | null; directSupplier: string | null }
): Fulfilment {
  const lines = order.lines;
  const pit = order.pit ? pitPlace(order.pit, lines) : null;
  const named = (places: FulfilmentPlace[]): FulfilmentCheck[] =>
    places.some(place => !place.name) ? ['SUPPLIER_NOT_NAMED'] : [];

  if (type === 'yard_pickup' || type === 'yard_delivery') return { type, places: [], signal: STAFF, checks: [] };

  if (type === 'supplier_haul_delivery') {
    const bought = boughtPlaces(context.goods);
    const places = pit ? [pit] : context.pickupPlace ? [context.pickupPlace] : bought.length > 0 ? bought : [UNNAMED];
    return { type, places, signal: STAFF, checks: named(places) };
  }

  if (type === 'external_pickup') {
    const place = pit ?? context.pickupPlace ?? boughtPlaces(context.goods)[0] ?? UNNAMED;
    return { type, places: [place], signal: STAFF, checks: named([place]) };
  }

  // supplier_direct_ship
  const vendorLine = lines.find(line => line.poNumber && (line.vendorCode || line.supplierName));
  let place = pit;
  if (!place && context.directSupplier) place = externalPlace(context.directSupplier, null, lines);
  if (!place && vendorLine) place = { name: vendorName(vendorLine), location: null, address: null, po: vendorLine.poNumber };
  place ??= UNNAMED;
  const checks: FulfilmentCheck[] = [];
  if (!lines.some(line => line.poNumber || line.vendorCode)) checks.push('NO_SUPPLIER_PO_YET');
  checks.push(...named([place]));
  return { type, places: [place], signal: STAFF, checks };
}

export function classifyFulfilment(order: FulfilmentInput): Fulfilment {
  const lines = order.lines;
  const goods = lines.filter(isGoods);
  const texts = [squash(order.orderNotes), squash(order.deliveryInstructions)].filter(Boolean);
  const address = squash(order.shippingAddress);
  const comments = lines.filter(isComment).map(line => squash(line.description));
  const descriptions = lines.map(line => squash(line.description));

  // Y1: a CGC truck delivers it.
  const scheduled = order.sourceReports.includes('DELIVERY') || squash(order.deliveryFlag).toUpperCase() === 'SCH';
  const cgcDelivers = scheduled ||
    lines.some(line => classOf(line) === 'DELIVERY_CHARGE' && !isSupplierDeliveryLine(line.description));

  // D1 / D2: the order says a supplier's truck delivers.
  let direct: Fulfilment['signal'] = null;
  let directSupplier: string | null = null;
  for (const text of descriptions) {
    const match = DIRECT_DELIVERY.exec(text);
    if (match) {
      direct = { id: 'D1', text };
      // The supplier is the last captured word that names one, else the last word.
      const words = match[1]!.split(/\s+/);
      directSupplier = words.find(word => linesOf(word, lines).length > 0) ?? words[words.length - 1]!;
      break;
    }
  }
  if (!direct) {
    const text = [...descriptions, ...texts, address].find(candidate => DIRECT_SHIP.test(candidate));
    if (text) direct = { id: 'D2', text };
  }

  // P1 / P2: the customer collects at the supplier.
  let pickup: Fulfilment['signal'] = null;
  let pickupPlace: FulfilmentPlace | null = null;
  for (const text of [address, ...texts]) {
    const match = PICKUP_AT.exec(text);
    if (match && !isCgc(match[1]!)) {
      pickup = { id: 'P1', text };
      pickupPlace = externalPlace(match[1]!, null, lines);
      break;
    }
  }
  if (!pickup) {
    for (const text of comments) {
      const match = PICKUP_DIRECT_COMMENT.exec(text);
      if (match && !isCgc(match[1]!)) {
        pickup = { id: 'P1', text };
        pickupPlace = externalPlace(match[1]!, null, lines);
        break;
      }
    }
  }
  if (!pickup) {
    for (const text of [...comments, ...texts]) {
      const match = FOB.exec(text);
      if (match && !isCgc(match[1]!)) {
        pickup = { id: 'P2', text };
        pickupPlace = externalPlace(match[1]!, match[2] ?? null, lines);
        break;
      }
    }
  }

  // Dispatch's word wins over every signal.
  if (isFulfilmentType(order.override)) {
    return staffChoice(order.override, order, { goods, pickupPlace, directSupplier });
  }

  if (pickup && pickupPlace) {
    const checks: FulfilmentCheck[] = [];
    if (!pickupPlace.name) checks.push('SUPPLIER_NOT_NAMED');
    if (cgcDelivers) checks.push('ON_CGC_DELIVERY_SCHEDULE');
    if (direct) checks.push('PICKUP_AND_DIRECT_BOTH_NOTED');
    return { type: 'external_pickup', places: [pickupPlace], signal: pickup, checks };
  }

  if (cgcDelivers || direct || !order.isPickup) {
    // Supplier-delivery wording keeps the order CGC's work (client, Oct 2026:
    // "most often we deliver ourselves or broker our own truck"), noted.
    const noted: FulfilmentCheck[] = [];
    if (direct) {
      noted.push('SUPPLIER_DELIVERY_NOTED');
      if (!order.sourceReports.includes('ORDER_SUMMARY')) noted.push('NOT_IN_ORDER_REPORT');
    }
    // Undated and on no Deliveries report: most likely delivered already, on
    // a day before the app saw its report (client, Oct 2026).
    if (!order.deliveryDate && !scheduled) noted.push('NOT_ON_DELIVERIES_REPORT');

    // H2: dispatch named where to load. Explicit, so it wins over the PO's vendor.
    if (order.pit) {
      return {
        type: 'supplier_haul_delivery',
        places: [pitPlace(order.pit, lines)],
        signal: { id: 'H2', text: `Set by dispatch: ${order.pit.name}` },
        checks: noted,
      };
    }

    // H1: the goods are collected first, at a supplier on a PO or at a pit.
    // A PO on the goods means CGC collects at that supplier (client, Oct 2026).
    const bought = boughtPlaces(goods);
    if (bought.length > 0) {
      const first = goods.find(line => line.poNumber && (line.vendorCode || line.supplierName))!;
      return {
        type: 'supplier_haul_delivery',
        places: bought,
        signal: { id: 'H1', text: (first.vendorCode ?? first.supplierName)!.trim() },
        checks: noted,
      };
    }
    const pit = goods.find(line => PIT.test(squash(line.description)));
    if (pit) {
      return {
        type: 'supplier_haul_delivery',
        places: [{ ...UNNAMED }],
        signal: { id: 'H1', text: squash(pit.description) },
        checks: ['NO_SUPPLIER_PO', 'SUPPLIER_NOT_NAMED', ...noted],
      };
    }
    return { type: 'yard_delivery', places: [], signal: direct, checks: noted };
  }

  return { type: 'yard_pickup', places: [], signal: null, checks: [] };
}
