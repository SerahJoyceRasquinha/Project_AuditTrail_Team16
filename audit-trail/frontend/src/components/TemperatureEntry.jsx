import { useState } from 'react';
import * as api from '../services/apiClient.js';
import { useCommand } from '../hooks/useShipmentData.js';
import { formatTemperature } from '../utils/format.js';

/**
 * Manual temperature entry.
 *
 * The automatic monitor samples on a schedule, but a reading taken by hand -
 * from a probe at the quayside, or a figure read off a reefer unit during an
 * inspection - has no other way into the ledger. Without this panel the command
 * existed on the server and was unreachable from the application.
 *
 * Two things are deliberately *not* done here:
 *
 *  - The panel does not decide whether a reading is a breach. It sends the
 *    number; the aggregate compares it against the range recorded when the
 *    container was created and emits TEMPERATURE_RECORDED or TEMPERATURE_SPIKE.
 *    Classifying client-side would mean two implementations of one rule, and
 *    the one that ends up in the immutable payload would be the wrong one.
 *  - It does not offer a timestamp field. `occurredAt` is for backfilling a
 *    history through the API; a reading typed in now happened now, and letting
 *    an operator hand-date one is how a stream acquires a timestamp that
 *    contradicts its own version order.
 *
 * The range is shown because a value's meaning depends on it, and an operator
 * about to type 9 should be able to see that the ceiling is 8.
 */
export function TemperatureEntry({
  shipmentId,
  expectedVersion,
  minTemperatureC = null,
  maxTemperatureC = null,
  disabled = false,
  disabledReason = '',
  onChanged,
  onConflict,
}) {
  const [temperature, setTemperature] = useState('');
  const [sensorId, setSensorId] = useState('');
  const [formError, setFormError] = useState(null);

  const command = useCommand({
    onSuccess: () => {
      setTemperature('');
      setFormError(null);
      onChanged?.();
    },
    onConflict,
  });

  const hasRange = minTemperatureC !== null && maxTemperatureC !== null;

  /**
   * Local validation is a courtesy, not a guarantee. Every rule below is
   * enforced again by the command validator; catching an empty box here just
   * saves a round trip and gives the message a field to point at.
   */
  const submit = () => {
    const raw = temperature.trim();
    if (raw === '') {
      setFormError('Enter a temperature reading.');
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      setFormError('Temperature must be a number, in degrees Celsius.');
      return;
    }
    setFormError(null);
    command.execute(() =>
      api.recordTemperature({
        shipmentId,
        temperatureC: value,
        expectedVersion,
        ...(sensorId.trim() === '' ? {} : { sensorId: sensorId.trim() }),
      })
    );
  };

  const parsed = Number(temperature);
  const wouldBreach =
    hasRange && temperature.trim() !== '' && Number.isFinite(parsed)
      ? parsed > maxTemperatureC
        ? 'above'
        : parsed < minTemperatureC
          ? 'below'
          : null
      : null;

  const result = command.result;

  return (
    <div className="panel__body temperature-entry">
      {hasRange ? (
        <p className="form-hint temperature-entry__range">
          Acceptable range {formatTemperature(minTemperatureC)} to {formatTemperature(maxTemperatureC)}. A
          reading outside it is recorded as a temperature spike.
        </p>
      ) : (
        <p className="form-hint temperature-entry__range">
          No acceptable range was set for this container, so readings are recorded without breach
          classification.
        </p>
      )}

      {disabled ? (
        <p className="form-hint">{disabledReason}</p>
      ) : (
        <>
          <div className="form-grid form-grid--tight">
            <label className="field">
              <span className="field__label">Temperature (°C)</span>
              <input
                className="input"
                type="number"
                step="0.1"
                inputMode="decimal"
                value={temperature}
                placeholder="4.5"
                aria-label="Temperature in degrees Celsius"
                onChange={(event) => setTemperature(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Sensor ID (optional)</span>
              <input
                className="input"
                type="text"
                value={sensorId}
                placeholder="REEFER-01"
                aria-label="Sensor identifier"
                onChange={(event) => setSensorId(event.target.value)}
              />
            </label>
          </div>

          {wouldBreach ? (
            <p className="field__hint temperature-entry__preview">
              This reading is {wouldBreach} the acceptable range and will be recorded as a
              TEMPERATURE_SPIKE.
            </p>
          ) : null}

          <button
            type="button"
            className="btn btn--primary"
            disabled={command.pending}
            onClick={submit}
          >
            {command.pending ? 'Recording…' : 'Record reading'}
          </button>

          {formError ? <p className="form-error">{formError}</p> : null}

          {command.error ? (
            <p className="form-error">
              {command.error.isConflict
                ? 'This shipment changed while the form was open. Refresh to load the current version, then record the reading again.'
                : (command.error.message ?? 'The reading could not be recorded.')}
            </p>
          ) : null}

          {result ? (
            <p className="form-success temperature-entry__result">
              Recorded as {result.eventType} at version {result.version}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export default TemperatureEntry;
