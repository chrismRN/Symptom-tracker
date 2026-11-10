#!/usr/bin/env node
// Local MCP server over stdio, for Claude Desktop or Claude Code on the same
// machine as the data file (e.g. after importing an Apple Health export).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { HealthStore } from './store.js';
import { createMcpServer } from './tools.js';

const config = loadConfig();
const store = new HealthStore(config.dataFile);
// Re-read the file on each call so a running HTTP server or importer's writes show up.
const server = createMcpServer(store, { timeZone: config.timeZone, beforeEachCall: () => store.reload() });
await server.connect(new StdioServerTransport());
