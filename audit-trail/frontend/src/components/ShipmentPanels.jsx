import { formatTemperature, formatTimestamp, stateLabel, truncateHash } from '../utils/format.js';

/**
 * The shipment header.
 *
 * `mode` is passed explicitly rather than inferred, because this component is
 * the main place where showing a historical state as though it were current
 * would mislead an investigator (roadmap "Mistake 10").
 */
export function ShipmentSummary({ shipment, mode = 'LIVE', at = null }) {
  if (!shipment) return null;
  const historical = mode === 'HISTORICAL';

  return (
    <div className="panel__body">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="summary__id">{shipment.aggregateId}</h1>
        <span className={`pill ${historical ? 'pill--violet' : 'pill--teal'}`}>
          <span className="pill__dot" />
          {historical ? 'Historical state' : 'Current state'}
        </span>
        {shipment.temperatureExcursion ? (
          <span className="pill pill--amber">
            <span className="pill__dot" />
            {shipment.temperatureBreachCount} breach
            {shipment.temperatureBreachCount === 1 ? '' : 'es'}
          </span>
        ) : null}
      </div>

      <p className="summary__route">
        {shipment.containerCode ? <span className="mono">{shipment.containerCode}</span> : null}
        {shipment.containerCode ? ' · ' : ''}
        {shipment.origin} → {shipment.destination}
        {shipment.cargoDescription ? ` · ${shipment.cargoDescription}` : ''}
      </p>

      {historical ? (
        <p className="eyebrow" style={{ color: 'var(--signal-violet)' }}>
          As reconstructed at {formatTimestamp(at)}
        </p>
      ) : null}

      <div className="facts">
        <Fact label="Status" value={stateLabel(shipment.currentState)} />
        <Fact label="Location" value={shipment.currentLocation ?? '—'} />
        <Fact label="Version" value={`v${shipment.currentVersion ?? shipment.version ?? 0}`} mono />
        <Fact label="Vessel" value={shipment.vesselName ?? '—'} />
        <Fact
          label="Latest temperature"
          value={formatTemperature(shipment.latestTemperatureC)}
          tone={shipment.temperatureExcursion ? 'amber' : undefined}
        />
        <Fact
          label="Agreed range"
          value={
            shipment.minTemperatureC === null || shipment.minTemperatureC === undefined
              ? 'Not declared'
              : `${formatTemperature(shipment.minTemperatureC)} to ${formatTemperature(shipment.maxTemperatureC)}`
          }
        />
        <Fact label="Readings" value={String(shipment.temperatureReadingCount ?? 0)} mono />
        <Fact label="Last event" value={formatTimestamp(shipment.lastEventAt, { seconds: false })} />
      </div>
    </div>
  );
}

function Fact({ label, value, mono, tone }) {
  return (
    <div>
      <div className="fact__label">{label}</div>
      <div className={`fact__value ${tone === 'amber' ? 'fact__value--amber' : ''} ${mono ? 'mono' : ''}`}>
        {value}
      </div>
    </div>
  );
}

/**
 * Hash-chain status.
 *
 * The wording is deliberately careful. It claims tamper *evidence*, not
 * tamper-proofing, because that is what a hash chain without external anchoring
 * actually provides — and overclaiming in an audit tool is worse than not
 * having the feature.
 */
