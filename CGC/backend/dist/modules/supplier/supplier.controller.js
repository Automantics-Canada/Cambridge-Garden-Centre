import { SupplierService } from './supplier.service.js';
import { SupplierType } from '@prisma/client';
export const listSuppliers = async (_req, res) => {
    const suppliers = await SupplierService.list();
    res.json(suppliers);
};
export const createSupplier = async (req, res) => {
    const { name, type, emailDomains, contactName, contactEmail, phone, address } = req.body;
    if (!name || !type) {
        return res.status(400).json({ error: 'name and type are required' });
    }
    const supplierType = type === 'TRUCKING_COMPANY'
        ? SupplierType.TRUCKING_COMPANY
        : SupplierType.SUPPLIER;
    const supplier = await SupplierService.create({
        name,
        type: supplierType,
        emailDomains: emailDomains ?? [],
        contactName,
        contactEmail,
        phone,
        address,
    });
    res.status(201).json(supplier);
};
export const updateSupplier = async (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const supplier = await SupplierService.update(id, data);
    res.json(supplier);
};
export const deleteSupplier = async (req, res) => {
    const { id } = req.params;
    const supplier = await SupplierService.remove(id);
    res.json(supplier);
};
//# sourceMappingURL=supplier.controller.js.map