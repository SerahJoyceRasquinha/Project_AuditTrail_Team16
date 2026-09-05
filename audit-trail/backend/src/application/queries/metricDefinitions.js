/**
 * What every dashboard number means.
 *
 * This module exists because the same explanations are needed in three places -
 * the KPI cards, the charts, and the exported report - and three hand-written
 * copies would disagree within a week. Serving them from here means the tooltip
 * on screen and the paragraph in the PDF are the same sentence by construction,
 * and changing a definition is one edit.
 *
 * Each entry carries two explanations rather than one, because the two readers
 * are genuinely different people:
 *
 *  - `plain` is for the logistics manager the source document describes. No
 *    schema, no jargon, no event sourcing. What the number counts and what it
 *    would mean if it moved.
 *  - `technical` is for whoever has to trust, debug or defend the figure. Which
 *    projection field it reads, over which set of shipments, and where the
 *    honest edges are.
 *
 * `formula` is stated separately and deliberately: a metric whose arithmetic is
 * not written down anywhere ends up being re-derived by guesswork the first
 * time someone disputes it.
 */

/**
 * A note that applies to every figure on the dashboard and is therefore stated
 * once rather than repeated in nine definitions.
 */
export const METRICS_BASIS = Object.freeze({
  source:
    'Every figure is read from the shipment read model - the projection the worker builds by replaying the event log - not from the event log directly.',
  scope:
    'All shipments are included, archived ones as well as live ones. Archiving files a shipment away; it does not retract what happened to it.',
  freshness:
    'The read model trails the event log by however far the projection worker is behind, so a command issued a moment ago may not be counted yet. GET /api/meta/worker reports that lag.',
});

/**
 * @typedef {object} MetricDefinition
 * @property {string} key         Field name in the metrics payload.
 * @property {string} label       Human label, matching the KPI card.
 * @property {string} unit        Display unit, or '' for a plain count.
 * @property {string} plain       Explanation with no jargon.
 * @property {string} technical   Explanation for an engineer or auditor.
 * @property {string} formula     How the number is actually computed.
 */

