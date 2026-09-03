import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateShipmentRiskScore,
  getRiskLevel,
} from '../../src/domain/shipment/risk/riskScore.js';

test('temperature breach and overdue schedule produce a medium-high risk score', () => {
  const shipment = {
    temperatureExcursion: true,
    temperatureBreachCount: 1,
    schedule: { isOverdue: true },
    currentState: 'IN_TRANSIT',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    currentLocation: 'Chennai Port',
    vesselName: 'MV Ganges Star',
    voyageNumber: 'VY-2291',
  };

  const score = calculateShipmentRiskScore(shipment, { now: new Date('2026-01-05T00:00:00.000Z') });
  assert.equal(score, 70);
  assert.equal(getRiskLevel(score), 'High');
});

test('long dwell and integrity issue plus route anomaly cap at 100', () => {
  const shipment = {
    temperatureExcursion: true,
    temperatureBreachCount: 3,
    currentState: 'IN_TRANSIT',
    currentLocation: null,
    vesselName: null,
    voyageNumber: null,
    lastEventAt: '2025-12-01T00:00:00.000Z',
    schedule: { isOverdue: true },
  };

  const score = calculateShipmentRiskScore(shipment, {
    integrityIssue: true,
    now: new Date('2026-01-05T00:00:00.000Z'),
  });

  assert.equal(score, 100);
  assert.equal(getRiskLevel(score), 'High');
});

test('low risk remains low when no risk signals are present', () => {
  const shipment = {
    temperatureExcursion: false,
    temperatureBreachCount: 0,
    currentState: 'AT_PORT',
    currentLocation: 'Rotterdam',
    lastEventAt: new Date().toISOString(),
    schedule: { isOverdue: false },
  };

  const score = calculateShipmentRiskScore(shipment);
  assert.equal(score, 0);
  assert.equal(getRiskLevel(score), 'Low');
});
