import { prisma } from "../../db/prisma.js";
import { RATE_UNITS } from "../supplier/rateRules.js";

/**
 * Units offered by default: exactly the ones the invoice check can compare.
 *
 * The old list offered `tm`, `yard` and `meter`, which the check does not
 * recognise, so a rate entered in them could never be compared with anything;
 * and a bare `ton`, which could mean a metric tonne or a short ton. A price
 * entered against the wrong one of those is off by ten percent. Custom units
 * can still be added, for products; rates accept only these.
 */
const DEFAULT_UNITS = [...RATE_UNITS];

export const UnitService = {
  async list() {
    const customUnits = await prisma.unit.findMany({
      orderBy: { name: "asc" },
    });

    const customNames = customUnits.map(u => u.name.toLowerCase());
    
    // Merge and deduplicate
    const allNamesSet = new Set([
      ...DEFAULT_UNITS,
      ...customNames
    ]);
    
    const allUnits = Array.from(allNamesSet).sort();

    return {
      defaultUnits: DEFAULT_UNITS,
      customUnits,
      allUnits,
    };
  },

  async create(name: string) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      throw new Error("Unit name cannot be empty");
    }

    if (DEFAULT_UNITS.includes(normalized)) {
      throw new Error("Unit is a default standard unit");
    }

    return prisma.unit.create({
      data: {
        name: normalized,
      },
    });
  },

  async remove(id: string) {
    return prisma.unit.delete({
      where: { id },
    });
  },
};
