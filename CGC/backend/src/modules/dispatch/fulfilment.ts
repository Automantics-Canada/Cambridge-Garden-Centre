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

export type FulfilmentCheck =
  /** An external order that a CGC truck also seems to carry: staff decide. */
  | 'ON_CGC_DELIVERY_SCHEDULE'
  | 'SUPPLIER_NOT_NAMED'
  /** A delivery via a pit with no supplier PO: matched on "PitBlk" alone. */
  | 'NO_SUPPLIER_PO'
  /** A direct ship no line has raised a supplier PO for yet. */
  | 'NO_SUPPLIER_PO_YET'
  /** A direct ship the Order report leaves out; why is not yet known. */
  | 'NOT_IN_ORDER_REPORT'
  | 'PICKUP_AND_DIRECT_BOTH_NOTED'
  /** Yard stock ("YrdBlk") bought on a supplier PO for a scheduled delivery. */
  | 'CHECK_PICKUP_POINT';

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
  /** What decided it, as printed, so staff can see why. */
  signal: { id: 'D1' | 'D2' | 'P1' | 'P2' | 'H1'; text: string } | null;
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
  sourceReports: string[];
  lines: FulfilmentLine[];
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

const classOf = (line: FulfilmentLine) => line.lineClass ?? classifyLine(line.itemCode, line.description);
const isGoods = (line: FulfilmentLine) => classOf(line) === 'PRODUCT';
const isComment = (line: FulfilmentLine) => classOf(line) === 'COMMENT';

/** Pit stock, as opposed to "YrdBlk", yard stock. */
const PIT = /\bpit\s*blk\b/i;
const YARD_STOCK = /\byrd\s*blk\b/i;

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

/** A place for an external order: the supplier as the text names it, the PO from its vendor's lines. */
function externalPlace(word: string | null, location: string | null, lines: FulfilmentLine[]): FulfilmentPlace {
  const linked = word ? linesOf(word, lines)[0] : undefined;
  return {
    name: word ? titled(word.trim()) : null,
    location: location ? titled(squash(location)) : null,
    address: null,
    po: linked?.poNumber ?? null,
  };
}

/** The supplier's name for a haul: its name on file, else its code (title-cased when it is a word). */
function vendorName(line: FulfilmentLine): string | null {
  return line.supplierName?.trim() || (line.vendorCode ? titled(line.vendorCode.trim()) : null);
}

export function classifyFulfilment(order: FulfilmentInput): Fulfilment {
  const lines = order.lines;
  const goods = lines.filter(isGoods);
  const texts = [squash(order.orderNotes), squash(order.deliveryInstructions)].filter(Boolean);
  const address = squash(order.shippingAddress);
  const comments = lines.filter(isComment).map(line => squash(line.description));
  const descriptions = lines.map(line => squash(line.description));

  // Y1: a CGC truck delivers it.
  const cgcDelivers = order.sourceReports.includes('DELIVERY') ||
    squash(order.deliveryFlag).toUpperCase() === 'SCH' ||
    lines.some(line => classOf(line) === 'DELIVERY_CHARGE' && !DIRECT_DELIVERY.test(squash(line.description)));

  // D1 / D2: the supplier's truck delivers.
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

  if (direct) {
    const vendorLine = lines.find(line => line.poNumber && line.vendorCode);
    const supplier = directSupplier ?? (vendorLine ? vendorName(vendorLine) : null);
    const place = externalPlace(supplier, null, lines);
    if (!place.po && !directSupplier && vendorLine) place.po = vendorLine.poNumber;
    const checks: FulfilmentCheck[] = [];
    if (!lines.some(line => line.poNumber || line.vendorCode)) checks.push('NO_SUPPLIER_PO_YET');
    if (!place.name) checks.push('SUPPLIER_NOT_NAMED');
    if (cgcDelivers) checks.push('ON_CGC_DELIVERY_SCHEDULE');
    if (pickup) checks.push('PICKUP_AND_DIRECT_BOTH_NOTED');
    if (!order.sourceReports.includes('ORDER_SUMMARY')) checks.push('NOT_IN_ORDER_REPORT');
    return { type: 'supplier_direct_ship', places: [place], signal: direct, checks };
  }

  if (pickup && pickupPlace) {
    const checks: FulfilmentCheck[] = [];
    if (!pickupPlace.name) checks.push('SUPPLIER_NOT_NAMED');
    if (cgcDelivers) checks.push('ON_CGC_DELIVERY_SCHEDULE');
    return { type: 'external_pickup', places: [pickupPlace], signal: pickup, checks };
  }

  if (cgcDelivers || !order.isPickup) {
    // H1: the goods are collected first, at a supplier on a PO or at a pit.
    const bought = goods.filter(line => line.vendorCode && line.poNumber);
    if (bought.length > 0) {
      const places: FulfilmentPlace[] = [];
      const seen = new Set<string>();
      for (const line of bought) {
        const name = vendorName(line);
        const location = line.vendorLocation?.trim() || null;
        const key = JSON.stringify([name, location, line.poNumber]);
        if (seen.has(key)) continue;
        seen.add(key);
        const onFile = line.supplierAddress?.trim() || null;
        places.push({
          name,
          location,
          address: onFile && (!location || onFile.toLowerCase().includes(location.toLowerCase())) ? onFile : null,
          po: line.poNumber,
        });
      }
      const checks: FulfilmentCheck[] = bought.some(line => YARD_STOCK.test(squash(line.description)))
        ? ['CHECK_PICKUP_POINT']
        : [];
      return { type: 'supplier_haul_delivery', places, signal: { id: 'H1', text: bought[0]!.vendorCode! }, checks };
    }
    const pit = goods.find(line => PIT.test(squash(line.description)));
    if (pit) {
      return {
        type: 'supplier_haul_delivery',
        places: [{ name: null, location: null, address: null, po: null }],
        signal: { id: 'H1', text: squash(pit.description) },
        checks: ['NO_SUPPLIER_PO', 'SUPPLIER_NOT_NAMED'],
      };
    }
    return { type: 'yard_delivery', places: [], signal: null, checks: [] };
  }

  return { type: 'yard_pickup', places: [], signal: null, checks: [] };
}
