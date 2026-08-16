import { memo } from 'react';
import { eventLabel, eventTone, formatTimestamp, payloadEntries, truncateHash } from '../utils/format.js';
import { EmptyBlock } from './StatusBlocks.jsx';

/**
 * One event in the ledger.
 *
 * Memoised because a stream of a few hundred events re-renders on every scrub
 * tick otherwise, and the slider is the one interaction where dropped frames
 * are immediately obvious.
 */
export const EventCard = memo(function EventCard({ event, selected, onSelect, dimmed }) {
  const tone = eventTone(event.eventType);
  const entries = payloadEntries(event.payload);

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

        {/* The raw event type is kept visible alongside the friendly label: this
            is an audit tool, and the stored value is what a dispute turns on. */}
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
            <span>{truncateHash(event.previousHash) }</span>
            <span aria-hidden="true">→</span>
            <span>{truncateHash(event.hash)}</span>
          </div>
        ) : null}
      </button>
    </li>
  );
});

/**
 * The vertical event timeline (roadmap 10.7).
 *
 * Events are rendered in exactly the order the API returned them. The API sorts
 * by version, which is the deterministic key even when two events share a
 * timestamp — so re-sorting here would only ever introduce a way to be wrong
 * (roadmap 10.8, "Mistake 5").
 *
 * When the scrubber is engaged, events after the scrub point are dimmed rather
 * than hidden: an investigator needs to see that later events exist while
 * examining a moment before them.
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
