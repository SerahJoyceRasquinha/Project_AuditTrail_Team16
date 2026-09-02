import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ComposedChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyBlock } from './StatusBlocks.jsx';
import { useChartPalette } from '../hooks/useTheme.js';
import { eventLabel, formatShortTime, formatTemperature, formatTimestamp } from '../utils/format.js';

/**
 * Temperature visualisation (roadmap 13.5 - 13.6).
 *
 * The chart and the timeline plot the same events on the same axis. Both take
 * their x-value from the event's own timestamp in epoch milliseconds, so a
 * point on the chart and a card in the timeline referring to the same event are
 * guaranteed to line up — no independent sorting, no timestamp re-parsing, no
 * chance of the mismatch roadmap 22 describes.
 *
 * The declared temperature range is drawn as a shaded band. That is what makes
 * a spike legible as a *breach of a stated commitment* rather than just a tall
 * bump on a line.
 */
export function SensorChart({
  series,
  selectedEventId,
  onSelectEvent,
  /**
   * Enough about the shipment to explain an empty chart honestly. A container
   * created thirty seconds ago has no readings because none have been taken
   * yet; a delivered one has none because monitoring has stopped. Those are
   * completely different situations and an operator should not have to guess
   * which one they are looking at.
   */
  shipmentCreatedAt = null,
  monitoringStopped = false,
  firstReadingDelayMs = 60_000,
}) {
  const palette = useChartPalette();

  const data = useMemo(
    () =>
      (series?.readings ?? []).map((reading) => ({
        ...reading,
        x: reading.epoch,
        breachPoint: reading.isBreach ? reading.temperatureC : null,
      })),
    [series]
  );

  const selected = useMemo(
    () => data.find((point) => point.eventId === selectedEventId) ?? null,
    [data, selectedEventId]
  );

  if (!series || data.length === 0) {
    return <EmptySensorState
      series={series}
      shipmentCreatedAt={shipmentCreatedAt}
      monitoringStopped={monitoringStopped}
      firstReadingDelayMs={firstReadingDelayMs}
    />;
  }

  const { minTemperatureC, maxTemperatureC } = series.range ?? {};
  const hasRange = minTemperatureC !== null && minTemperatureC !== undefined;
  const simulated = data.some((point) => point.source === 'SIMULATED');

  const temperatures = data.map((point) => point.temperatureC);
  const lowest = Math.min(...temperatures, hasRange ? minTemperatureC : Infinity);
  const highest = Math.max(...temperatures, hasRange ? maxTemperatureC : -Infinity);
  const padding = Math.max((highest - lowest) * 0.2, 1);

  return (
    <div className="panel__body">
      <div className="chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 4, left: -12 }}
            onClick={(payload) => {
              const point = payload?.activePayload?.[0]?.payload;
              if (point?.eventId) onSelectEvent(point.eventId);
            }}
          >
            <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />

            {/* The agreed safe band. Anything outside it is, by definition, the
                breach the ledger recorded. */}
            {hasRange ? (
              <ReferenceArea
                y1={minTemperatureC}
                y2={maxTemperatureC}
                fill={palette.teal}
                fillOpacity={0.08}
                stroke={palette.teal}
                strokeOpacity={0.25}
              />
            ) : null}

            {/* Lifecycle events share the chart's x-axis with the readings. */}
            {(series.markers ?? []).map((marker) => (
              <ReferenceLine
                key={marker.eventId}
                x={marker.epoch}
                stroke={palette.violet}
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                label={{
                  value: eventLabel(marker.eventType),
                  position: 'insideTopRight',
                  fill: palette.violet,
                  fontSize: 10,
                }}
              />
            ))}

            {/* The thresholds themselves, drawn as lines rather than only as the
                edges of the shaded band, so the exact limit a reading breached
                is legible at a glance. */}
            {hasRange ? (
              <ReferenceLine
                y={maxTemperatureC}
                stroke={palette.amber}
                strokeDasharray="5 3"
                label={{ value: 'Max', position: 'right', fill: palette.amber, fontSize: 10 }}
              />
            ) : null}
            {hasRange ? (
              <ReferenceLine
                y={minTemperatureC}
                stroke={palette.amber}
                strokeDasharray="5 3"
                label={{ value: 'Min', position: 'right', fill: palette.amber, fontSize: 10 }}
              />
            ) : null}

            {selected ? <ReferenceLine x={selected.x} stroke={palette.teal} strokeWidth={2} /> : null}

            <XAxis
              dataKey="x"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={(value) => formatShortTime(new Date(value).toISOString())}
              stroke={palette.axis}
              fontSize={11}
            />
            <YAxis
              domain={[Number((lowest - padding).toFixed(1)), Number((highest + padding).toFixed(1))]}
              unit="°"
              stroke={palette.axis}
              fontSize={11}
            />
            <Tooltip content={<SensorTooltip palette={palette} />} cursor={{ stroke: palette.teal, strokeWidth: 1 }} />

            <Line
              type="monotone"
              dataKey="temperatureC"
              stroke={palette.teal}
              strokeWidth={2}
              dot={{ r: 3, fill: palette.teal }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
              name="Temperature"
            />
            {/* Breaches are re-plotted in amber on top, so they read as events
                and not merely as points on a line. */}
            <Scatter dataKey="breachPoint" fill={palette.amber} shape="circle" name="Breach" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-legend">
        <span className="chart-legend__key" style={{ color: palette.teal }}>
          <span className="chart-legend__swatch" /> Temperature
        </span>
        <span className="chart-legend__key" style={{ color: palette.amber }}>
          <span className="chart-legend__swatch" /> Recorded breach
        </span>
        <span className="chart-legend__key" style={{ color: palette.violet }}>
          <span className="chart-legend__swatch" /> Movement event
        </span>
        {hasRange ? (
          <span className="chart-legend__key">
            Acceptable range {formatTemperature(minTemperatureC)} to {formatTemperature(maxTemperatureC)}
          </span>
        ) : (
          <span className="chart-legend__key">No temperature range was declared for this shipment</span>
        )}
        {/* Provenance sits in the legend, not only in a tooltip: a reader
            glancing at the chart must not mistake simulated data for
            measurement. */}
        {simulated ? (
          <span className="chart-legend__key" style={{ color: palette.violet }}>
            Readings are simulated, not measured
          </span>
        ) : null}
      </div>

      {series.truncatedAt ? (
        <p className="eyebrow" style={{ marginBottom: 0 }}>
          Truncated to {formatTimestamp(series.truncatedAt)} to match the reconstructed state
        </p>
      ) : null}
    </div>
  );
}

/**
 * What to say when the chart has nothing to draw.
 *
 * "No sensor readings" on its own is the message that made this section look
 * broken: a shipment created a moment ago genuinely has no readings yet, and
 * saying only that leaves someone refreshing the page waiting for a number that
 * is not due for another minute. So the copy distinguishes the three reasons a
 * chart can be empty - monitoring has not produced its first reading, the
 * scrubber is parked before any reading, or monitoring has finished - and
 * states which one applies.
 */
function EmptySensorState({ series, shipmentCreatedAt, monitoringStopped, firstReadingDelayMs }) {
  const createdAt = shipmentCreatedAt ? Date.parse(shipmentCreatedAt) : null;
  const dueAt = Number.isFinite(createdAt) ? createdAt + firstReadingDelayMs : null;
  const awaitingFirstReading = dueAt !== null && !monitoringStopped;
  const secondsRemaining = dueAt === null ? null : Math.max(Math.ceil((dueAt - Date.now()) / 1000), 0);

  if (series?.truncatedAt) {
    return (
      <EmptyBlock
        title="No readings yet at this point in time"
        message={`Nothing had been recorded for this shipment as at ${formatTimestamp(series.truncatedAt)}. Return to the live view to see the readings taken since.`}
      />
    );
  }

  if (monitoringStopped) {
    return (
      <EmptyBlock
        title="Monitoring has ended"
        message="This shipment is no longer being sampled, and no readings were recorded while it was."
      />
    );
  }

  if (awaitingFirstReading && secondsRemaining > 0) {
    return (
      <EmptyBlock
        title="Monitoring has started"
        message={`Temperature monitoring began when this shipment was created. The first reading is taken about a minute afterwards — roughly ${secondsRemaining} second${secondsRemaining === 1 ? '' : 's'} from now — and hourly after that. It will appear here on its own; there is nothing to refresh.`}
      />
    );
  }

  if (awaitingFirstReading) {
    return (
      <EmptyBlock
        title="Waiting for the first reading"
        message="Monitoring is running and the first reading is due. It will appear here as soon as it is recorded, without a page refresh."
      />
    );
  }

  return (
    <EmptyBlock
      title="No sensor readings"
      message="No temperature has been recorded for this shipment in the selected time range."
    />
  );
}

function SensorTooltip({ active, payload, palette }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__title">{formatTimestamp(point.timestamp)}</div>
      <div>{formatTemperature(point.temperatureC)}</div>
      {point.isBreach ? (
        <div style={{ color: palette.amber, marginTop: 4 }}>
          Alert: {point.direction === 'ABOVE_MAX' ? 'above' : 'below'} {formatTemperature(point.thresholdC)}
        </div>
      ) : null}
      {point.source === 'SIMULATED' ? (
        <div style={{ color: palette.violet, marginTop: 4, fontSize: 11 }}>Simulated reading</div>
      ) : null}
      <div className="mono" style={{ color: palette.axis, marginTop: 4 }}>
        v{point.version}
      </div>
    </div>
  );
}
