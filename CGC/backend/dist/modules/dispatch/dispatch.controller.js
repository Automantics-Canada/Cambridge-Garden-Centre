import { DispatchService } from './dispatch.service.js';
import { NotificationService } from '../../services/notification.service.js';
export const getDispatchBoard = async (req, res) => {
    try {
        const board = await DispatchService.getDispatchBoard();
        res.json(board);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
};
export const assignDriver = async (req, res) => {
    try {
        const { orderId, driverId, priority } = req.body;
        if (!orderId || !driverId) {
            return res.status(400).json({ error: 'orderId and driverId are required' });
        }
        const delivery = await DispatchService.assignDriver(orderId, driverId, priority);
        res.json(delivery);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
};
export const unassignDriver = async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }
        const result = await DispatchService.unassignDriver(orderId);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
};
export const reorderDeliveries = async (req, res) => {
    try {
        const { driverId, deliveryIds } = req.body;
        if (!driverId || !Array.isArray(deliveryIds)) {
            return res.status(400).json({ error: 'driverId and deliveryIds (array) are required' });
        }
        const result = await DispatchService.reorderDeliveries(driverId, deliveryIds);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
};
export const resendEmail = async (req, res) => {
    try {
        const deliveryId = req.params.deliveryId;
        const result = await DispatchService.resendAssignmentEmail(deliveryId);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
};
//# sourceMappingURL=dispatch.controller.js.map