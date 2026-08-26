import { useMemo, useState } from 'react';
import * as api from '../services/apiClient.js';
import { useCommand } from '../hooks/useShipmentData.js';
import { LocationFields } from './LocationFields.jsx';

/**
 * Create / amend a shipment.
 *
 * One component serves both because the fields are the same fields. What
 * differs is which command they end up in, and four things changed here from
 * the earlier version - each because the old behaviour was a small lie about
 * the ledger:
 *
 *  - **The shipment reference is no longer typed.** It is allocated by the
 *    server (SHP-1, SHP-2, …) from an atomic counter when the creation command
 *    is accepted, so two people creating shipments at the same moment cannot
 *    collide. The field is shown, disabled, explaining that.
 *  - **Origin and destination are structured.** Country then dependent state,
 *    from the catalogue the backend validates against.
 *  - **The container code upper-cases as you type,** so what you see is what
 *    will be stored - and the backend normalises it again regardless.
 *  - **An estimated duration is required,** because it fixes the planning
 *    window every later date is checked against.
 *
 * Validation here is a courtesy, not a boundary. The backend re-validates all
 * of it and is the authority; this exists so the obvious mistakes never cost a
 * round trip.
 */

// `cityIsCustom` is UI state only - it decides whether the manual input is
// shown. It is never sent to the backend, which stores the city string itself.
const EMPTY_LOCATION = { city: '', countryCode: '', stateCode: '', cityIsCustom: false };

const EMPTY = {
  containerCode: '',
  origin: { ...EMPTY_LOCATION },
  destination: { ...EMPTY_LOCATION },
  estimatedDurationDays: '',
  cargoDescription: '',
  carrier: '',
  minTemperatureC: '',
  maxTemperatureC: '',
  reason: '',
};

/** Container codes are stored upper-cased; the field reflects that immediately. */
export const normaliseContainerCode = (value) =>
  String(value ?? '').replace(/\s+/g, '').toUpperCase();

function locationFromShipment(location, fallbackText) {
  if (location) {
    return {
      city: location.city ?? '',
      countryCode: location.countryCode ?? '',
      stateCode: location.stateCode ?? '',
      // A city that is not in the curated list keeps the manual input open
      // rather than vanishing from a dropdown with no matching option.
      cityIsCustom: location.cityFromCatalogue === false && Boolean(location.city),
    };
  }
  // A shipment created before structured addresses existed. Its text is shown
  // as the city so nothing is lost; the operator picks a country to upgrade it.
  return { city: fallbackText ?? '', countryCode: '', stateCode: '', cityIsCustom: true };
}

function fromShipment(shipment) {
  if (!shipment) return EMPTY;
  return {
    containerCode: shipment.containerCode ?? '',
    origin: locationFromShipment(shipment.originLocation, shipment.origin),
    destination: locationFromShipment(shipment.destinationLocation, shipment.destination),
    estimatedDurationDays: shipment.estimatedDurationDays ?? '',
    cargoDescription: shipment.cargoDescription ?? '',
    carrier: shipment.carrier ?? '',
    minTemperatureC: shipment.minTemperatureC ?? '',
    maxTemperatureC: shipment.maxTemperatureC ?? '',
    reason: '',
  };
}

/**
 * Duration rules, mirroring `validateWholeDays` on the backend.
 *
 * Rejects zero, negatives, decimals and text. A decimal is refused rather than
 * rounded: quietly turning 2.5 into 3 would give the shipment a completion date
 * nobody chose.
 */
export function validateDurationDays(value, { field = 'estimatedDurationDays' } = {}) {
  if (value === '' || value === null || value === undefined) {
    return 'An estimated duration is required.';
  }
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return 'Enter the number of days as a whole number.';
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return 'Enter the number of days as a whole number.';
  if (!Number.isInteger(numeric)) return 'Whole days only — fractions of a day are not accepted.';
  if (numeric < 1) return 'The duration must be at least 1 day.';
  if (numeric > 3650) return 'The duration must be at most 3650 days.';
  return null;
}

