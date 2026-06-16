import { prisma } from '../../db/prisma.js';
import { SupplierType } from '@prisma/client';
import { compareTwoStrings } from 'string-similarity';
import path from 'node:path';
import fs from 'node:fs';
export const SupplierService = {
    async findOrCreateSupplier(name) {
        if (!name)
            return null;
        const trimmedName = name.trim();
        if (!trimmedName)
            return null;
        const logPath = path.join(process.cwd(), 'ocr_debug.log');
        fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] Attempting match for: "${trimmedName}"\n`);
        const supplier = await prisma.supplier.findFirst({
            where: {
                name: { equals: trimmedName, mode: 'insensitive' },
            },
        });
        if (supplier) {
            fs.appendFileSync(logPath, `Exact match found: ${supplier.name}\n`);
            return supplier;
        }
        // Try contains
        const containsSupplier = await prisma.supplier.findFirst({
            where: {
                name: { contains: trimmedName, mode: 'insensitive' },
            },
        });
        if (containsSupplier) {
            fs.appendFileSync(logPath, `Contains match found: ${containsSupplier.name}\n`);
            return containsSupplier;
        }
        // Fuzzy match against all active suppliers
        fs.appendFileSync(logPath, `No direct match. Candidates:\n`);
        const allSuppliers = await prisma.supplier.findMany({ where: { active: true } });
        let bestMatch = null;
        let highestSimilarity = 0;
        for (const s of allSuppliers) {
            const similarity = compareTwoStrings(trimmedName.toLowerCase(), s.name.toLowerCase());
            fs.appendFileSync(logPath, ` - Candidate: "${s.name}" | Score: ${similarity.toFixed(4)}\n`);
            if (similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = s;
            }
        }
        if (bestMatch && highestSimilarity > 0.75) {
            fs.appendFileSync(logPath, `WINNER: "${bestMatch.name}" (Score: ${highestSimilarity.toFixed(4)})\n`);
            return bestMatch;
        }
        // If no match found, create a new supplier!
        fs.appendFileSync(logPath, `Creating new supplier: "${trimmedName}"\n`);
        const newSupplier = await prisma.supplier.create({
            data: {
                name: trimmedName,
                type: SupplierType.SUPPLIER,
                emailDomains: [],
                keywords: [],
            },
        });
        return newSupplier;
    },
    async list() {
        return prisma.supplier.findMany({
            where: { active: true },
            orderBy: { name: 'asc' },
            include: {
                negotiatedRates: true
            }
        });
    },
    async create(data) {
        return prisma.supplier.create({ data });
    },
    async update(id, data) {
        return prisma.supplier.update({
            where: { id },
            data,
        });
    },
    async remove(id) {
        return prisma.supplier.update({
            where: { id },
            data: { active: false },
        });
    },
    async addNegotiatedRate(supplierId, data) {
        return prisma.negotiatedRate.create({
            data: {
                ...data,
                supplierId,
            }
        });
    },
    async removeNegotiatedRate(rateId) {
        return prisma.negotiatedRate.delete({
            where: { id: rateId }
        });
    },
    async updateNegotiatedRate(rateId, data) {
        return prisma.negotiatedRate.update({
            where: { id: rateId },
            data: {
                ...data,
                ...(data.effectiveFrom !== undefined && { effectiveFrom: new Date(data.effectiveFrom) }),
                ...(data.effectiveTo !== undefined && { effectiveTo: new Date(data.effectiveTo) }),
            }
        });
    }
};
//# sourceMappingURL=supplier.service.js.map