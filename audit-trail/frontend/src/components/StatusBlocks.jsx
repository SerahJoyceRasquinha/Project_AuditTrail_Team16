/**
 * Loading, empty and error blocks.
 *
 * The roadmap asks for all three states on every panel; having one
 * implementation of each is what keeps them consistent instead of three
 * near-identical spinners that behave slightly differently.
 *
 * Error copy follows one rule: say what happened and what to do about it. No
 * apologies, no "oops".
 */
export function LoadingBlock({ label = 'Loading', lines = 3 }) {
  return (
    <div className="panel__body" role="status" aria-live="polite" aria-busy="true">
      <p className="eyebrow" style={{ marginTop: 0 }}>
        {label}
      </p>
      {Array.from({ length: lines }, (unused, index) => (
        <div key={index} className="skeleton" style={{ width: `${100 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyBlock({ title = 'Nothing here yet', message, action = null }) {
  return (
    <div className="state-block">
      <div className="state-block__title">{title}</div>
      {message ? <p style={{ margin: '0 0 12px' }}>{message}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }) {
  const isNetwork = error?.code === 'NETWORK_ERROR';

  return (
    <div className="state-block state-block--error" role="alert">
      <div className="state-block__title">
        {isNetwork ? 'Cannot reach the API' : 'Request failed'}
      </div>
      <p style={{ margin: '0 0 12px' }}>{error?.message ?? 'An unexpected error occurred.'}</p>
      {error?.correlationId ? (
        <p className="mono" style={{ fontSize: 11, margin: '0 0 12px' }}>
          Correlation ID {error.correlationId}
        </p>
      ) : null}
      {onRetry ? (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
