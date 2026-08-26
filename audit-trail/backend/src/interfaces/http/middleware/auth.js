import { AppError } from '../../../shared/errors/AppError.js';

export function authenticate(authService) {
  return (req, res, next) => {
    if (!authService.enabled) {
      req.user = { username: 'test-user', displayName: 'Test User', role: 'admin' };
      return next();
    }

    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = token ? authService.verifyToken(token) : null;
    if (!user) {
      return next(new AppError('Authentication is required.', { status: 401, code: 'AUTHENTICATION_REQUIRED' }));
    }

    req.user = user;
    return next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('Your role cannot perform this action.', { status: 403, code: 'FORBIDDEN' }));
    }
    return next();
  };
}