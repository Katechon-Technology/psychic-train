"""
SPECTRE — Global Intelligence & Threat Monitor
Flask server: serves the dashboard and JSON API endpoints.

All data comes from free, publicly accessible sources only.
Run with:  python app.py
"""

import json
import logging
import queue
import threading
import time
import os
import urllib.error
import urllib.request
from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

import sources
from config import RSS_FEEDS, RSSHUB_FEEDS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)
GPSJAM_HIGH_THRESHOLD = sources.HIGH_JAM_THRESHOLD

app = Flask(__name__)
if os.getenv("SPECTRE_BEHIND_PROXY", "").strip().lower() in {"1", "true", "yes", "on"}:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    logger.info("ProxyFix enabled (SPECTRE_BEHIND_PROXY)")

_cors_origins_raw = os.getenv("SPECTRE_CORS_ORIGINS", "").strip()
if _cors_origins_raw:
    cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]
    CORS(app, resources={r"/api/*": {"origins": cors_origins}})
    logger.info("CORS restricted to %d configured origins", len(cors_origins))
else:
    CORS(app)
    logger.info("CORS allow-all enabled (set SPECTRE_CORS_ORIGINS to restrict)")


def _parse_int_arg(name: str, default: int, min_value: int = None, max_value: int = None):
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid integer for '{name}'")
    if min_value is not None and value < min_value:
        raise ValueError(f"'{name}' must be >= {min_value}")
    if max_value is not None and value > max_value:
        raise ValueError(f"'{name}' must be <= {max_value}")
    return value


def _parse_float_arg(name: str, default: float, min_value: float = None, max_value: float = None):
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid number for '{name}'")
    if min_value is not None and value < min_value:
        raise ValueError(f"'{name}' must be >= {min_value}")
    if max_value is not None and value > max_value:
        raise ValueError(f"'{name}' must be <= {max_value}")
    return value

