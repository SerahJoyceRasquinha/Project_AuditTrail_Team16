import { useEffect, useMemo, useState } from 'react';
import { formatTimestamp } from '../utils/format.js';

/**
 * The time scrubber (roadmap 12.8).
 *
 * The slider moves over epoch milliseconds between the first and last event, so
 * every position is a real instant rather than an event index — the point is to
 * ask "what did this shipment look like at 14:20 on Tuesday", not "what did it
 * look like after event 3".
 *
 * Local slider position is kept in component state and only committed upward on
 * release (or after a short pause), so dragging feels immediate while the
 * backend sees one request per resting position instead of one per pixel.
 */
export function StateScrubber({ bounds, scrubAt, isHistorical, onScrub, onReturnToLive, events = [] }) {
  const min = useMemo(() => (bounds?.firstEventAt ? Date.parse(bounds.firstEventAt) : null), [bounds]);
  const max = useMemo(() => (bounds?.lastEventAt ? Date.parse(bounds.lastEventAt) : null), [bounds]);

  const [position, setPosition] = useState(max ?? 0);

  useEffect(() => {
    // Follow the store when it changes from elsewhere (returning to live,
    // selecting a different shipment), but never fight the user mid-drag.
    if (!isHistorical && max !== null) setPosition(max);
    else if (scrubAt) setPosition(Date.parse(scrubAt));
  }, [scrubAt, isHistorical, max]);

  if (min === null || max === null || min === max) {
    return (
      <div className="panel__body">
        <p className="eyebrow" style={{ margin: 0 }}>
          Time scrubbing needs at least two events at different times.
        </p>
      </div>
    );
  }

  const commit = (value) => onScrub(new Date(Number(value)).toISOString());

  // Event instants are marked on the track so the investigator can land exactly
  // on a moment that matters rather than hunting for it.
  const markers = events.map((event) => ({
    id: event.eventId,
    percent: ((Date.parse(event.timestamp) - min) / (max - min)) * 100,
    breach: event.eventType === 'TEMPERATURE_SPIKE',
  }));

  return (
    <div className="panel__body">
      <div className="scrubber__readout">
        <span className="eyebrow">{isHistorical ? 'Viewing state as at' : 'Viewing current state'}</span>
        <span className="scrubber__value">
          {isHistorical ? formatTimestamp(new Date(position).toISOString()) : 'live'}
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <input
          type="range"
          className="scrubber__range"
          min={min}
          max={max}
          step={1000}
          value={position}
          onChange={(bubble) => setPosition(Number(bubble.target.value))}
          onMouseUp={(bubble) => commit(bubble.target.value)}
          onTouchEnd={(bubble) => commit(bubble.target.value)}
          onKeyUp={(bubble) => commit(bubble.target.value)}
          aria-label="Reconstruct shipment state at a point in time"
          aria-valuetext={formatTimestamp(new Date(position).toISOString())}
        />
        <div style={{ position: 'relative', height: 6, marginTop: -6 }} aria-hidden="true">
          {markers.map((marker) => (
            <span
              key={marker.id}
              style={{
                position: 'absolute',
                left: `${marker.percent}%`,
                width: 2,
                height: 6,
                background: marker.breach ? 'var(--signal-amber)' : 'var(--rule)',
              }}
            />
          ))}
        </div>
      </div>

      <div className="scrubber__bounds">
        <span>{formatTimestamp(bounds.firstEventAt, { withZone: false, seconds: false })}</span>
        <span>{formatTimestamp(bounds.lastEventAt, { withZone: false, seconds: false })}</span>
      </div>

      <div className="scrubber__actions">
        <button type="button" className="btn btn--sm" onClick={() => commit(position)}>
          Reconstruct at this instant
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onReturnToLive} disabled={!isHistorical}>
          Return to live
        </button>
      </div>
    </div>
  );
}
