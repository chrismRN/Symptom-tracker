#!/usr/bin/env node
// Backfill history from an Apple Health export.
//
// On the iPhone: Health app → profile picture → Export All Health Data.
// Unzip it and point this at apple_health_export/export.xml:
//
//   node scripts/import-health-export.js path/to/export.xml [--since 2026-01-01] [--overwrite]
//
// The export contains every raw sample from every device. When an iPhone and
// an Apple Watch both count the same walk, a plain sum double-counts. The
// Health app de-duplicates by device priority; we approximate that by taking,
// for each day and metric, the total from the single device that recorded the
// most. Days already filled by the Shortcut are left alone unless --overwrite.

import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { HealthStore } from '../src/store.js';
import { METERS_PER } from '../src/normalize.js';

const TYPES = {
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distance_m',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'active_kcal',
  HKQuantityTypeIdentifierBasalEnergyBurned: 'resting_kcal',
};

const UNIT_FACTORS = {
  count: 1,
  mi: METERS_PER.mi,
  km: METERS_PER.km,
  m: 1,
  ft: METERS_PER.ft,
  yd: METERS_PER.yd,
  kcal: 1,
  Cal: 1,
  cal: 1 / 1000,
  kJ: 1 / 4.184,
};

function attr(line, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(line);
  return m ? m[1] : null;
}

export async function aggregateExport(filePath, { since } = {}) {
  // date -> field -> source -> sum
  const acc = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  let records = 0;
  for await (const line of rl) {
    if (!line.includes('<Record ')) continue;
    const type = attr(line, 'type');
    const field = TYPES[type];
    if (!field) continue;
    const start = attr(line, 'startDate'); // "2026-11-10 08:15:00 -0500" — local date first
    const date = start ? start.slice(0, 10) : null;
    if (!date || (since && date < since)) continue;
    const factor = UNIT_FACTORS[attr(line, 'unit')];
    const value = Number(attr(line, 'value'));
    if (factor === undefined || !Number.isFinite(value)) continue;
    const source = attr(line, 'sourceName') || 'unknown';

    if (!acc.has(date)) acc.set(date, {});
    const byField = acc.get(date);
    byField[field] ||= {};
    byField[field][source] = (byField[field][source] || 0) + value * factor;
    records++;
  }

  const days = [];
  for (const [date, byField] of acc) {
    const day = { date };
    for (const [field, bySource] of Object.entries(byField)) {
      const best = Math.max(...Object.values(bySource));
      day[field] = field === 'steps' ? Math.round(best) : Math.round(best * 10) / 10;
    }
    days.push(day);
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, records };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const overwrite = args.includes('--overwrite');
  if (!file) {
    console.error('Usage: node scripts/import-health-export.js path/to/export.xml [--since YYYY-MM-DD] [--overwrite]');
    process.exit(1);
  }
  const config = loadConfig();
  const store = new HealthStore(config.dataFile);
  console.log(`Reading ${file} ...`);
  const { days, records } = await aggregateExport(file, { since });
  const touched = store.upsertDays(days, { source: 'health-export', overwrite });
  console.log(`Read ${records} samples across ${days.length} days; updated ${touched} days in ${config.dataFile}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
