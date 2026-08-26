import { AppError } from '../../shared/errors/AppError.js';

const DEMO_USERS = Object.freeze([
  { username: 'admin', password: 'admin123', displayName: 'System Admin', role: 'admin' },
  { username: 'operator', password: 'operator123', displayName: 'Shipment Operator', role: 'operator' },
  { username: 'auditor', password: 'auditor123', displayName: 'Compliance Auditor', role: 'auditor' },
]);

export class AuthService {
  #tokens = new Map();

  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
  }

  login(username, password) {
    const user = DEMO_USERS.find((candidate) => candidate.username === username && candidate.password === password);
    if (!user) throw new AppError('Invalid username or password.', { status: 401, code: 'INVALID_CREDENTIALS' });

    const token = Buffer.from(`${user.username}:${user.role}:${Date.now()}`).toString('base64url');
    const identity = { username: user.username, displayName: user.displayName, role: user.role };
    this.#tokens.set(token, identity);
    return { token, user: identity };
  }

  verifyToken(token) {
    return this.#tokens.get(token) ?? null;
  }

  get users() {
    return DEMO_USERS.map(({ password, ...user }) => user);
  }
}