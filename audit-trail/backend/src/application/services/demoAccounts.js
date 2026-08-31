import { ROLES } from '../../domain/auth/roles.js';

/**
 * The accounts the sign-in page offers as one-click demo access.
 *
 * There are exactly two, and they are exactly the two roles the domain
 * defines. An earlier version of the login page offered three - Operator,
 * Auditor and Admin - which was a leftover from a branch written before the
 * role model settled on `operator` and `user`. Neither "auditor" nor "admin"
 * is an assignable role, so the backend rejected them at registration and the
 * buttons could only ever fail. This list is derived from ROLES so the same
 * drift cannot happen again: adding a role here that the domain does not
 * define will fail at seed time rather than silently at the login form.
 *
 * The passwords are public by design. That is exactly why seeding is opt-in
 * (AUTH_SEED_DEMO_ACCOUNTS, default false) - a demonstration wants known
 * credentials, and a deployment must never acquire them by accident.
 */
export const DEMO_ACCOUNTS = Object.freeze([
  Object.freeze({
    username: 'operator',
    password: 'operator123',
    displayName: 'Shipment Operator',
    role: ROLES.OPERATOR,
  }),
  Object.freeze({
    username: 'viewer',
    password: 'viewer123',
    displayName: 'Read-only Viewer',
    role: ROLES.USER,
  }),
]);

/**
 * Creates any missing demo account.
 *
 * Idempotent: an account that already exists is left exactly as it is. It is
 * deliberately not "reset to the demo password", because that would let this
 * function overwrite a real account that happened to share a username, and
 * because rewriting a stored credential is not something a startup path should
 * ever do quietly.
 *
 * Every account is created through `AuthService.register`, so it receives the
 * same scrypt hashing, the same validation and the same role checks as an
 * account created through the API. Nothing here writes to the users collection
 * directly, and nothing here can assign a role the domain does not allow.
 */
export async function seedDemoAccounts({ authService, userRepository, logger }) {
  const created = [];
  const skipped = [];

  for (const account of DEMO_ACCOUNTS) {
    if (await userRepository.exists(account.username)) {
      skipped.push(account.username);
      continue;
    }

    try {
      await authService.register({
        username: account.username,
        password: account.password,
        confirmPassword: account.password,
        displayName: account.displayName,
        role: account.role,
      });
      created.push(account.username);
    } catch (error) {
      // A race with another instance starting at the same moment is the
      // expected case here, and it is not a failure: the account now exists,
      // which is all this function was asked to guarantee.
      if (error?.code === 'USERNAME_TAKEN') {
        skipped.push(account.username);
        continue;
      }
      logger?.warn('Could not seed a demo account.', {
        username: account.username,
        reason: error.message,
      });
    }
  }

  if (created.length > 0) {
    logger?.warn(
      'Demo accounts with published passwords were created. Do not enable AUTH_SEED_DEMO_ACCOUNTS in a deployment reachable from a network.',
      { created, skipped }
    );
  }

  return { created, skipped };
}
