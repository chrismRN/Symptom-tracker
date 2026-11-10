#!/usr/bin/env node
// Remote connector: one small HTTPS-fronted Node server that
//   1. receives daily totals from the iPhone Shortcut   (POST /ingest)
//   2. serves them to Claude as an MCP server           (/mcp/<secret>)
//
// Everything is guarded by CONNECTOR_SECRET. Put this behind HTTPS
// (Render, Railway, Fly.io, or a Cloudflare Tunnel) — never plain HTTP.

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { HealthStore } from './store.js';
import { createMcpServer } from './tools.js';
import { normalizePayload } from './normalize.js';

const MAX_BODY_BYTES = 1024 * 1024;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : req.headers['x-connector-secret'] || '';
}

export function createApp({ config, store }) {
  if (!config.secret || config.secret.length < 24) {
    throw new Error(
      'CONNECTOR_SECRET must be set to a random string of at least 24 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"',
    );
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (p === '/' || p === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'iphone-health-connector' });
      }

      // ---- iPhone Shortcut uploads -------------------------------------
      if (p === '/ingest') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
        if (!safeEqual(bearer(req), config.secret)) return sendJson(res, 401, { error: 'Bad or missing secret' });
        const body = await readJson(req);
        let days;
        try {
          days = normalizePayload(body, { timeZone: config.timeZone });
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        store.upsertDays(days, { source: 'shortcut' });
        return sendJson(res, 200, { ok: true, saved: days });
      }

      // ---- MCP endpoint for Claude ------------------------------------
      // Claude custom connectors take a URL, so the secret lives in the path:
      //   https://your-host/mcp/<CONNECTOR_SECRET>
      // Clients that can send headers may instead use /mcp + "Authorization: Bearer <secret>".
      const mcpMatch = /^\/mcp(?:\/([^/]+))?$/.exec(p);
      if (mcpMatch) {
        const supplied = mcpMatch[1] ? decodeURIComponent(mcpMatch[1]) : bearer(req);
        if (!safeEqual(supplied, config.secret)) return sendJson(res, 401, { error: 'Unauthorized' });

        if (req.method !== 'POST') {
          // Stateless server: no server-initiated streams or sessions to close.
          res.writeHead(405, { Allow: 'POST' }).end();
          return;
        }
        const body = await readJson(req);
        const server = createMcpServer(store, { timeZone: config.timeZone });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message });
      else res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const store = new HealthStore(config.dataFile);
  const app = createApp({ config, store });
  app.listen(config.port, config.host, () => {
    console.log(`iPhone Health connector listening on http://${config.host}:${config.port}`);
    console.log(`  Shortcut uploads → POST /ingest  (Authorization: Bearer <secret>)`);
    console.log(`  Claude connector → /mcp/<secret>`);
    console.log(`  Data file: ${config.dataFile}   Time zone: ${config.timeZone}`);
  });
}
