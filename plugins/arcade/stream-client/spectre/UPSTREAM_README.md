# SPECTRE — Global Intelligence & Threat Monitor

> Real-time OSINT dashboard for geopolitical monitoring, conflict tracking, natural disasters, strategic flight and satellite movements, strategic infrastructure, internet infrastructure disruptions, and GPS jamming.

---

<img width="1917" height="911" alt="image" src="https://github.com/user-attachments/assets/25f1fe81-7f04-433b-b9b7-096efdbc3f82" />


## Overview

SPECTRE is an open-source intelligence dashboard that fuses high-volume public data into a single operational view for monitoring conflicts, disasters, aerospace movement, critical infrastructure, and communications disruption.

All core capabilities run on free/public sources. No paid API keys are required for a full deployment.

For end users, SPECTRE provides:

- A real-time global map with layered intelligence overlays
- A severity-ranked OSINT feed
- Live military-focused flight tracking and satellite tracking
- Disaster/event awareness (USGS earthquakes + NASA EONET)
- GPS interference and internet outage monitoring
- Broadcast radio and public camera watch feeds
- Fast initial loading, near-real-time refresh, and persistent cache warm state

---

## Why SPECTRE in Operations

- **Single-pane awareness:** replace tab-hopping across news, maps, and tracking tools with one fused operational console.
- **Decision-priority ordering:** severity-ranked feeds and threat color coding push high-risk developments to the top first.
- **Rapid startup under pressure:** warm cache + two-phase load provide usable situational awareness fast after restart.
- **Resilient by design:** source failures degrade gracefully; one failing provider does not collapse the dashboard.
- **No paid lock-in:** core capability remains fully usable on free/public data sources.

---

## Features

### End-User Dashboard Capabilities

- **Unified operational map:** earthquakes, natural events, RSS/OSINT hotspots, GDELT conflict points, flights, satellites, GPS jamming cells, blackout alerts, military bases, and nuclear facilities in one interface.
- **Severity-first intelligence feed:** all OSINT items are classified (`critical` to `info`) and sorted by severity, with recency ordering inside each severity tier.
- **High-signal time policy:** Live OSINT Feed items require a valid published timestamp, and only items from the last 24 hours are retained.
- **Real-time experience:** SSE (`/api/stream`) pushes update events; frontend reloads data without manual refresh.
- **Fast boot UX:** two-phase loading (`/api/fast` then `/api/all`) makes the map usable quickly while heavier domains load in background.
- **Operator tools:** searchable/filterable news list, export options, weather radar overlay, geocode map jump, contextual map tools, and fullscreen support.

### Intelligence Domains and Cadence

| Domain | Source | Typical Refresh |
|---|---|---|
| RSS OSINT News | Curated global/security feeds in `config.py` | 5 min |
| Telegram OSINT | Direct `t.me/s/` scrape + RSShub fallback | 10 min |
| Conflict Events | GDELT 2.0 CSV export (CAMEO conflict filters) | 15 min |
| Seismic Activity | USGS M4.5+ weekly feed | 10 min |
| Natural Events | NASA EONET open events | 15 min |
| Military Flights | ADSB.lol `/v2/mil` (no key) | 5 min |
| Satellite Tracking | CelesTrak TLE + SGP4 propagation | 10 min |
| GPS Interference | GPSJam H3 data | 30 min |
| Internet Blackouts | IODA outage alerts | 10 min |
| Strategic Infrastructure | Military bases + nuclear facility datasets | static |
| Broadcast Radio | Curated MP3/HLS streams | static |
| Public Cameras | Curated regional camera/live feed index | static |

### Threat Classification

`classifier.py` tags each OSINT item with:

- **Severity:** `critical`, `high`, `medium`, `low`, `info`
- **Categories:** conflict, terrorism, cyber, disaster, political, health, economic, nuclear, maritime, aerospace
- **Color coding:** deterministic color map used directly in map markers and feed UI

### Reliability and Data Pipeline

- **Parallel prefetch on startup:** warms all major sources immediately.
- **Background scheduler:** continuously refreshes each domain on its own interval.
- **Stale-while-revalidate cache:** serves quickly from cache while refreshing in background.
- **Disk persistence:** `.spectre_cache.json` carries state across restarts for near-instant warm loads.
- **Graceful degradation:** any source may fail independently without taking down the app.

---

## First 60 Seconds (Operator Workflow)