export function IntegrityBadge({ integrity, isLoading }) {
  if (isLoading) {
    return (
      <div className="panel__body">
        <div className="skeleton" style={{ width: '60%' }} />
      </div>
    );
  }
  if (!integrity) return null;

  return (
    <div className="panel__body">
      <div className="integrity">
        <span className={`pill ${integrity.intact ? 'pill--teal' : 'pill--red'}`}>
          <span className="pill__dot" />
          {integrity.intact ? 'Chain verified' : 'Chain broken'}
        </span>
        <span className="integrity__hash">
          {integrity.eventCount} events · head {truncateHash(integrity.headHash)}
        </span>
      </div>

      <p style={{ color: 'var(--paper-mute)', fontSize: 13, margin: '10px 0 0' }}>
        {integrity.intact
          ? 'Every event hashes to its stored value and links to its predecessor. Any edit or deletion in this stream would show up here.'
          : 'This stream no longer hashes to its stored values. The events below have been altered or removed since they were written.'}
      </p>

      {!integrity.intact ? (
        <ul className="integrity__issues">
          {integrity.issues.map((issue, index) => (
            <li key={index}>
              {issue.type} at version {issue.version ?? issue.actualVersion ?? '?'} — {issue.message ?? ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ReconciliationPanel({ reconciliation, isLoading, isError, onRetry }) {
  if (isLoading && !reconciliation) {
    return (
      <div className="panel__body">
        <div className="skeleton" style={{ width: '60%' }} />
      </div>
    );
  }

  if (isError && !reconciliation) {
    return <ErrorPanel message="Reconciliation unavailable." onRetry={onRetry} />;
  }

  if (!reconciliation) return null;
  const discrepancies = reconciliation.discrepancies ?? [];

  return (
    <div className="panel__body">
      <div className="integrity">
        <span className={`pill ${reconciliation.consistent ? 'pill--teal' : 'pill--red'}`}>
          <span className="pill__dot" />
          {reconciliation.consistent ? 'Read model verified' : 'Read model drift detected'}
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry} disabled={isLoading}>
          {isLoading ? 'Checking…' : 'Recheck'}
        </button>
      </div>

      <div className="reconciliation__versions">
        <span>History v{reconciliation.expectedVersion ?? '—'}</span>
        <span>Projection v{reconciliation.actualVersion ?? '—'}</span>
        {reconciliation.lagVersions > 0 ? <span>{reconciliation.lagVersions} behind</span> : null}
      </div>

      {reconciliation.consistent ? (
        <p className="reconciliation__message">The projection matches a fresh replay of the event history.</p>
      ) : (
        <ul className="integrity__issues">
          {discrepancies.map((issue, index) => (
            <li key={`${issue.field}-${index}`}>
              <span className="mono">{issue.field}</span>: {issue.message ?? 'value differs from history'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ErrorPanel({ message, onRetry }) {
  return (
    <div className="panel__body state-block state-block--error" role="alert">
      <div className="state-block__title">{message}</div>
      <button type="button" className="btn btn--sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * The eventual-consistency banner (roadmap 12.6).
 *
 * When the read model is behind, the dashboard says so plainly and says where
 * the data on screen came from instead. It never claims the command failed.
 */
export function ConsistencyBanner({ consistency }) {
  if (!consistency || consistency.projected) return null;

  return (
    <div className="banner banner--sync" role="status">
      <span className="pill pill--amber">
        <span className="pill__dot" />
        Synchronising
      </span>
      <span>
        The projection is {consistency.lagVersions} version
        {consistency.lagVersions === 1 ? '' : 's'} behind. This view was rebuilt directly from the event
        history, which is the authoritative record.
      </span>
    </div>
  );
}

/**
 * Confirmation for the archive/restore actions.
 *
 * Archiving *looks* destructive, so it is confirmed — but the copy is careful
 * not to imply that anything is being destroyed, because nothing is. Telling an
 * operator "this cannot be undone" here would be a plain lie: the whole point
 * is that it can, and that the history survives either way.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  pending = false,
  error = null,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onClick={pending ? undefined : onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(bubble) => bubble.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="dialog__title" id="confirm-title">
            {title}
          </h2>
        </div>

        <div className="dialog__body">
          <p style={{ marginTop: 0 }}>{body}</p>

          {onReasonChange ? (
            <label className="field">
              <span className="field__label">Reason</span>
              <input
                className="input"
                value={reason}
                onChange={(bubble) => onReasonChange(bubble.target.value)}
                placeholder="Claim settled and container released"
                disabled={pending}
              />
              <span className="field__hint">Optional, and recorded in the event.</span>
            </label>
          ) : null}

          {error ? (
            <div className="form-error" role="alert">
              {error.message}
            </div>
          ) : null}
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The OCC conflict dialog (roadmap 13.3).
 *
 * It states both versions, states that nothing was written, and offers the one
 * action that resolves it. A conflict is not an error the user caused; it is
 * the system protecting a concurrent edit, and the copy reflects that.
 */
export function ConflictDialog({ conflict, onReload, onDismiss }) {
  if (!conflict) return null;
  const details = conflict.details ?? {};

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        onClick={(bubble) => bubble.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="dialog__title" id="conflict-title">
            Someone else updated this shipment first
          </h2>
        </div>

        <div className="dialog__body">
          <p style={{ marginTop: 0 }}>
            Your command was built against a version that is no longer current, so it was rejected. Nothing
            was written to the ledger.
          </p>

          <div className="dialog__versions">
            <div>
              <div className="fact__label">You had</div>
              <div className="dialog__version-value">v{details.expectedVersion}</div>
            </div>
            <div>
              <div className="fact__label">Stored now</div>
              <div className="dialog__version-value">v{details.currentVersion}</div>
            </div>
          </div>

          <p style={{ marginBottom: 0 }}>
            Reload the shipment to see what changed, then send your command again.
          </p>
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onDismiss}>
            Dismiss
          </button>
          <button type="button" className="btn btn--primary" onClick={onReload}>
            Reload shipment
          </button>
        </div>
      </div>
    </div>
  );
}
