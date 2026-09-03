const DEFAULT_TTL_HOURS = 72;

function isShipmentDelayed(shipment) {
  if (!shipment) return false;
  if (shipment.schedule?.isOverdue || shipment.isOverdue) return true;
  if (Array.isArray(shipment.schedule?.overdueStages) && shipment.schedule.overdueStages.length > 0) return true;
  return false;
}

function isLongInCurrentState(shipment, now = new Date()) {
  if (!shipment || !shipment.lastEventAt || shipment.currentState === 'UNLOADED') return false;

  const lastEventMs = new Date(shipment.lastEventAt).getTime();
  if (!Number.isFinite(lastEventMs)) return false;

  const elapsedHours = (now.getTime() - lastEventMs) / (1000 * 60 * 60);
  const thresholdHours = shipment.currentState === 'CREATED' ? 48 : DEFAULT_TTL_HOURS;
  return elapsedHours > thresholdHours;
}

function hasLocationAnomaly(shipment) {
  if (!shipment) return false;

  if (!shipment.currentLocation && ['IN_TRANSIT', 'AT_PORT', 'UNLOADED'].includes(shipment.currentState)) {
    return true;
  }

  if (shipment.currentState === 'IN_TRANSIT' && (!shipment.vesselName || !shipment.voyageNumber)) {
    return true;
  }

  return false;
}

export function calculateShipmentRiskScore(shipment = {}, { integrityIssue = false, now = new Date() } = {}) {
  let score = 0;

  if (shipment.temperatureExcursion || shipment.temperatureBreachCount > 0) score += 30;
  if (isShipmentDelayed(shipment)) score += 25;
  if (isLongInCurrentState(shipment, now)) score += 15;
  if (hasLocationAnomaly(shipment)) score += 20;
  if (integrityIssue) score += 10;

  return Math.min(score, 100);
}

export function getRiskLevel(score) {
  if (score >= 70) return 'High';
  if (score >= 35) return 'Medium';
  return 'Low';
}
