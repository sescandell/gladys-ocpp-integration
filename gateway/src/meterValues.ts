import type { ConnectorState } from './state.ts';
import type { MeterValueBucket } from './ocpp16.ts';

/**
 * OCPP 1.6 MeterValues parsing -> ConnectorState patch. Covers the standard
 * measurands relevant to EV charging: Energy.Active.Import.Register (Wh),
 * Power.Active.Import (W), Current.Import (A), Voltage (V), Power.Offered (W),
 * Current.Offered (A). Unknown measurands are ignored (forward compatibility).
 */

const MEASURAND_TO_FIELD: Record<string, keyof ConnectorState> = {
  'Energy.Active.Import.Register': 'energyActiveImportRegisterWh',
  'Power.Active.Import': 'powerActiveImportW',
  'Power.Offered': 'powerOfferedW',
  'Current.Import': 'currentImportA',
  'Current.Offered': 'currentOfferedA',
  Voltage: 'voltageV',
};

export function meterValuesToPatch(
  meterValue: MeterValueBucket[] | undefined,
): Partial<ConnectorState> {
  const patch: Partial<ConnectorState> = {};
  let lastTimestamp: string | null = null;

  for (const bucket of meterValue ?? []) {
    lastTimestamp = bucket.timestamp ?? lastTimestamp;
    for (const sampled of bucket.sampledValue ?? []) {
      const field = sampled.measurand ? MEASURAND_TO_FIELD[sampled.measurand] : undefined;
      if (!field) continue;
      const value = Number.parseFloat(sampled.value);
      if (Number.isNaN(value)) continue;
      (patch as Record<string, number>)[field] = value;
    }
  }

  if (lastTimestamp) {
    patch.lastMeterValueAt = lastTimestamp;
  }

  return patch;
}
