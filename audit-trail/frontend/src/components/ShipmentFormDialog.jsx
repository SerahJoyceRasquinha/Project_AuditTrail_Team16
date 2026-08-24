import { useMemo, useState } from 'react';
import * as api from '../services/apiClient.js';
import { useCommand } from '../hooks/useShipmentData.js';

/**
 * The create/amend form.
 *
 * One component serves both because the fields are the same fields — a
 * shipment's manifest details — and the only thing that differs is which
 * command they end up in. Splitting it into two dialogs would mean two copies
 * of the same validation drifting apart.
 *
 * What differs, and why it matters:
 *
 *  - **Create** sends every field and asserts `expectedVersion: 0` implicitly
 *    at the service ("I believe this stream does not exist"). The shipment ID
 *    is editable, because it *is* the aggregate id.
 *  - **Amend** sends only the fields the operator actually changed, and carries
 *    the `expectedVersion` the form was opened against, so a concurrent edit is
 *    rejected rather than silently overwriting. The ID is shown read-only:
 *    changing it would mean moving the stream, not correcting it.
 *
 * Validation here is a courtesy to the operator, not a security boundary. The
 * backend re-validates everything and is the authority; this exists so the
 * common mistakes are caught without a round trip.
 */

const EMPTY = {
  shipmentId: '',
  containerCode: '',
  origin: '',
  destination: '',
  cargoDescription: '',
  carrier: '',
  minTemperatureC: '',
  maxTemperatureC: '',
  reason: '',
};

const SHIPMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function fromShipment(shipment) {
  if (!shipment) return EMPTY;
  return {
    shipmentId: shipment.aggregateId ?? '',
    containerCode: shipment.containerCode ?? '',
    origin: shipment.origin ?? '',
    destination: shipment.destination ?? '',
    cargoDescription: shipment.cargoDescription ?? '',
    carrier: shipment.carrier ?? '',
    minTemperatureC: shipment.minTemperatureC ?? '',
    maxTemperatureC: shipment.maxTemperatureC ?? '',
    reason: '',
  };
}

/** Mirrors the backend's structural rules so the obvious errors never round-trip. */
export function validateShipmentForm(form, { mode }) {
  const issues = {};

  if (mode === 'create') {
    if (!form.shipmentId.trim()) issues.shipmentId = 'A shipment ID is required.';
    else if (!SHIPMENT_ID_PATTERN.test(form.shipmentId.trim())) {
      issues.shipmentId = '3–64 characters: letters, digits, dot, underscore or hyphen.';
    }
    if (!form.containerCode.trim()) issues.containerCode = 'A container code is required.';
    if (!form.origin.trim()) issues.origin = 'An origin is required.';
    if (!form.destination.trim()) issues.destination = 'A destination is required.';
  }

  const min = form.minTemperatureC === '' ? null : Number(form.minTemperatureC);
  const max = form.maxTemperatureC === '' ? null : Number(form.maxTemperatureC);

  if (min !== null && !Number.isFinite(min)) issues.minTemperatureC = 'Must be a number.';
  if (max !== null && !Number.isFinite(max)) issues.maxTemperatureC = 'Must be a number.';

  // The pairing rule is the backend's, restated: a one-sided range cannot
  // classify a breach, so it is refused rather than half-applied.
  if ((min === null) !== (max === null)) {
    issues.minTemperatureC = 'Give both bounds, or neither — a one-sided range cannot classify a breach.';
  }
  if (min !== null && max !== null && Number.isFinite(min) && Number.isFinite(max) && min > max) {
    issues.minTemperatureC = 'The minimum cannot be above the maximum.';
  }

  return issues;
}

/** The subset of fields whose value differs from what the shipment already says. */
export function changedFields(form, shipment) {
  const original = fromShipment(shipment);
  const changes = {};

  for (const field of ['containerCode', 'origin', 'destination', 'cargoDescription', 'carrier']) {
    const value = form[field].trim();
    if (value !== '' && value !== String(original[field] ?? '').trim()) changes[field] = value;
  }

  for (const field of ['minTemperatureC', 'maxTemperatureC']) {
    if (form[field] === '') continue;
    const value = Number(form[field]);
    if (!Number.isFinite(value)) continue;
    if (original[field] === '' || Number(original[field]) !== value) changes[field] = value;
  }

  return changes;
}