1. Launch SPECTRE and open `http://localhost:5050`.
2. Confirm transport state in header (`LINK SECURE`) and watch status dots initialize.
3. Check the **DEFCON STATUS** badge and top severity counters.
4. Scan the map for high-signal overlays (news hotspots, blackouts, GPS jam cells, critical quakes).
5. Filter the OSINT feed by severity, then pivot to source links for verification.
6. Export current feed snapshot if you need to pass intelligence to another team.

---

## Tech Stack

**Backend**
- Python 3.12
- Flask + flask-cors (with ProxyFix support)
- `requests` + `urllib` for robust HTTP fetching
- `feedparser` for structured RSS ingestion
- `concurrent.futures.ThreadPoolExecutor` for high-concurrency pre-fetching
- `SSE` (Server-Sent Events) for real-time client synchronization

**Frontend**
- HTML5 / CSS3 (JetBrains Mono + Rajdhani typefaces)
- JavaScript ES6+ (Fetch API, EventSource)
- [Leaflet.js](https://leafletjs.com/) — interactive map with multi-layer overlays
- [HLS.js](https://github.com/video-dev/hls.js/) — live broadcast streaming
- [RainViewer](https://www.rainviewer.com/api.html) — real-time weather radar integration

**Data Sources (all free, no keys required)**
- [USGS Earthquake Hazards](https://earthquake.usgs.gov/earthquakes/feed/)
- [NASA EONET](https://eonet.gsfc.nasa.gov/)
- [GDELT Project 2.0](https://www.gdeltproject.org/)
- [ADSB.lol Military Feed](https://adsb.lol/)
- [GPSJam](https://gpsjam.org/)
- [CelesTrak](https://celestrak.org/)
- [IODA — Georgia Tech](https://ioda.inetintel.cc.gatech.edu/)
- Telegram public channels (Direct Scrape + RSShub)

---

## Project Structure

```
SPECTRE/
├── app.py            # Flask server — REST API, SSE stream, background scheduler
├── sources.py        # Intelligence fetchers, cache engine, geo-tagging, aerospace intelligence
├── classifier.py     # Keyword-based threat classifier (severity + categories)
├── config.py         # Feeds, Telegram channels, geo-hubs, broadcasts, cameras
├── military_bases.json # Global military installation coordinates
├── nuclear_facilities.json # Nuclear power and research site coordinates
├── requirements.txt  # Python dependencies
├── templates/
│   └── index.html    # Dashboard UI (Leaflet map, feed panels, HLS player)
└── .spectre_cache.json # Persistent disk cache
```

---

## Installation

**Requirements**: Python 3.10+ (3.12 recommended)

```bash
git clone https://github.com/osint-automated/SPECTRE.git
cd SPECTRE
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5050` in your browser.

---

## Deploy to Railway

Railway injects a `PORT` environment variable and expects your web process to bind `0.0.0.0:$PORT`.

This repo supports both:
- **Local**: `python app.py` (defaults to `0.0.0.0:5050`, override with `SPECTRE_PORT`)
- **Railway (recommended)**: Gunicorn (production server)

### Railway start command

Set your Railway **Start Command** to:

```bash
gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 0
```

Notes:
- **`--timeout 0`**: keeps long-lived SSE connections (`/api/stream`) from being killed.
- **`--workers 1`**: this app runs a background scheduler thread; multiple workers would start multiple schedulers.

### Production Hardening Checklist

- Run behind a production server (`gunicorn`) and reverse proxy.
- Set `SPECTRE_CORS_ORIGINS` to approved origins only (avoid wildcard CORS in production).
- Enable proxy header trust only when needed (`SPECTRE_BEHIND_PROXY=true` behind trusted proxy).
- Monitor logs for repeated upstream failures/timeouts (e.g., satellite providers, channel mirrors).
- Keep `.spectre_cache.json` writable by the runtime user for persistence across restarts.
- Run smoke/API tests in CI before deploy.

### Local Runtime Environment Variables

- `SPECTRE_HOST` (default: `0.0.0.0`)
- `SPECTRE_PORT` (default: `5050`)
- `SPECTRE_DEBUG` (default: `false`)
- `SPECTRE_BEHIND_PROXY` (default: `false`; enables ProxyFix for X-Forwarded headers)
- `SPECTRE_CORS_ORIGINS` (comma-separated list of allowed origins)
- `SPECTRE_HEALTH_VERBOSE` (default: `false`; adds cache keys to health check)

---

## API Reference

| Endpoint | Description |
|---|---|
| `GET /api/all` | Consolidated snapshot of all intelligence domains |
| `GET /api/fast` | Immediate-load path: quakes, events, risk, and static infrastructure |
| `GET /api/news` | RSS news feed with optional `severity` filtering |
| `GET /api/osint` | Combined RSS + Telegram feed with `tag` and `severity` support |
| `GET /api/gdelt` | GDELT 2.0 conflict events |
| `GET /api/flights` | Tracked aircraft; `interesting=true` for mil/gov only |
| `GET /api/satellites` | Strategic satellite positions (LEO/MEO/GEO) |
| `GET /api/gpsjam` | GPS interference data and threshold analysis |
| `GET /api/blackouts` | IODA internet disruption alerts |
| `GET /api/risk` | Dynamic country-level threat scoring |
| `GET /api/broadcasts` | International HLS radio stream index |
| `GET /api/cameras` | Public live feed index with regional filtering |
| `GET /api/wiki` | Coordinate-based Wikipedia geosearch |
| `GET /api/stream` | Server-Sent Events (SSE) stream for real-time updates |
| `GET /api/rainviewer` | Proxied weather radar metadata |
| `GET /api/health` | System health, feature flags, and cache status |

### Query Parameters (selected)

- `GET /api/news?severity=<critical|high|medium|low|info>&limit=<1-500>`
- `GET /api/osint?severity=<...>&tag=telegram`
- `GET /api/flights?interesting=true`
- `GET /api/cameras?region=<NEWS|URBAN|...>`
- `GET /api/wiki?lat=<float>&lon=<float>&radius=<meters>`

### Example

```bash
# All strategic flights
curl http://localhost:5050/api/flights?interesting=true

# Critical-severity news only
curl http://localhost:5050/api/news?severity=critical&limit=20

# GDELT conflict events
curl http://localhost:5050/api/gdelt
```

### Example Production Smoke Checks

```bash
# Health + key domains
curl http://localhost:5050/api/health
curl http://localhost:5050/api/fast
curl http://localhost:5050/api/all

# Verify stream endpoint responds (SSE)
curl -N http://localhost:5050/api/stream
```

---

## Configuration

All feed lists and static data are defined in `config.py`:

- **`RSS_FEEDS`** — list of `(label, url, tier)` tuples for RSS sources
- **`RSSHUB_FEEDS`** — list of `(label, rsshub_path, tier)` for Telegram OSINT channels
- **`GEO_HUBS`** — keyword-to-coordinate mapping used to geo-tag articles that lack native location data
- **`COUNTRY_RISK`** — baseline country risk configuration
- **`BROADCAST_STREAMS`** — HLS stream URLs for live international broadcasts
- **`PUBLIC_CAMERAS`** — curated public webcam/live feed metadata

To add a new RSS source, append a tuple to `RSS_FEEDS`. To add a Telegram channel, append to `RSSHUB_FEEDS` using the format `https://rsshub.app/telegram/channel/<channel_name>`.

---

## Telegram Channel Fetching

SPECTRE uses a two-tier fallback strategy per channel:

1. **Primary**: Direct scrape of `t.me/s/<channel>` — Telegram's own public web preview. No third party, no rate limits, capped at 256 KB per channel.
2. **Fallback**: If the scrape returns no posts, four RSShub instances are raced concurrently; the first to return entries wins.

If both methods fail, the failure is logged and the channel is skipped gracefully.

---

## Data Quality Rules

- RSS and Telegram/RSShub entries must have a valid `published` timestamp.
- Items older than 24 hours are discarded for those OSINT feeds.
- Dashboard time rendering for OSINT items uses source `published` time only.
- Missing/invalid timestamps are skipped rather than backfilled with client or server "now".

---

## Notes

- No API keys are required. SPECTRE is designed to run entirely on free public data.
- ADSB.lol unauthenticated access is rate-limited. SPECTRE applies pacing + retries to stay stable under public limits.
- GDELT data is fetched from the public CDN (`data.gdeltproject.org`) via the `lastupdate.txt` manifest, which points to the most recent 15-minute export ZIP. This method bypasses the DOC 2.0 query API and has no rate limits.
- The `.spectre_cache.json` file persists between restarts. Delete it to force a full cold fetch on next boot.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

This project is intended for educational and open-source intelligence research purposes. All data is sourced from publicly accessible APIs and feeds. Respect the terms of service of each upstream data provider.