# ── Background pre-fetch so first request is fast ────────────────────────────
def _prefetch():
    """Warm all caches concurrently on startup."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    tasks = {
        "translation_models": sources.preinstall_translation_models,
        "earthquakes": sources.get_earthquakes,
        "eonet":       sources.get_eonet_events,
        "news":        sources.get_news,
        "gdelt":       sources.get_gdelt,
        "flights":     sources.get_flights,
        "satellites":  sources.get_satellites,
        "blackouts":   sources.get_blackouts,
        "gpsjam":      sources.get_gpsjam,
        "tg_osint":    sources.get_rsshub_news,
    }
    logger.info("Pre-fetching %d sources in parallel...", len(tasks))
    t0 = time.time()
    try:
        with ThreadPoolExecutor(max_workers=len(tasks)) as ex:
            futures = {ex.submit(fn): name for name, fn in tasks.items()}
            for fut in as_completed(futures):
                name = futures[fut]
                try:
                    fut.result()
                    logger.info("  ✓ %s (%.1fs)", name, time.time() - t0)
                except Exception as exc:
                    logger.warning("  ✗ %s failed: %s", name, exc)
    except RuntimeError as exc:
        # Can happen in short-lived processes during interpreter shutdown.
        logger.info("Pre-fetch skipped: %s", exc)
        return
    logger.info("Pre-fetch complete in %.1fs", time.time() - t0)


_sse_clients = []
_sse_clients_lock = threading.Lock()
_bg_started = False
_bg_started_lock = threading.Lock()


def _broadcast_event(event: str, payload: dict):
    message = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
    dead = []
    with _sse_clients_lock:
        for q in _sse_clients:
            try:
                q.put_nowait(message)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in _sse_clients:
                _sse_clients.remove(q)


def _run_scheduler():
    """
    Periodically refresh sources so data stays warm even with no active clients.
    """
    schedule = [
        ("news", 300, sources.get_news),
        ("flights", 300, sources.get_flights),
        ("satellites", 600, sources.get_satellites),
        ("earthquakes", 600, sources.get_earthquakes),
        ("blackouts", 600, sources.get_blackouts),
        ("gpsjam", 1800, sources.get_gpsjam),
        ("eonet", 900, sources.get_eonet_events),
        ("gdelt", 900, sources.get_gdelt),
    ]
    next_run = {name: 0.0 for name, _, _ in schedule}
    logger.info("Background scheduler started for %d sources", len(schedule))
    while True:
        now = time.time()
        ran_any = False
        for name, every_s, fn in schedule:
            if now >= next_run[name]:
                t0 = time.time()
                try:
                    fn()
                    logger.info("Scheduler refresh ok [%s] in %.1fs", name, time.time() - t0)
                except Exception as exc:
                    logger.warning("Scheduler refresh failed [%s]: %s", name, exc)
                next_run[name] = now + every_s
                ran_any = True
        if ran_any:
            _broadcast_event("data_updated", {"ts": int(time.time())})
        time.sleep(2)


def _start_background_services():
    global _bg_started
    with _bg_started_lock:
        if _bg_started:
            return
        _bg_started = True
    threading.Thread(target=_prefetch, daemon=True).start()
    threading.Thread(target=_run_scheduler, daemon=True).start()


@app.before_request
def _ensure_background_services_started():
    _start_background_services()


@app.after_request
def _security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    return response


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template(
        "index.html",
        rss_feed_count=len(RSS_FEEDS),
        tg_feed_count=len(RSSHUB_FEEDS),
    )


@app.route("/api/news")
def api_news():
    try:
        limit = _parse_int_arg("limit", 100, 1, 500)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    severity = request.args.get("severity")   # optional filter
    data = sources.get_news() or []
    if severity:
        data = [a for a in data if a.get("severity") == severity]
    return jsonify(data[:limit])


@app.route("/api/earthquakes")
def api_earthquakes():
    return jsonify(sources.get_earthquakes() or [])


@app.route("/api/events")
def api_events():
    return jsonify(sources.get_eonet_events() or [])


@app.route("/api/gdelt")
def api_gdelt():
    return jsonify(sources.get_gdelt() or [])


@app.route("/api/flights")
def api_flights():
    interesting_only = request.args.get("interesting") == "true"
    data = sources.get_flights() or []
    if interesting_only:
        data = [f for f in data if f.get("interesting")]
    return jsonify(data)


@app.route("/api/satellites")
def api_satellites():
    return jsonify(sources.get_satellites() or [])


@app.route("/api/risk")
def api_risk():
    news = sources.get_news() or []
    return jsonify(sources.get_country_risk(news))


@app.route("/api/summary")
def api_summary():
    news       = sources.get_news() or []
    quakes     = sources.get_earthquakes() or []
    events     = sources.get_eonet_events() or []
    flights    = sources.get_flights() or []
    return jsonify(sources.get_summary_stats(news, quakes, events, flights))


@app.route("/api/fast")
def api_fast():
    """
    Returns only the fast-loading, always-cached sources.
    Called first by the dashboard so the map renders immediately,
    before the slower sources (news, GDELT, flights) finish.
    """
    quakes = sources.get_earthquakes() or []
    events = sources.get_eonet_events() or []
    risk   = sources.get_country_risk([])
    bases    = sources.get_military_bases()
    nuclear  = sources.get_nuclear_facilities()
    return jsonify({
        "earthquakes":       quakes,
        "events":            events,
        "risk":              risk,
        "military_bases":    bases,
        "nuclear_facilities": nuclear,
    })


@app.route("/api/all")
def api_all():
    """Single endpoint returning everything — used by the dashboard on load."""
    news       = sources.get_all_osint() or []
    quakes     = sources.get_earthquakes() or []
    events     = sources.get_eonet_events() or []
    flights    = sources.get_flights() or []
    risk       = sources.get_country_risk(news)
    summary    = sources.get_summary_stats(news, quakes, events, flights)
    gdelt      = sources.get_gdelt() or []
    blackouts  = sources.get_blackouts() or []
    gpsjam     = sources.get_gpsjam() or []
    satellites = sources.get_satellites() or []
    mil_bases  = sources.get_military_bases()
    nuclear    = sources.get_nuclear_facilities()

    return jsonify({
        "news":               news,
        "earthquakes":        quakes,
        "events":             events,
        "flights":            flights,
        "risk":               risk,
        "summary":            summary,
        "gdelt":              gdelt,
        "blackouts":          blackouts,
        "gpsjam":             gpsjam,
        "satellites":         satellites,
        "military_bases":     mil_bases,
        "nuclear_facilities": nuclear,
    })




@app.route("/api/blackouts")
def api_blackouts():
    """Internet outage data from IODA (Georgia Tech, free)."""
    return jsonify(sources.get_blackouts() or [])


@app.route("/api/gpsjam")
def api_gpsjam():
    return jsonify({
        "status": "ok",
        "threshold": GPSJAM_HIGH_THRESHOLD,
        "data": sources.get_gpsjam() or [],
    })


@app.route("/api/broadcasts")
def api_broadcasts():
    """Free internet radio stream list."""
    return jsonify(sources.get_broadcasts())


@app.route("/api/cameras")
def api_cameras():
    """Curated public live feed / webcam list."""
    region = request.args.get("region")  # optional: NEWS, URBAN, etc.
    data = sources.get_cameras()
    if region:
        data = [c for c in data if c.get("region") == region.upper()]
    return jsonify(data)


@app.route("/api/osint")
def api_osint():
    """Combined RSS + Telegram OSINT feed."""
    severity = request.args.get("severity")
    tag      = request.args.get("tag")        # e.g. "telegram"
    data     = sources.get_all_osint() or []
    if severity:
        data = [a for a in data if a.get("severity") == severity]
    if tag:
        data = [a for a in data if tag in (a.get("tags") or [])]
    return jsonify(data)


@app.route("/api/wiki")
def api_wiki():
    try:
        lat = _parse_float_arg("lat", 0.0, -90.0, 90.0)
        lon = _parse_float_arg("lon", 0.0, -180.0, 180.0)
        radius = _parse_int_arg("radius", 10000, 1, 100000)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(sources.get_wiki_geosearch(lat, lon, radius))


@app.route("/api/rainviewer")
def api_rainviewer():
    """
    Proxy https://api.rainviewer.com/public/weather-maps.json for the dashboard
    (same-origin; tiles still load from tilecache.rainviewer.com).
    """
    url = "https://api.rainviewer.com/public/weather-maps.json"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "SPECTRE-OSINT/2.0 (dashboard)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return jsonify(data)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        logger.warning("RainViewer proxy failed: %s", exc)
        return jsonify({"error": str(exc)}), 502


@app.route("/api/stream")
def api_stream():
    """
    Server-Sent Events stream used by the dashboard to trigger immediate reloads.
    """
    client_q = queue.Queue(maxsize=20)
    with _sse_clients_lock:
        _sse_clients.append(client_q)

    def _gen():
        # Initial hello lets the browser confirm the stream is alive.
        yield f"event: hello\ndata: {json.dumps({'status': 'ok'})}\n\n"
        try:
            while True:
                try:
                    msg = client_q.get(timeout=20)
                    yield msg
                except queue.Empty:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            with _sse_clients_lock:
                if client_q in _sse_clients:
                    _sse_clients.remove(client_q)

    return Response(
        stream_with_context(_gen()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Health check ──────────────────────────────────────────────────────────────
@app.route("/api/health")
def health():
    import sources as s
    payload = {
        "status": "ok",
        "new_features": ["blackouts", "broadcasts", "cameras", "osint_telegram",
                         "gdelt_csv", "adsb_mil_flights", "celestrak_satellites"],
    }
    if os.getenv("SPECTRE_HEALTH_VERBOSE", "").strip().lower() in {"1", "true", "yes", "on"}:
        payload["cache_keys"] = list(s._cache.keys())
    return jsonify(payload)


if __name__ == "__main__":
    host = os.getenv("SPECTRE_HOST", "0.0.0.0")
    # Default 5050: port 5000 is often already taken (other dev tools / stale servers)
    # and may respond with errors; override with SPECTRE_PORT=5000 if you need it.
    port = int(os.getenv("PORT") or os.getenv("SPECTRE_PORT", "5050"))
    debug = os.getenv("SPECTRE_DEBUG", "false").strip().lower() in {"1", "true", "yes", "on"}
    _start_background_services()
    app.run(host=host, port=port, debug=debug)