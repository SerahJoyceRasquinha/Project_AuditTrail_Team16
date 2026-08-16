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
export function SensorChart({ series, selectedEventId, onSelectEvent }) {
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
    return (
      <EmptyBlock
        title="No sensor readings"
        message="No temperature has been recorded for this shipment in the selected time range."
      />
    );
  }

  const { minTemperatureC, maxTemperatureC } = series.range ?? {};
  const hasRange = minTemperatureC !== null && minTemperatureC !== undefined;

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
            <CartesianGrid stroke="#1e2d3d" strokeDasharray="3 3" />

            {/* The agreed safe band. Anything outside it is, by definition, the
                breach the ledger recorded. */}
            {hasRange ? (
              <ReferenceArea
                y1={minTemperatureC}
                y2={maxTemperatureC}
                fill="#34c3b0"
                fillOpacity={0.08}
                stroke="#34c3b0"
                strokeOpacity={0.25}
              />
            ) : null}

            {/* Lifecycle events share the chart's x-axis with the readings. */}
            {(series.markers ?? []).map((marker) => (
              <ReferenceLine
                key={marker.eventId}
                x={marker.epoch}
                stroke="#8f7ceb"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                label={{
                  value: eventLabel(marker.eventType),
                  position: 'insideTopRight',
                  fill: '#8f7ceb',
                  fontSize: 10,
                }}
              />
            ))}

            {selected ? <ReferenceLine x={selected.x} stroke="#34c3b0" strokeWidth={2} /> : null}

            <XAxis
              dataKey="x"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={(value) => formatShortTime(new Date(value).toISOString())}
              stroke="#6f8497"
              fontSize={11}
            />
            <YAxis
              domain={[Number((lowest - padding).toFixed(1)), Number((highest + padding).toFixed(1))]}
              unit="°"
              stroke="#6f8497"
              fontSize={11}
            />
            <Tooltip content={<SensorTooltip />} cursor={{ stroke: '#34c3b0', strokeWidth: 1 }} />

            <Line
              type="monotone"
              dataKey="temperatureC"
              stroke="#34c3b0"
              strokeWidth={2}
              dot={{ r: 3, fill: '#34c3b0' }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
              name="Temperature"
            />
            {/* Breaches are re-plotted in amber on top, so they read as events
                and not merely as points on a line. */}
            <Scatter dataKey="breachPoint" fill="#f0a13c" shape="circle" name="Breach" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-legend">
        <span className="chart-legend__key" style={{ color: '#34c3b0' }}>
          <span className="chart-legend__swatch" /> Temperature
        </span>
        <span className="chart-legend__key" style={{ color: '#f0a13c' }}>
          <span className="chart-legend__swatch" /> Recorded breach
        </span>
        <span className="chart-legend__key" style={{ color: '#8f7ceb' }}>
          <span className="chart-legend__swatch" /> Movement event
        </span>
        {hasRange ? (
          <span className="chart-legend__key">
            Agreed range {formatTemperature(minTemperatureC)} to {formatTemperature(maxTemperatureC)}
          </span>
        ) : (
          <span className="chart-legend__key">No temperature range was declared for this shipment</span>
        )}
      </div>

      {series.truncatedAt ? (
        <p className="eyebrow" style={{ marginBottom: 0 }}>
          Truncated to {formatTimestamp(series.truncatedAt)} to match the reconstructed state
        </p>
      ) : null}
    </div>
  );
}

function SensorTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__title">{formatTimestamp(point.timestamp)}</div>
      <div>{formatTemperature(point.temperatureC)}</div>
      {point.isBreach ? (
        <div style={{ color: '#f0a13c', marginTop: 4 }}>
          Breach {point.direction === 'ABOVE_MAX' ? 'above' : 'below'} {formatTemperature(point.thresholdC)}
        </div>
      ) : null}
      <div className="mono" style={{ color: '#6f8497', marginTop: 4 }}>
        v{point.version}
      </div>
    </div>
  );
}