/** Mirrors the backend's structural rules so obvious errors never round-trip. */
export function validateShipmentForm(form, { mode }) {
  const issues = {};

  if (mode === 'create') {
    if (!form.containerCode.trim()) issues.containerCode = 'A container code is required.';

    for (const side of ['origin', 'destination']) {
      const location = form[side];
      const sideIssues = {};
      if (!location.city.trim()) {
        sideIssues.city = location.cityIsCustom
          ? 'Enter the city or port name.'
          : 'Select a city or port.';
      }
      if (!location.countryCode) sideIssues.countryCode = 'Select a country.';
      // The state rule is only checked once a country exists - otherwise the
      // form would report two problems for one missing answer.
      if (location.countryCode && location.requiresState && !location.stateCode) {
        sideIssues.stateCode = 'Select a state or region.';
      }
      if (Object.keys(sideIssues).length > 0) issues[side] = sideIssues;
    }

    const duration = validateDurationDays(form.estimatedDurationDays);
    if (duration) issues.estimatedDurationDays = duration;
  }

  const min = form.minTemperatureC === '' ? null : Number(form.minTemperatureC);
  const max = form.maxTemperatureC === '' ? null : Number(form.maxTemperatureC);

  if (min !== null && !Number.isFinite(min)) issues.minTemperatureC = 'Must be a number.';
  if (max !== null && !Number.isFinite(max)) issues.maxTemperatureC = 'Must be a number.';

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

  const code = normaliseContainerCode(form.containerCode);
  if (code !== '' && code !== normaliseContainerCode(original.containerCode)) {
    changes.containerCode = code;
  }

  for (const field of ['cargoDescription', 'carrier']) {
    const value = form[field].trim();
    if (value !== '' && value !== String(original[field] ?? '').trim()) changes[field] = value;
  }

  for (const side of ['origin', 'destination']) {
    const current = form[side];
    const before = original[side];
    if (!current.countryCode || !current.city.trim()) continue;
    if (
      current.city.trim() !== String(before.city ?? '').trim() ||
      current.countryCode !== before.countryCode ||
      current.stateCode !== before.stateCode
    ) {
      changes[`${side}Location`] = {
        city: current.city.trim(),
        countryCode: current.countryCode,
        stateCode: current.stateCode,
      };
    }
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
  const creating = mode === 'create';

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const setContainerCode = (event) =>
    // Normalised as the operator types, so the field shows what will be stored.
    setForm((current) => ({ ...current, containerCode: normaliseContainerCode(event.target.value) }));

  const submit = () => {
    setTouched(true);
    if (hasIssues || nothingToChange || command.pending) return;

    const min = form.minTemperatureC === '' ? null : Number(form.minTemperatureC);
    const max = form.maxTemperatureC === '' ? null : Number(form.maxTemperatureC);

    if (creating) {
      command.execute(() =>
        api.createShipment({
          // No shipmentId: the server allocates the next SHP-N atomically.
          containerCode: normaliseContainerCode(form.containerCode),
          originLocation: {
            city: form.origin.city.trim(),
            countryCode: form.origin.countryCode,
            stateCode: form.origin.stateCode,
          },
          destinationLocation: {
            city: form.destination.city.trim(),
            countryCode: form.destination.countryCode,
            stateCode: form.destination.stateCode,
          },
          estimatedDurationDays: Number(form.estimatedDurationDays),
          cargoDescription: form.cargoDescription.trim() || null,
          carrier: form.carrier.trim() || null,
          minTemperatureC: min,
          maxTemperatureC: max,
          // Deliberately no creation timestamp: the server stamps the event when
          // it accepts the command, so the time cannot be chosen by a client.
        })
      );
      return;
    }

    command.execute(() =>
      api.amendShipment({
        shipmentId: shipment.aggregateId,
        ...changes,
        reason: form.reason.trim() || null,
        expectedVersion,
      })
    );
  };

  const showIssue = (field) => (touched ? issues[field] : null);

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
            {creating ? 'Create Shipment' : `Edit ${shipment?.aggregateId}`}
          </h2>
        </div>

        <div className="dialog__body">
          <p className="dialog__lede">
            {creating
              ? 'Opens a new shipment record. The reference number and the creation time are both assigned by the system.'
              : 'Records a correction. The original details stay on the record — nothing is overwritten.'}
          </p>

          <h3 className="form-section">Shipment Details</h3>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Shipment reference</span>
              <input
                className="input mono"
                value={creating ? 'Assigned automatically' : (shipment?.aggregateId ?? '')}
                disabled
                readOnly
              />
              <span className="field__hint">
                {creating
                  ? 'The next reference in sequence (SHP-1, SHP-2, …) is assigned when the shipment is created.'
                  : 'The permanent reference for this shipment. It cannot be changed.'}
              </span>
            </label>

            <label className="field">
              <span className="field__label">Container Information {creating ? '*' : ''}</span>
              <input
                className="input mono"
                value={form.containerCode}
                onChange={setContainerCode}
                placeholder="MSKU7845123"
                disabled={command.pending}
                spellCheck={false}
                aria-invalid={Boolean(showIssue('containerCode'))}
              />
              {showIssue('containerCode') ? (
                <span className="field__error">{issues.containerCode}</span>
              ) : (
                <span className="field__hint">Automatically stored in capitals.</span>
              )}
            </label>
          </div>

          <h3 className="form-section">Origin</h3>
          <LocationFields
            legend="Where the shipment starts"
            idPrefix="origin"
            value={form.origin}
            onChange={(origin) => setForm((current) => ({ ...current, origin }))}
            disabled={command.pending}
            issues={touched ? (issues.origin ?? {}) : {}}
          />

          <h3 className="form-section">Destination</h3>
          <LocationFields
            legend="Where the shipment is going"
            idPrefix="destination"
            value={form.destination}
            onChange={(destination) => setForm((current) => ({ ...current, destination }))}
            disabled={command.pending}
            issues={touched ? (issues.destination ?? {}) : {}}
          />

          <h3 className="form-section">Estimated Shipment Duration</h3>
          <div className="form-grid">
            {creating ? (
              <label className="field">
                <span className="field__label">Total days to completion *</span>
                <input
                  className="input mono"
                  type="number"
                  min="1"
                  step="1"
                  value={form.estimatedDurationDays}
                  onChange={set('estimatedDurationDays')}
                  placeholder="21"
                  disabled={command.pending}
                  aria-invalid={Boolean(showIssue('estimatedDurationDays'))}
                />
                {showIssue('estimatedDurationDays') ? (
                  <span className="field__error">{issues.estimatedDurationDays}</span>
                ) : (
                  <span className="field__hint">
                    Whole days only. This sets the window every planned date must fall inside.
                  </span>
                )}
              </label>
            ) : (
              <label className="field">
                <span className="field__label">Estimated duration</span>
                <input className="input mono" value={`${form.estimatedDurationDays} days`} disabled readOnly />
                <span className="field__hint">
                  Changed by recording a delay on the schedule, so the reason is kept — not by editing it here.
                </span>
              </label>
            )}

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

            <label className="field field--wide">
              <span className="field__label">Cargo description</span>
              <input
                className="input"
                value={form.cargoDescription}
                onChange={set('cargoDescription')}
                placeholder="Pharmaceutical cold chain"
                disabled={command.pending}
              />
            </label>
          </div>

          <h3 className="form-section">Temperature Monitoring</h3>
          <p className="form-hint">
            The acceptable range for this cargo. Readings are collected automatically — any reading
            outside this range raises an alert on the shipment's timeline.
          </p>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Acceptable minimum °C</span>
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
              <span className="field__label">Acceptable maximum °C</span>
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
          </div>

          {!creating ? (
            <label className="field field--wide">
              <span className="field__label">Reason for the correction</span>
              <input
                className="input"
                value={form.reason}
                onChange={set('reason')}
                placeholder="Consignee redirected the container"
                disabled={command.pending}
              />
              <span className="field__hint">
                Optional, but kept on the record — a correction with a stated reason is worth far more in
                a dispute than one without.
              </span>
            </label>
          ) : null}

          {!creating && nothingToChange ? (
            <p className="form-hint" role="status">
              Nothing has been changed yet. Edit a field to record a correction.
            </p>
          ) : null}

          {!creating && !nothingToChange ? (
            <p className="form-hint" role="status">
              Will record a correction to: {Object.keys(changes).join(', ')}
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
                : 'Saving…'
              : creating
                ? 'Create Shipment'
                : 'Save correction'}
          </button>
        </div>
      </div>
    </div>
  );
}
