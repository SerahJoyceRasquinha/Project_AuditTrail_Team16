/**
 * The application's role model.
 *
 * Two roles, and deliberately only two:
 *
 *  - OPERATOR may issue shipment commands. Every one of those commands still
 *    travels the ordinary Event Sourcing path - load the stream, fold it, check
 *    the expected version, let the aggregate decide, append one event. A role
 *    buys permission to *ask*; it never buys a shortcut into the ledger.
 *  - USER is strictly read-only. It may run every query the dashboard offers -
 *    the timeline, the reconstruction, the scrubber, sensors, integrity,
 *    exports - and no command at all.
 *
 * There is no administrator. The source document describes a logistics manager
 * reading a forensic dashboard, not a user-administration system, and inventing
 * a superuser role would mean inventing an escalation path the requirement
 * never asked for.
 *
 * A role is chosen once, at registration, and stored on the account. It is read
 * back from that stored record on every single request (see AuthService.
 * verifyToken), never from the token body and never from anything the client
 * sends. That is what makes the role effectively immutable from the outside:
 * there is no request shape that can change it, because no code path writes it
 * after the account row is created.
 */
export const ROLES = Object.freeze({
  OPERATOR: 'operator',
  USER: 'user',
});

/** The roles a self-service registration may choose between. */
export const ASSIGNABLE_ROLES = Object.freeze([ROLES.OPERATOR, ROLES.USER]);

export function isAssignableRole(value) {
  return ASSIGNABLE_ROLES.includes(value);
}

/** Roles permitted to issue shipment commands. Queries are open to any account. */
export const COMMAND_ROLES = Object.freeze([ROLES.OPERATOR]);

/** Human-readable labels, used in UI copy and audit messages. */
export const ROLE_LABELS = Object.freeze({
  [ROLES.OPERATOR]: 'Operator',
  [ROLES.USER]: 'User',
});
