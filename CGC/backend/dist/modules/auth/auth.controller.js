import { AuthService } from './auth.service.js';
export const register = async (req, res) => {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'email, password, name required' });
    }
    const result = await AuthService.register(email, password, name, role);
    res.status(201).json({
        id: result.id,
        email: result.email,
        name: result.name,
        role: result.role,
    });
};
export const login = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'email and password required' });
    }
    const data = await AuthService.login(email, password);
    res.json(data);
};
//# sourceMappingURL=auth.controller.js.map