/** @type {ReadonlyArray<MetricDefinition>} */
export const METRIC_DEFINITIONS = Object.freeze([
  {
    key: 'totalShipments',
    label: 'Total Shipments',
    unit: '',
    plain:
      'Every shipment the system has ever been told about, whether it is still moving, already delivered, or archived. This number only ever goes up.',
    technical:
      'Count of documents in the shipment read model with no view filter applied. Read across every page of the read model, not just the first, so it does not stop at the per-request page limit.',
    formula: 'count(all shipments)',
  },
  {
    key: 'activeShipments',
    label: 'Active Shipments',
    unit: '',
    plain:
      'Shipments that have not been archived - the ones still on your desk. Archiving one moves it out of this count without changing the total.',
    technical:
      'Count of read-model documents where `archived` is not true. Together with Archived Shipments this partitions the total exactly; the two always sum to it.',
    formula: 'count(shipments where archived !== true)',
  },
  {
    key: 'archivedShipments',
    label: 'Archived Shipments',
    unit: '',
    plain:
      'Shipments that have been filed away as finished. Their history is untouched and can be reopened at any time by restoring them.',
    technical:
      'Count of read-model documents where `archived` is true. Archiving appends a SHIPMENT_ARCHIVED event; it deletes nothing, so these shipments still contribute to every breach and delivery figure below.',
    formula: 'count(shipments where archived === true)',
  },
  {
    key: 'byState',
    label: 'Shipments by Lifecycle State',
    unit: '',
    plain:
      'Where each shipment has got to: created but not yet loaded, in transit on a ship, arrived at a port, or unloaded at the far end. Every shipment sits in exactly one of these.',
    technical:
      'Grouped on the `currentState` field of the read model, with one bucket per value of the SHIPMENT_STATES enum. The buckets are derived from the enum rather than hand-listed, so they always sum to Total Shipments.',
    formula: 'group shipments by currentState, one bucket per SHIPMENT_STATES value',
  },
  {
    key: 'overallTemperatureCompliance',
    label: 'Temperature Compliance',
    unit: '%',
    plain:
      'The share of shipments that never went outside their agreed temperature range. 100% means nothing has ever gone out of range. It counts shipments, not readings - one shipment with twenty breaches counts once.',
    technical:
      'Percentage of shipments whose `temperatureBreachCount` is zero. A shipment created without minTemperatureC and maxTemperatureC has no range to breach, so it is counted as compliant - it is not evidence of good handling, only the absence of a threshold to test against.',
    formula: 'round((totalShipments - withBreaches) / totalShipments * 100)',
  },
  {
    key: 'withBreaches',
    label: 'Shipments with Breaches',
    unit: '',
    plain:
      'How many shipments have had at least one temperature reading outside their agreed range. A shipment is counted once here however many times it went out of range.',
    technical:
      'Count of read-model documents where `temperatureBreachCount` > 0. That counter is incremented by the reducer on each TEMPERATURE_SPIKE event, which the aggregate emits only when the reading falls outside the min/max declared on CONTAINER_CREATED.',
    formula: 'count(shipments where temperatureBreachCount > 0)',
  },
  {
    key: 'totalBreaches',
    label: 'Total Breaches',
    unit: '',
    plain:
      'The total number of out-of-range temperature readings across every shipment. Unlike the count above, a single badly handled shipment can contribute many.',
    technical:
      'Sum of `temperatureBreachCount` across all read-model documents. One TEMPERATURE_SPIKE event in the log equals one unit here; the events themselves remain in the ledger and can be inspected per shipment.',
    formula: 'sum(temperatureBreachCount over all shipments)',
  },
  {
    key: 'avgBreachesPerShipment',
    label: 'Avg Breaches / Shipment',
    unit: '',
    plain:
      'Total breaches spread evenly across every shipment. Useful for spotting whether breaches are widespread or concentrated in a few bad shipments - compare it against the Shipments with Breaches figure.',
    technical:
      'Arithmetic mean over all shipments, including the ones with zero breaches and the ones with no thresholds declared. It is not a mean over breaching shipments only, so it reads low on a mostly-clean fleet by design.',
    formula: 'round(totalBreaches / totalShipments * 100) / 100',
  },
  {
    key: 'averageDeliveryTime',
    label: 'Avg Delivery Time',
    unit: ' days',
    plain:
      'How long a completed shipment takes on average, from being created to being unloaded at its destination. Shipments still in transit are not counted, so this describes finished journeys only.',
    technical:
      'Mean of (`unloadedAt` - `createdAt`) over shipments that have both timestamps, converted from hours to days and rounded to two decimals. Shipments without an `unloadedAt` are excluded rather than treated as zero.',
    formula: 'mean(unloadedAt - createdAt) over completed shipments, in days',
  },
  {
    key: 'onTimeDeliveryRate',
    label: 'On-Time Delivery Rate',
    unit: '%',
    plain:
      'Of the shipments that have finished, the share that arrived within the estimated duration promised when they were created.',
    technical:
      'Percentage of completed shipments where elapsed hours <= `estimatedDurationDays` * 24. Measured against the estimate stored on the creation event, not against a planned schedule date, so revising a schedule does not retroactively change this figure.',
    formula: 'round(onTimeShipments / completedShipments * 100)',
  },
  {
    key: 'shipmentsByOrigin',
    label: 'Shipments by Origin',
    unit: '',
    plain:
      'Which places shipments are starting from, busiest first. Only the top five are shown, so this is a picture of your main lanes rather than a full list.',
    technical:
      'Grouped on the resolved `origin` display string, sorted by count descending and truncated to the top five. The string comes from the country/subdivision catalogue, so entries are already normalised and will not split on spelling.',
    formula: 'group by origin, sort by count desc, take 5',
  },
  {
    key: 'shipmentsByDestination',
    label: 'Shipments by Destination',
    unit: '',
    plain:
      'Where shipments are heading, busiest first. As with origins, only the top five appear.',
    technical:
      'Grouped on the resolved `destination` display string, sorted by count descending and truncated to the top five.',
    formula: 'group by destination, sort by count desc, take 5',
  },
]);

/** Definitions keyed for lookup, e.g. by a tooltip that has only the field name. */
export const METRIC_DEFINITIONS_BY_KEY = Object.freeze(
  Object.fromEntries(METRIC_DEFINITIONS.map((definition) => [definition.key, definition]))
);

/**
 * What each chart shows, in the same two registers.
 *
 * The charts are exported alongside the numbers, so they need explaining for
 * the same reason the numbers do - a pie chart with no caption is a decoration.
 */
export const CHART_DEFINITIONS = Object.freeze([
  {
    key: 'byState',
    title: 'By Lifecycle State',
    type: 'pie',
    plain:
      'How the fleet is spread across the four stages of a journey. A healthy board usually has most shipments in transit or at port, with created ones waiting to depart.',
    technical:
      'One slice per SHIPMENT_STATES value, sized by the byState counts. Slices sum to Total Shipments; a state with no shipments still has a bucket, it is simply zero.',
  },
  {
    key: 'temperatureCompliance',
    title: 'Temperature Compliance',
    type: 'pie',
    plain:
      'The split between shipments that stayed in range and those that did not. Read it as a proportion of shipments, not of readings.',
    technical:
      'Two slices derived from overallTemperatureCompliance: the compliant percentage and its complement. It is a rendering of one number, not an independent measurement.',
  },
  {
    key: 'shipmentsByOrigin',
    title: 'Shipments by Origin',
    type: 'bar',
    plain: 'Your five busiest departure points, tallest bar first.',
    technical:
      'Bar per entry in the truncated shipmentsByOrigin map. Because it is truncated to five, the bars do not sum to Total Shipments on a fleet with more than five origins.',
  },
  {
    key: 'shipmentsByDestination',
    title: 'Shipments by Destination',
    type: 'bar',
    plain: 'Your five busiest arrival points, tallest bar first.',
    technical:
      'Bar per entry in the truncated shipmentsByDestination map, with the same truncation caveat as origins.',
  },
]);
