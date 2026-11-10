# iPhone Health → Claude connector

Lets Claude answer questions like *"How many steps did I take today?"*, *"How far did I walk this week?"* or *"How many calories did I burn yesterday?"* using data from the iPhone **Health** app.

It tracks, per day:

| Metric | From Health |
|---|---|
| Steps | Steps |
| Miles walked (also km) | Walking + Running Distance |
| Active calories | Active Energy |
| Resting calories | Resting Energy |
| Total calories burned | Active + Resting |

## How it works

Apple doesn't offer a cloud API for Health data; it only exists on your iPhone. So there are two parts:

```
 iPhone Health ──(Shortcut, runs on a schedule)──▶ POST /ingest ──▶ connector server ◀── /mcp/<secret> ── Claude
```

1. **An iOS Shortcut** reads today's totals from Health and sends them to your connector server.
2. **The connector server** (this folder) saves the daily totals and gives them to Claude as an MCP server, the format Claude custom connectors use.

Claude gets three read-only tools:

- `get_daily_activity`: one day (defaults to today)
- `get_activity_range`: day-by-day numbers for a date range, plus totals, daily averages and your best day
- `get_sync_status`: when the phone last synced

---

## Step 1: Run the server

You need Node 20.6+ and an HTTPS address Claude can reach.

```bash
cd health-connector
npm install
cp .env.example .env    # then fill it in, see below
```

Generate the secret and put it in `.env` as `CONNECTOR_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Set `HEALTH_TZ` to your time zone (for example `America/Chicago`) so "today" lines up with your phone.

**Pick a host** (it needs HTTPS):

- **Render / Railway / Fly.io:** deploy this folder with the included `Dockerfile`. Set `CONNECTOR_SECRET` and `HEALTH_TZ` as environment variables, and **attach a persistent disk mounted at `/data`**. Without a disk, your history is wiped every time the server restarts.
- **Your own computer:** run `node --env-file=.env src/http.js`, then expose it with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared tunnel --url http://localhost:8787`) or Tailscale Funnel. Syncing only works while that computer is on.

Check it's working: opening `https://YOUR-HOST/healthz` should show `{"ok":true,...}`.

## Step 2: Build the Shortcut on your iPhone

Open **Shortcuts** → **+** → name it **Sync Health to Claude**, then add these actions in order.

**Steps**
1. **Find Health Samples**: Type **Steps**, filter **Start Date is Today**, **Group By: Day**
2. **Calculate Statistics**: **Sum** of *Health Samples*
3. **Set Variable** `Steps` to *Statistics Result*

**Distance**

4. **Find Health Samples**: Type **Walking + Running Distance**, **Start Date is Today**, **Group By: Day**
5. **Calculate Statistics**: **Sum**
6. **Set Variable** `Distance`

**Calories**

7. **Find Health Samples**: Type **Active Energy**, **Start Date is Today**, **Group By: Day** → **Calculate Statistics: Sum** → **Set Variable** `Active`
8. **Find Health Samples**: Type **Resting Energy**, **Start Date is Today**, **Group By: Day** → **Calculate Statistics: Sum** → **Set Variable** `Resting`

**Date**

9. **Format Date**: *Current Date*, Date Format **Custom** → `yyyy-MM-dd`, then **Set Variable** `Day`

**Send it**

10. **Get Contents of URL**
    - URL: `https://YOUR-HOST/ingest`
    - Method: **POST**
    - Headers: `Authorization` = `Bearer YOUR-CONNECTOR-SECRET`
    - Request Body: **JSON** with these fields:

      | Key | Type | Value |
      |---|---|---|
      | `date` | Text | `Day` |
      | `steps` | Text | `Steps` |
      | `distance` | Text | `Distance` |
      | `distance_unit` | Text | `mi` (or `km` if Health shows kilometres) |
      | `active_calories` | Text | `Active` |
      | `resting_calories` | Text | `Resting` |

    The server accepts values like `8,421`, `3.2 mi` or `412 kcal`, so you don't need any number formatting.

Tap ▶ to run it once. iOS asks for permission to read each Health type; allow all of them. The response should say `"ok": true`.

**Check the numbers** against the Health app. If steps look about double, your iPhone and Apple Watch are both being counted. Fix it by adding a **Source is** filter to the Find Health Samples actions so they use just one device (usually the Watch).

### Make it run automatically

Shortcuts → **Automation** → **+** → **Time of Day**. Create a daily automation at **11:55 PM** that runs *Sync Health to Claude*, and choose **Run Immediately** (turn off *Notify When Run*). To keep today's numbers fresh, add a few more (for example 9 AM, 1 PM and 6 PM). Each run replaces that day's totals with the latest ones.

## Step 3: Add the connector to Claude

In Claude (web, desktop or mobile): **Settings → Connectors → Add custom connector**

- Name: `iPhone Health`
- URL: `https://YOUR-HOST/mcp/YOUR-CONNECTOR-SECRET`

Turn it on in a chat and ask *"How many steps have I taken today?"*

**Claude Code:**
```bash
claude mcp add --transport http iphone-health https://YOUR-HOST/mcp --header "Authorization: Bearer YOUR-CONNECTOR-SECRET"
```

**Claude Desktop, local only** (reads the data file directly, so it works offline with imported history). Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "iphone-health": {
      "command": "node",
      "args": ["/full/path/to/health-connector/src/stdio.js"],
      "env": { "HEALTH_DATA_FILE": "/full/path/to/health-connector/data/health.json", "HEALTH_TZ": "America/New_York" }
    }
  }
}
```

## Optional: import your past history

The Shortcut only sends data from the day you set it up onward. To load older days:

1. iPhone Health app → your profile picture → **Export All Health Data**, then AirDrop or save the zip to your computer and unzip it.
2. Run:
   ```bash
   node --env-file=.env scripts/import-health-export.js apple_health_export/export.xml --since 2026-01-01
   ```

The import doesn't overwrite days the Shortcut has already filled (add `--overwrite` to change that). The export holds raw samples from every device, so for each day the import keeps the device that recorded the most. That's close to the Health app's numbers but can differ slightly on days you switched between phone and Watch.

## Privacy and security

- This is health data. **Your connector URL contains the secret, so treat it like a password.** Anyone with it can read your activity numbers. If it leaks, change `CONNECTOR_SECRET`, then update the Shortcut and the Claude connector.
- Always use HTTPS. The server checks the secret with a constant-time comparison and rejects requests without it.
- Only the daily totals above are stored, in one JSON file (`HEALTH_DATA_FILE`). No raw samples, location or other Health data leave your phone.
- Claude's tools are read-only. Claude can't change or delete your data.

## Development

```bash
npm test        # unit tests plus an end-to-end MCP client test
```

| File | Purpose |
|---|---|
| `src/http.js` | HTTP server: `/ingest` for the Shortcut, `/mcp/<secret>` for Claude |
| `src/stdio.js` | Local stdio MCP server |
| `src/tools.js` | The MCP tools |
| `src/normalize.js` | Parses and cleans Shortcut input, unit conversion |
| `src/store.js` | JSON-file storage |
| `scripts/import-health-export.js` | Apple Health `export.xml` importer |
