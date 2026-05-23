import { prisma } from "../../db/prisma.js";
const DEFAULT_UNITS = ['ton', 'kg', 'lb', 'load', 'yard', 'meter', 'each', 'tm', 'cy'];
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
    async create(name) {
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
    async remove(id) {
        return prisma.unit.delete({
            where: { id },
        });
    },
};
//# sourceMappingURL=unit.service.js.map