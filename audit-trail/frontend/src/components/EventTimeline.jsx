import { memo, useState } from 'react';
import { eventLabel, eventTone, formatTimestamp, payloadEntries, truncateHash } from '../utils/format.js';
import { EmptyBlock } from './StatusBlocks.jsx';

/**
 * One event in the ledger.
 */
export const EventCard = memo(function EventCard({ event, selected, onSelect, dimmed }) {
  const [copiedId, setCopiedId] = useState(false);
  const [copiedHash, setCopiedHash] = useState(false);

  const tone = eventTone(event.eventType);
  const entries = payloadEntries(event.payload);

  const copyEventId = async (e) => {
    e.stopPropagation();

    await navigator.clipboard.writeText(event.eventId);
    setCopiedId(true);

    setTimeout(() => {
      setCopiedId(false);
    }, 1500);
  };

  const copyEventHash = async (e) => {
    e.stopPropagation();

    await navigator.clipboard.writeText(event.hash);
    setCopiedHash(true);

    setTimeout(() => {
      setCopiedHash(false);
    }, 1500);
  };

  return (
    <li className="event" style={dimmed ? { opacity: 0.38 } : undefined}>
      <span className={`event__dot event__dot--${tone}`} aria-hidden="true" />

      <button
        type="button"
        className={[
          'event__card',
          selected ? 'event__card--selected' : '',
          event.eventType === 'TEMPERATURE_SPIKE' ? 'event__card--breach' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onSelect(event.eventId)}
        aria-pressed={selected}
        aria-label={`${eventLabel(event.eventType)}, version ${event.version}`}
      >
        <div className="event__head">
          <span className="event__type">{eventLabel(event.eventType)}</span>
          <span className="event__version">v{event.version}</span>

          {event.eventType === 'TEMPERATURE_SPIKE' ? (
            <span className="pill pill--amber">
              <span className="pill__dot" />
              Breach
            </span>
          ) : null}
        </div>

        <div className="event__time mono">
          {formatTimestamp(event.timestamp)} · {event.eventType}
        </div>

        {selected && entries.length > 0 ? (
          <dl className="event__payload">
            {entries.map((entry) => (
              <div key={entry.key} style={{ display: 'contents' }}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {selected ? (
          <div className="event__chain">
            <span>chain</span>
            <span>{truncateHash(event.previousHash)}</span>
            <span aria-hidden="true">→</span>
            <span>{truncateHash(event.hash)}</span>
          </div>
        ) : null}
      </button>

      <div className="event__actions">
        <button
          type="button"
          className="event__copy"
          onClick={copyEventId}
          aria-label="Copy event ID"
        >
          {copiedId ? 'Copied ✓' : 'Copy ID'}
        </button>

        <button
          type="button"
          className="event__copy"
          onClick={copyEventHash}
          aria-label="Copy event hash"
        >
          {copiedHash ? 'Copied ✓' : 'Copy hash'}
        </button>
      </div>
    </li>
  );
});

/**
 * The vertical event timeline.
 */
export function EventTimeline({ events, selectedEventId, onSelect, cutoffAt = null }) {
  if (!events || events.length === 0) {
    return (
      <EmptyBlock
        title="No events recorded"
        message="This shipment has no history yet. Send a command to append the first event."
      />
    );
  }

  const cutoffEpoch = cutoffAt ? Date.parse(cutoffAt) : null;

  return (
    <ol className="timeline">
      {events.map((event) => (
        <EventCard
          key={event.eventId}
          event={event}
          selected={event.eventId === selectedEventId}
          onSelect={onSelect}
          dimmed={cutoffEpoch !== null && Date.parse(event.timestamp) > cutoffEpoch}
        />
      ))}
    </ol>
  );
}