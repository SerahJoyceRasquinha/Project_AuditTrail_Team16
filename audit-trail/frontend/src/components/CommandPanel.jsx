import { useState } from 'react';
import * as api from '../services/apiClient.js';
import { useCommand } from '../hooks/useShipmentData.js';
import { formatTemperature } from '../utils/format.js';

/**
 * The command surface.
 *
 * Note the `expectedVersion` readout: it is deliberately visible rather than
 * hidden in the request. This panel is how the OCC demonstration is performed —
 * open the same shipment in two tabs, submit in one, then submit in the other
 * and watch the stale version be rejected — and that story is much easier to
 * tell when the version the form is holding is on screen.
 *
 * The panel is disabled entirely while the scrubber is engaged. Issuing a
 * command from a historical view would mean acting on state that is not
 * current, and the version the form holds would be meaningless.
 */
export function CommandPanel({ shipment, disabled, disabledReason, onCommandSucceeded, onConflict }) {
  const [tab, setTab] = useState('move');
  const currentVersion = shipment?.currentVersion ?? 0;

  const command = useCommand({
    onSuccess: onCommandSucceeded,
    onConflict,
  });

  const [move, setMove] = useState({
    movementType: 'LOAD_ON_SHIP',
    location: '',
    vesselName: '',
    voyageNumber: '',
    portName: '',
    berth: '',
  });
  const [temperature, setTemperature] = useState({ temperatureC: '', sensorId: 'REEFER-01' });

  const submitMove = () =>
    command.execute(() =>
      api.moveShipment({
        shipmentId: shipment.aggregateId,
        movementType: move.movementType,
        location: move.location,
        vesselName: move.vesselName || null,
        voyageNumber: move.voyageNumber || null,
        portName: move.portName || null,
        berth: move.berth || null,
        expectedVersion: currentVersion,
      })
    );

  const submitTemperature = () =>
    command.execute(() =>
      api.recordTemperature({
        shipmentId: shipment.aggregateId,
        temperatureC: Number(temperature.temperatureC),
        sensorId: temperature.sensorId || null,
        expectedVersion: currentVersion,
      })
    );

  const inRange =
    shipment?.minTemperatureC !== null &&
    shipment?.minTemperatureC !== undefined &&
    temperature.temperatureC !== '' &&
    (Number(temperature.temperatureC) < shipment.minTemperatureC ||
      Number(temperature.temperatureC) > shipment.maxTemperatureC);

  return (
    <div className="panel__body">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          className={`btn btn--sm ${tab === 'move' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setTab('move')}
        >
          Record movement
        </button>
        <button
          type="button"
          className={`btn btn--sm ${tab === 'temperature' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setTab('temperature')}
        >
          Record temperature
        </button>
      </div>

      {disabled ? (
        <p className="banner banner--historical" style={{ marginBottom: 14 }}>
          {disabledReason}
        </p>
      ) : null}

      {tab === 'move' ? (
        <div className="command-form">
          <div className="command-form__row">
            <label className="field">
              <span className="field__label">Movement</span>
              <select
                className="select"
                value={move.movementType}
                onChange={(bubble) => setMove({ ...move, movementType: bubble.target.value })}
                disabled={disabled}
              >
                <option value="LOAD_ON_SHIP">Load on ship</option>
                <option value="ARRIVE_AT_PORT">Arrive at port</option>
                <option value="UNLOAD_FROM_SHIP">Unload from ship</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Location</span>
              <input
                className="input"
                value={move.location}
                onChange={(bubble) => setMove({ ...move, location: bubble.target.value })}
                placeholder="Chennai Port, Berth 4"
                disabled={disabled}
              />
            </label>
          </div>

          {move.movementType === 'LOAD_ON_SHIP' ? (
            <div className="command-form__row">
              <label className="field">
                <span className="field__label">Vessel</span>
                <input
                  className="input"
                  value={move.vesselName}
                  onChange={(bubble) => setMove({ ...move, vesselName: bubble.target.value })}
                  placeholder="MV Ganges Star"
                  disabled={disabled}
                />
              </label>
              <label className="field">
                <span className="field__label">Voyage</span>
                <input
                  className="input"
                  value={move.voyageNumber}
                  onChange={(bubble) => setMove({ ...move, voyageNumber: bubble.target.value })}
                  placeholder="VY-2291"
                  disabled={disabled}
                />
              </label>
            </div>
          ) : null}

          {move.movementType === 'ARRIVE_AT_PORT' ? (
            <div className="command-form__row">
              <label className="field">
                <span className="field__label">Port</span>
                <input
                  className="input"
                  value={move.portName}
                  onChange={(bubble) => setMove({ ...move, portName: bubble.target.value })}
                  placeholder="Port of Rotterdam"
                  disabled={disabled}
                />
              </label>
              <label className="field">
                <span className="field__label">Berth</span>
                <input
                  className="input"
                  value={move.berth}
                  onChange={(bubble) => setMove({ ...move, berth: bubble.target.value })}
                  placeholder="ECT Delta 7"
                  disabled={disabled}
                />
              </label>
            </div>
          ) : null}

          <CommandFooter
            command={command}
            currentVersion={currentVersion}
            disabled={disabled || !move.location}
            onSubmit={submitMove}
            label="Append movement event"
          />
        </div>
      ) : (
        <div className="command-form">
          <div className="command-form__row">
            <label className="field">
              <span className="field__label">Temperature (°C)</span>
              <input
                className="input mono"
                type="number"
                step="0.1"
                value={temperature.temperatureC}
                onChange={(bubble) => setTemperature({ ...temperature, temperatureC: bubble.target.value })}
                placeholder="4.5"
                disabled={disabled}
              />
            </label>
            <label className="field">
              <span className="field__label">Sensor</span>
              <input
                className="input"
                value={temperature.sensorId}
                onChange={(bubble) => setTemperature({ ...temperature, sensorId: bubble.target.value })}
                disabled={disabled}
              />
            </label>
          </div>

          {inRange ? (
            <p className="eyebrow" style={{ color: 'var(--signal-amber)' }}>
              Outside the agreed range of {formatTemperature(shipment.minTemperatureC)} to{' '}
              {formatTemperature(shipment.maxTemperatureC)} — this will be recorded as a temperature spike.
            </p>
          ) : null}

          <CommandFooter
            command={command}
            currentVersion={currentVersion}
            disabled={disabled || temperature.temperatureC === ''}
            onSubmit={submitTemperature}
            label="Append temperature event"
          />
        </div>
      )}
    </div>
  );
}

function CommandFooter({ command, currentVersion, disabled, onSubmit, label }) {
  return (
    <>
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

      {command.result ? (
        <div className="form-success" role="status">
          Appended {command.result.eventType} as version {command.result.version}. The projection updates a
          moment later.
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn btn--primary" onClick={onSubmit} disabled={disabled || command.pending}>
          {command.pending ? 'Appending…' : label}
        </button>
        <span className="command-form__version">expectedVersion: {currentVersion}</span>
      </div>
    </>
  );
}
