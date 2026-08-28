import { AppError } from '../../../shared/errors/AppError.js';
import { ROLES, ROLE_LABELS } from '../../../domain/auth/roles.js';

/**
 * Authentication middleware.
 *
 * Establishes *who* the caller is and attaches the identity to `req.user`. It
 * never decides what they may do - that is `requireRole`'s job, and keeping the
 * two separate is what lets the query side require only a valid session while
 * the command side additionally requires a role.
 *
 * The identity attached here comes from `AuthService.verifyToken`, which reads
 * the role from the stored account record. Nothing the client sends - not a
 * header, not a body field, not a query parameter - contributes to it.
 */
export function authenticate(authService) {
  return async (req, res, next) => {
    /**
     * The test/dev bypass.
     *
     * When auth is disabled the request is treated as an operator, because the
     * existing suite drives the full command surface and disabling auth must
     * not silently disable the ability to write. It is deliberately *not*
     * granted anything beyond operator: there is no higher role to grant, so
     * this bypass cannot become a privilege-escalation path that only exists
     * in one configuration.
     */
    if (!authService.enabled) {
      req.user = { username: 'test-user', displayName: 'Test User', role: ROLES.OPERATOR };
      return next();
    }

    try {
      /**
       * Two transports, one meaning.
       *
       * The Authorization header is the normal path. The query parameter
       * exists solely for the SSE endpoint: the browser's EventSource cannot
       * set request headers, so a stream connection has no other way to
       * present its token. It is accepted only as a fallback, and the token it
       * carries is verified by exactly the same code as any other.
       */
      const header = req.get('authorization') ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
      const token = bearer || (typeof req.query?.token === 'string' ? req.query.token : null);

      const user = token ? await authService.verifyToken(token) : null;

      if (!user) {
        return next(
          new AppError('Authentication is required. Sign in and try again.', {
            status: 401,
            code: 'AUTHENTICATION_REQUIRED',
          })
        );
      }

      req.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Authorization middleware.
 *
 * Mounted on the command router *before* any command route, so a rejected
 * caller is turned away before the request reaches a controller, a handler, the
 * command service, the aggregate, or the Event Store. Nothing is validated,
 * nothing is folded, and above all no event is appended on behalf of a caller
 * who was never allowed to ask.
 *
 * 403, not 401: the caller is authenticated and we know who they are. The
 * request failed because of what their account may do, which is a different
 * problem from not being signed in and deserves a different status.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(
        new AppError('Authentication is required. Sign in and try again.', {
          status: 401,
          code: 'AUTHENTICATION_REQUIRED',
        })
      );
    }

    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          `This action requires the ${roles.map((role) => ROLE_LABELS[role] ?? role).join(' or ')} role. Your account is signed in as ${ROLE_LABELS[req.user.role] ?? req.user.role}, which has read-only access.`,
          {
            status: 403,
            code: 'FORBIDDEN',
            details: { requiredRoles: roles, actualRole: req.user.role },
          }
        )
      );
    }

    return next();
  };
}
