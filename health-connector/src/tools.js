// MCP tools Claude can call. Shared by the HTTP (remote connector) and
// stdio (Claude Desktop / Claude Code local) entry points.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addDays, isValidDate, presentDay, round, todayIn } from './normalize.js';

const MAX_RANGE_DAYS = 366;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isValidDate, 'Not a real calendar date');

function json(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function error(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function summarize(rows) {
  const sum = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const avg = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const best = rows.filter((r) => r.steps != null).sort((a, b) => b.steps - a.steps)[0];
  const r = (v, p) => (v == null ? null : round(v, p));
  return {
    days_with_data: rows.length,
    totals: {
      steps: sum('steps'),
      distance_miles: r(sum('distance_miles'), 2),
      distance_km: r(sum('distance_km'), 2),
      active_calories: r(sum('active_calories'), 0),
      resting_calories: r(sum('resting_calories'), 0),
      total_calories: r(sum('total_calories'), 0),
    },
    daily_averages: {
      steps: r(avg('steps'), 0),
      distance_miles: r(avg('distance_miles'), 2),
      active_calories: r(avg('active_calories'), 0),
      total_calories: r(avg('total_calories'), 0),
    },
    most_steps: best ? { date: best.date, steps: best.steps } : null,
  };
}

/**
 * @param {import('./store.js').HealthStore} store
 * @param {{timeZone?: string, beforeEachCall?: () => void}} opts
 */
export function createMcpServer(store, { timeZone, beforeEachCall = () => {} } = {}) {
  const server = new McpServer(
    { name: 'iphone-health', version: '1.0.0' },
    {
      instructions:
        'Activity data synced from the user\'s iPhone Health app: daily steps, walking + running distance, ' +
        'and calories burned (active energy, resting energy, and their total). Dates are calendar days in ' +
        `the user's time zone (${timeZone || 'server default'}). Today's numbers are partial until the day ends ` +
        'and only update when the phone syncs, so mention last_updated when it matters. ' +
        'This is personal health data: only discuss it with the user it belongs to.',
    },
  );

  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'get_daily_activity',
    {
      title: 'Daily activity',
      description:
        'Steps, miles walked, and calories burned for one day from iPhone Health. ' +
        'Defaults to today. Use for questions like "how many steps today?" or "what did I burn yesterday?".',
      inputSchema: {
        date: dateSchema.optional().describe('Day to look up, YYYY-MM-DD. Omit for today.'),
      },
      annotations: { title: 'Daily activity', ...readOnly },
    },
    async ({ date }) => {
      beforeEachCall();
      const day = date || todayIn(timeZone);
      const rec = store.getDay(day);
      if (!rec) {
        const s = store.status();
        return json({
          date: day,
          found: false,
          note:
            s.days_on_file === 0
              ? 'No data has been synced yet. Run the "Sync Health to Claude" Shortcut on the iPhone.'
              : `No data for ${day}. Last sync: ${s.last_sync || 'never (imported data only)'}.`,
        });
      }
      return json({ found: true, ...presentDay(day, rec) });
    },
  );

  server.registerTool(
    'get_activity_range',
    {
      title: 'Activity over a date range',
      description:
        'Day-by-day steps, miles, and calories between two dates (inclusive), plus totals, daily averages, ' +
        'and the highest-step day. Use for weekly/monthly summaries and trends. Max 366 days.',
      inputSchema: {
        start_date: dateSchema.optional().describe('First day, YYYY-MM-DD. Defaults to 6 days before end_date.'),
        end_date: dateSchema.optional().describe('Last day, YYYY-MM-DD. Defaults to today.'),
      },
      annotations: { title: 'Activity over a date range', ...readOnly },
    },
    async ({ start_date, end_date }) => {
      beforeEachCall();
      const end = end_date || todayIn(timeZone);
      const start = start_date || addDays(end, -6);
      if (start > end) return error('start_date must be on or before end_date.');
      if (addDays(start, MAX_RANGE_DAYS - 1) < end) return error(`Range too long; max ${MAX_RANGE_DAYS} days.`);
      const rows = store.getRange(start, end).map(({ date, ...rec }) => presentDay(date, rec));
      return json({ start_date: start, end_date: end, summary: summarize(rows), days: rows });
    },
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Sync status',
      description:
        'When the iPhone last sent Health data, and which dates are on file. ' +
        'Use when numbers look stale or missing.',
      inputSchema: {},
      annotations: { title: 'Sync status', ...readOnly },
    },
    async () => {
      beforeEachCall();
      return json({ time_zone: timeZone || null, today: todayIn(timeZone), ...store.status() });
    },
  );

  return server;
}
