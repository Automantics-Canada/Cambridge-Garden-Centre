import jwt from 'jsonwebtoken';
const token = jwt.sign({ id: '7ee75e15-6ff9-4b54-b76c-af5f444702a1', email: 'jim@gmail.com', role: 'ADMIN' }, 'super-secret-change-me', { expiresIn: '7d' });
console.log("TOKEN:", token);
//# sourceMappingURL=generate-token.js.map