/**
 * Typed error hierarchy.
 *
 * Every error that leaves the application layer carries an HTTP status and a
 * stable machine-readable `code`, so the HTTP layer never has to guess and the
 * frontend never has to string-match on messages.
 *
 * Roadmap 16 "Safe errors": no MongoDB stack traces, credentials or internal
 * paths are ever attached to these objects. `details` is always a
 * developer-authored, client-safe object.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** 400 - the request/command failed structural or domain validation. */
export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 404 - the aggregate has no event stream. */
export class AggregateNotFoundError extends AppError {
  constructor(aggregateId) {
    super(`No event stream exists for shipment '${aggregateId}'.`, {
      status: 404,
      code: 'AGGREGATE_NOT_FOUND',
      details: { aggregateId },
    });
  }
}

/**
 * 409 - Optimistic Concurrency Control rejection (Week 4).
 *
 * The command was NOT applied. The response deliberately exposes both the
 * version the client believed it was acting on and the version actually stored,
 * so the UI can tell the user exactly what to reload.
 */
export class ConcurrencyConflictError extends AppError {
  constructor({ aggregateId, expectedVersion, currentVersion }) {
    super(
      `Concurrency conflict on shipment '${aggregateId}': command was built against version ${expectedVersion} but the stored version is ${currentVersion}. The command was not applied.`,
      {
        status: 409,
        code: 'CONCURRENCY_CONFLICT',
        details: {
          aggregateId,
          expectedVersion,
          currentVersion,
          applied: false,
          remediation: 'Reload the shipment and resubmit the command against the current version.',
        },
      }
    );
  }
}

/** 409 - the command is structurally valid but illegal for the current state. */
export class DomainRuleViolationError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 409, code: 'DOMAIN_RULE_VIOLATION', details });
  }
}

/**
 * 500 - an attempt was made to mutate the Event Store.
 *
 * This is thrown by the append-only guard, not by MongoDB. It exists so that a
 * programming mistake (someone adding an update path to the repository) fails
 * loudly in tests instead of silently corrupting history.
 */
export class ImmutabilityViolationError extends AppError {
  constructor(operation) {
    super(
      `Operation '${operation}' is forbidden: the Event Store is append-only and events are immutable.`,
      { status: 403, code: 'IMMUTABILITY_VIOLATION', details: { operation } }
    );
  }
}

/** 503 - infrastructure is temporarily unavailable (database down, etc.). */
export class InfrastructureError extends AppError {
  constructor(message = 'A downstream dependency is unavailable.') {
    super(message, { status: 503, code: 'INFRASTRUCTURE_UNAVAILABLE' });
  }
}
