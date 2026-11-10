import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/http.js';
import { HealthStore } from '../src/store.js';
import { normalizeDay, normalizePayload } from '../src/normalize.js';
import { aggregateExport } from '../scripts/import-health-export.js';

const SECRET = 'test-secret-abcdefghijklmnopqrstuvwxyz';
const TZ = 'America/New_York';
let dir, server, base, store;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  store = new HealthStore(path.join(dir, 'health.json'));
  server = createApp({ config: { secret: SECRET, timeZone: TZ }, store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizes loose Shortcut values', () => {
  const d = normalizeDay({ date: '2026-11-09', steps: '8,421', distance: '3.5 mi', active_calories: '412 kcal', resting_calories: 1650 });
  assert.deepEqual(d, { date: '2026-11-09', steps: 8421, distance_m: 5632.7, active_kcal: 412, resting_kcal: 1650 });
  assert.equal(normalizeDay({ date: '2026-11-09', distance: 5, distance_unit: 'km' }).distance_m, 5000);
  assert.equal(normalizeDay({ date: '2026-11-09T23:55:00-05:00', steps: 1 }).date, '2026-11-09');
  assert.throws(() => normalizeDay({ date: '2026-02-30', steps: 1 }), /date/);
  assert.throws(() => normalizeDay({ date: '2026-11-09' }), /No metrics/);
  assert.equal(normalizePayload({ days: [{ date: '2026-11-01', steps: 1 }, { date: '2026-11-02', steps: 2 }] }).length, 2);
});

test('ingest requires the secret', async () => {
  const res = await fetch(`${base}/ingest`, { method: 'POST', body: '{"steps":1}' });
  assert.equal(res.status, 401);
  const mcp = await fetch(`${base}/mcp/wrong`, { method: 'POST', body: '{}' });
  assert.equal(mcp.status, 401);
});

test('ingest stores data, then Claude reads it over MCP', async () => {
  const post = (body) =>
    fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ date: '2026-11-08', steps: 10000, distance: 4.2, distance_unit: 'mi', active_calories: 500, resting_calories: 1600 })).status, 200);
  assert.equal((await post({ date: '2026-11-09', steps: '6,000', distance_mi: 2.5, active_calories: 300 })).status, 200);
  // A later upload for the same day replaces the running totals.
  assert.equal((await post({ date: '2026-11-09', steps: 7000 })).status, 200);
  assert.equal((await post({ date: 'nope', steps: 1 })).status, 400);

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_activity_range', 'get_daily_activity', 'get_sync_status']);

  const day = JSON.parse((await client.callTool({ name: 'get_daily_activity', arguments: { date: '2026-11-08' } })).content[0].text);
  assert.equal(day.steps, 10000);
  assert.equal(day.distance_miles, 4.2);
  assert.equal(day.total_calories, 2100);

  const range = JSON.parse(
    (await client.callTool({ name: 'get_activity_range', arguments: { start_date: '2026-11-01', end_date: '2026-11-09' } })).content[0].text,
  );
  assert.equal(range.summary.days_with_data, 2);
  assert.equal(range.summary.totals.steps, 17000);
  assert.equal(range.summary.totals.distance_miles, 6.7);
  assert.equal(range.summary.most_steps.date, '2026-11-08');

  const bad = await client.callTool({ name: 'get_activity_range', arguments: { start_date: '2026-11-09', end_date: '2026-11-01' } });
  assert.equal(bad.isError, true);

  const status = JSON.parse((await client.callTool({ name: 'get_sync_status', arguments: {} })).content[0].text);
  assert.equal(status.days_on_file, 2);
  assert.ok(status.last_sync);
  await client.close();

  // Persisted to disk.
  const reloaded = new HealthStore(store.filePath);
  assert.equal(reloaded.getDay('2026-11-09').steps, 7000);
  assert.equal(reloaded.getDay('2026-11-09').active_kcal, 300);
});

test('Health export import de-duplicates iPhone + Watch', async () => {
  const xml = path.join(dir, 'export.xml');
  fs.writeFileSync(
    xml,
    [
      '<HealthData>',
      ' <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-10-01 08:00:00 -0400" endDate="2026-10-01 08:10:00 -0400" value="1000"/>',
      ' <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" startDate="2026-10-01 08:00:00 -0400" endDate="2026-10-01 08:10:00 -0400" value="1100"/>',
      ' <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" startDate="2026-10-01 18:00:00 -0400" endDate="2026-10-01 18:10:00 -0400" value="900"/>',
      ' <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="iPhone" unit="mi" startDate="2026-10-01 08:00:00 -0400" endDate="2026-10-01 08:10:00 -0400" value="1"/>',
      ' <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Apple Watch" unit="Cal" startDate="2026-10-01 08:00:00 -0400" endDate="2026-10-01 08:10:00 -0400" value="80"/>',
      ' <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2026-10-01 08:00:00 -0400" endDate="2026-10-01 08:00:00 -0400" value="90"/>',
      '</HealthData>',
    ].join('\n'),
  );
  const { days } = await aggregateExport(xml);
  assert.deepEqual(days, [{ date: '2026-10-01', steps: 2000, distance_m: 1609.3, active_kcal: 80 }]);
});