export function ShipmentFormDialog({ mode, shipment = null, onClose, onSucceeded, onConflict }) {
  const [form, setForm] = useState(() => (mode === 'amend' ? fromShipment(shipment) : EMPTY));
  const [touched, setTouched] = useState(false);

  const command = useCommand({
    onSuccess: (result) => {
      onSucceeded?.(result, mode);
      onClose?.();
    },
    onConflict: (error) => {
      onConflict?.(error);
      onClose?.();
    },
  });

  const issues = useMemo(() => validateShipmentForm(form, { mode }), [form, mode]);
  const changes = useMemo(
    () => (mode === 'amend' ? changedFields(form, shipment) : {}),
    [mode, form, shipment]
  );

  const hasIssues = Object.keys(issues).length > 0;
  const nothingToChange = mode === 'amend' && Object.keys(changes).length === 0;
  const expectedVersion = shipment?.currentVersion ?? shipment?.version ?? 0;

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const submit = () => {
    setTouched(true);
    if (hasIssues || nothingToChange || command.pending) return;

    if (mode === 'create') {
      const min = form.minTemperatureC === '' ? null : Number(form.minTemperatureC);
      const max = form.maxTemperatureC === '' ? null : Number(form.maxTemperatureC);

      command.execute(() =>
        api.createShipment({
          shipmentId: form.shipmentId.trim(),
          containerCode: form.containerCode.trim(),
          origin: form.origin.trim(),
          destination: form.destination.trim(),
          cargoDescription: form.cargoDescription.trim() || null,
          carrier: form.carrier.trim() || null,
          minTemperatureC: min,
          maxTemperatureC: max,
        })
      );
      return;
    }

    command.execute(() =>
      api.amendShipment({
        shipmentId: shipment.aggregateId,
        ...changes,
        reason: form.reason.trim() || null,
        // The version the form was opened against. If anything else has been
        // appended since, the backend rejects this rather than overwriting it.
        expectedVersion,
      })
    );
  };

  const showIssue = (field) => (touched ? issues[field] : null);
  const creating = mode === 'create';

  return (
    <div className="dialog-backdrop" role="presentation" onClick={command.pending ? undefined : onClose}>
      <div
        className="dialog dialog--form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipment-form-title"
        onClick={(bubble) => bubble.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 className="dialog__title" id="shipment-form-title">
            {creating ? 'Create a shipment' : `Amend ${shipment?.aggregateId}`}
          </h2>
        </div>

        <div className="dialog__body">
          <p className="dialog__lede">
            {creating
              ? 'This appends a CONTAINER_CREATED event — version 1 of a new stream. Nothing is inserted into a table.'
              : 'This appends a SHIPMENT_DETAILS_AMENDED event recording what changed. The original creation event is left exactly as written.'}
          </p>

          <div className="form-grid">
            <label className="field">
              <span className="field__label">Shipment ID {creating ? '*' : ''}</span>
              <input
                className="input mono"
                value={form.shipmentId}
                onChange={set('shipmentId')}
                placeholder="SHP-1005"
                disabled={!creating || command.pending}
                readOnly={!creating}
                spellCheck={false}
                aria-invalid={Boolean(showIssue('shipmentId'))}
              />
              {showIssue('shipmentId') ? <span className="field__error">{issues.shipmentId}</span> : null}
              {!creating ? (
                <span className="field__hint">
                  The stream identity. Correcting it would mean moving the stream, not amending it.
                </span>
              ) : null}
            </label>

            <label className="field">
              <span className="field__label">Container code {creating ? '*' : ''}</span>
              <input
                className="input mono"
                value={form.containerCode}
                onChange={set('containerCode')}
                placeholder="MSKU7845123"
                disabled={command.pending}
                spellCheck={false}
                aria-invalid={Boolean(showIssue('containerCode'))}
              />
              {showIssue('containerCode') ? (
                <span className="field__error">{issues.containerCode}</span>
              ) : null}
            </label>

            <label className="field">
              <span className="field__label">Origin {creating ? '*' : ''}</span>
              <input
                className="input"
                value={form.origin}
                onChange={set('origin')}
                placeholder="Chennai, IN"
                disabled={command.pending}
                aria-invalid={Boolean(showIssue('origin'))}
              />
              {showIssue('origin') ? <span className="field__error">{issues.origin}</span> : null}
            </label>

            <label className="field">
              <span className="field__label">Destination {creating ? '*' : ''}</span>
              <input
                className="input"
                value={form.destination}
                onChange={set('destination')}
                placeholder="Rotterdam, NL"
                disabled={command.pending}
                aria-invalid={Boolean(showIssue('destination'))}
              />
              {showIssue('destination') ? <span className="field__error">{issues.destination}</span> : null}
            </label>

            <label className="field">
              <span className="field__label">Carrier</span>
              <input
                className="input"
                value={form.carrier}
                onChange={set('carrier')}
                placeholder="Maersk Line"
                disabled={command.pending}
              />
            </label>

            <label className="field">
              <span className="field__label">Cargo description</span>
              <input
                className="input"
                value={form.cargoDescription}
                onChange={set('cargoDescription')}
                placeholder="Pharmaceutical cold chain"
                disabled={command.pending}
              />
            </label>

            <label className="field">
              <span className="field__label">Agreed minimum °C</span>
              <input
                className="input mono"
                type="number"
                step="0.1"
                value={form.minTemperatureC}
                onChange={set('minTemperatureC')}
                placeholder="2"
                disabled={command.pending}
                aria-invalid={Boolean(showIssue('minTemperatureC'))}
              />
              {showIssue('minTemperatureC') ? (
                <span className="field__error">{issues.minTemperatureC}</span>
              ) : null}
            </label>

            <label className="field">
              <span className="field__label">Agreed maximum °C</span>
              <input
                className="input mono"
                type="number"
                step="0.1"
                value={form.maxTemperatureC}
                onChange={set('maxTemperatureC')}
                placeholder="8"
                disabled={command.pending}
                aria-invalid={Boolean(showIssue('maxTemperatureC'))}
              />
              {showIssue('maxTemperatureC') ? (
                <span className="field__error">{issues.maxTemperatureC}</span>
              ) : null}
            </label>

            {!creating ? (
              <label className="field field--wide">
                <span className="field__label">Reason for the amendment</span>
                <input
                  className="input"
                  value={form.reason}
                  onChange={set('reason')}
                  placeholder="Consignee redirected the container"
                  disabled={command.pending}
                />
                <span className="field__hint">
                  Optional, but recorded in the event — an amendment with a stated reason is worth far more
                  in a dispute than one without.
                </span>
              </label>
            ) : null}
          </div>

          {/* An amendment that changes nothing is refused by the backend, so the
              form says so up front rather than letting it round-trip to a 409. */}
          {!creating && nothingToChange ? (
            <p className="form-hint" role="status">
              Nothing has been changed yet. Edit a field to append an amendment.
            </p>
          ) : null}

          {!creating && !nothingToChange ? (
            <p className="form-hint" role="status">
              Will append: {Object.keys(changes).join(', ')} · expectedVersion {expectedVersion}
            </p>
          ) : null}

          {command.error && !command.error.isConflict ? (
            <div className="form-error" role="alert">
              {command.error.message}
              {command.error.details?.issues ? (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {command.error.details.issues.map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={command.pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={command.pending || (touched && hasIssues) || nothingToChange}
          >
            {command.pending
              ? creating
                ? 'Creating…'
                : 'Appending…'
              : creating
                ? 'Create shipment'
                : 'Append amendment'}
          </button>
        </div>
      </div>
    </div>
  );
}
