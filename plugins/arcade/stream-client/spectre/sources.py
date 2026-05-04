"""
Data source fetchers — all 100% free, no API keys required
(Optional env vars for NASA FIRMS and OpenSky enhance some feeds)
"""

import os
import json
import time
import random
import logging
import hashlib
import threading
import re
import csv
import io
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional, Any

import requests
import feedparser
try:
    from sgp4.api import Satrec, jday  # type: ignore[reportMissingImports]
except ImportError:  # optional: rest of app works without satellite propagation
    Satrec = None  # type: ignore[misc, assignment]
    jday = None  # type: ignore[misc, assignment]
try:
    import h3  # type: ignore[reportMissingImports]
except Exception:  # optional dependency for H3 centroid conversion
    h3 = None

from config import (
    RSS_FEEDS, GEO_HUBS, COUNTRY_RISK,
    RSSHUB_FEEDS, BROADCAST_STREAMS, PUBLIC_CAMERAS,
)
from classifier import classify
from translation import preinstall_argos_models, translate_if_needed

logger = logging.getLogger(__name__)

# ── Disk-backed in-process cache ──────────────────────────────────────────────
# On first boot: loads any existing disk cache so data is served instantly.
# On every successful fetch: saves updated cache to disk.
# Effect: after the very first boot, every subsequent restart is instant.

_CACHE_FILE = os.path.join(os.path.dirname(__file__), ".spectre_cache.json")

_cache:         Dict[str, Any]   = {}
_cache_ts:      Dict[str, float] = {}
_cache_refreshing: set           = set()
_cache_lock     = threading.Lock()
_cache_file_lock = threading.Lock()


def _load_disk_cache() -> None:
    """Load persisted cache from disk on startup. Non-fatal if missing."""
    try:
        if not os.path.exists(_CACHE_FILE):
            return
        with open(_CACHE_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        loaded = 0
        for key, entry in saved.items():
            _cache[key]    = entry["data"]
            # Mark as stale (age = ttl + 1) so background refresh fires
            # immediately, but data is served instantly from cache.
            _cache_ts[key] = entry.get("ts", 0)
            loaded += 1
        logger.info("Disk cache loaded: %d keys from %s", loaded, _CACHE_FILE)
    except Exception as exc:
        logger.warning("Disk cache load failed (non-fatal): %s", exc)


def _save_disk_cache() -> None:
    """Persist current cache to disk. Called after every successful fetch."""
    try:
        # Snapshot under _cache_lock so concurrent writers can't mutate the
        # dict mid-iteration; then do the (slower) file write under the
        # file lock.
        with _cache_lock:
            payload = {
                key: {"data": value, "ts": _cache_ts.get(key, 0)}
                for key, value in _cache.items()
                if value is not None
            }
        with _cache_file_lock:
            tmp = _CACHE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, default=str)
            os.replace(tmp, _CACHE_FILE)
    except Exception as exc:
        logger.warning("Disk cache save failed (non-fatal): %s", exc)


# Load disk cache immediately on module import
_load_disk_cache()


def _cached(key: str, ttl: int, fn, *args, **kwargs):
    """
    Stale-while-revalidate cache with disk persistence.
    - Fresh data  → return immediately
    - Stale data  → return immediately + background refresh
    - No data     → block once, then cache + save to disk
    """
    now = time.time()
    with _cache_lock:
        age = now - _cache_ts.get(key, 0)
        has = key in _cache

    if has and age < ttl:
        return _cache[key]                          # fresh

    if has and age >= ttl:
        # Stale — serve immediately, refresh in background
        with _cache_lock:
            if key not in _cache_refreshing:
                _cache_refreshing.add(key)
                def _bg(k=key, f=fn, a=args, kw=kwargs):
                    try:
                        result = f(*a, **kw)
                        with _cache_lock:
                            _cache[k]    = result
                            _cache_ts[k] = time.time()
                        _save_disk_cache()
                    except Exception as exc:
                        logger.warning("Background refresh failed [%s]: %s", k, exc)
                    finally:
                        with _cache_lock:
                            _cache_refreshing.discard(k)
                threading.Thread(target=_bg, daemon=True).start()
        return _cache[key]                          # stale but immediate

    # Nothing cached — must block once
    try:
        result = fn(*args, **kwargs)
        with _cache_lock:
            _cache[key]    = result
            _cache_ts[key] = time.time()
        _save_disk_cache()
        return result
    except Exception as exc:
        logger.warning("Source fetch failed [%s]: %s", key, exc)
        return _cache.get(key)


# ── Helpers ───────────────────────────────────────────────────────────────────
HEADERS = {
    "User-Agent": (
        "SPECTRE-OSINT/2.0 (Global Intelligence Dashboard; "
        "https://github.com/osint-automated/SPECTRE)"
    )
}

# GPSJAM legend: High interference is >10%
HIGH_JAM_THRESHOLD = 0.10


def _get(url: str, timeout: int = 6, params: dict = None) -> dict:
    r = requests.get(url, timeout=timeout, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()


def _coerce_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _read_first_float(row: Dict[str, Any], keys: List[str]) -> Optional[float]:
    for key in keys:
        if key in row:
            parsed = _coerce_float(row.get(key))
            if parsed is not None:
                return parsed
    return None


def _read_first_str(row: Dict[str, Any], keys: List[str]) -> str:
    for key in keys:
        if key in row:
            value = str(row.get(key, "")).strip()
            if value:
                return value
    return ""


def _fetch_gpsjam_for_date(target_date: datetime) -> Optional[List[Dict]]:
    date_str = target_date.strftime("%Y-%m-%d")
    url = f"https://gpsjam.org/data/{date_str}-h3_4.csv"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        logger.warning("GPSJAM timeout for %s", date_str)
        return None
    except Exception as exc:
        logger.warning("GPSJAM fetch failed [%s]: %s", date_str, exc)
        return None

    rows: List[Dict] = []
    ts_iso = target_date.replace(tzinfo=timezone.utc).isoformat()

    try:
        reader = csv.DictReader(io.StringIO(resp.text))
        for row in reader:
            if not isinstance(row, dict):
                continue
            h3_idx = _read_first_str(row, ["h3", "h3_index", "h3id", "cell", "hex"])
            if not h3_idx:
                continue

            # gpsjam.org CSV fields: hex,count_good_aircraft,count_bad_aircraft
            good = _read_first_float(row, ["count_good_aircraft", "good", "count_good"])
            bad = _read_first_float(row, ["count_bad_aircraft", "bad", "count_bad"])
            if good is None or bad is None:
                # Fallback for alternate schemas that directly provide percent.
                percent = _read_first_float(
                    row,
                    ["percent", "pct", "value", "interference_percent", "degraded_pct", "gps_jam_percent"],
                )
                if percent is None:
                    continue
                intensity = percent / 100.0 if percent > 1.0 else percent
            else:
                total = good + bad
                if total <= 0:
                    continue
                intensity = bad / total

            if intensity <= HIGH_JAM_THRESHOLD:
                continue

            lat = _read_first_float(row, ["lat", "latitude", "center_lat"])
            lon = _read_first_float(row, ["lon", "lng", "longitude", "center_lon", "center_lng"])
            if (lat is None or lon is None) and h3 is not None:
                try:
                    lat, lon = h3.cell_to_latlng(h3_idx)
                except Exception:
                    lat, lon = None, None
            if lat is None or lon is None:
                continue

            rows.append({
                "h3": h3_idx,
                "lat": lat,
                "lon": lon,
                "intensity": max(0.0, min(1.0, intensity)),
                "timestamp": ts_iso,
                "source": "gpsjam",
            })
    except Exception as exc:
        logger.warning("GPSJAM parse failed [%s]: %s", date_str, exc)
        return []

    return rows


def _fetch_gpsjam() -> List[Dict]:
    """
    GPSJAM publishes previous-day snapshots. Try today first, then fallback
    to previous day if today's file is missing or unavailable.
    """
    today_utc = datetime.now(timezone.utc).date()
    # GPSJAM can lag by >1 day; check a short rolling window.
    for delta_days in range(0, 4):
        day = today_utc - timedelta(days=delta_days)
        records = _fetch_gpsjam_for_date(datetime(day.year, day.month, day.day, tzinfo=timezone.utc))
        if records is not None:
            return records
    return []


def get_gpsjam() -> List[Dict]:
    # Refresh twice daily; stale-while-revalidate keeps responses fast.
    return _cached("gpsjam", 43200, _fetch_gpsjam) or []


# ── Pre-compiled geo_tag lookup ───────────────────────────────────────────────
# Build a flat {keyword: hub} dict once at import time.
# _geo_tag drops from O(hubs * keywords) per call to O(words_in_text).
_KW_TO_HUB: Dict[str, Dict] = {}
for _hub in GEO_HUBS:
    for _kw in _hub["keywords"]:
        # Longer / higher-priority keywords win
        if _kw not in _KW_TO_HUB or _hub["priority"] > _KW_TO_HUB[_kw]["priority"]:
            _KW_TO_HUB[_kw] = _hub


def _geo_tag(text: str) -> Optional[dict]:
    """Return {lat, lon, location} for the best keyword match in text."""
    text_lower = text.lower()
    best: Optional[dict] = None
    best_score = 0
    for kw, hub in _KW_TO_HUB.items():
        if kw in text_lower:
            score = hub["priority"]
            if score > best_score:
                best_score = score
                best = hub
    if best:
        jitter = 0.25
        return {
            "lat":      round(best["lat"] + random.uniform(-jitter, jitter), 4),
            "lon":      round(best["lon"] + random.uniform(-jitter, jitter), 4),
            "location": best["name"],
        }
    return None


def _article_id(url: str, title: str) -> str:
    return hashlib.md5(f"{url}{title}".encode()).hexdigest()[:12]


def _translate_cached(text: str) -> tuple[str, Optional[str]]:
    """
    Translate text with persistent cache.
    Cache key is content hash so identical items are translated only once.
    """
    if not text:
        return text, None
    key = f"translate:{hashlib.md5(text.encode('utf-8', errors='ignore')).hexdigest()}"
    with _cache_lock:
        cached = _cache.get(key)
        if isinstance(cached, dict) and "text" in cached:
            return cached.get("text", text), cached.get("original_lang")

    translated, original_lang = translate_if_needed(text)
    payload = {"text": translated, "original_lang": original_lang}
    with _cache_lock:
        _cache[key] = payload
        _cache_ts[key] = time.time()
    _save_disk_cache()
    return translated, original_lang


def _translate_title_summary(title: str, summary: str) -> tuple[str, str, Optional[str]]:
    clean_title = re.sub(r"\s+", " ", (title or "")).strip()[:240]
    clean_summary = re.sub(r"<[^>]+>", " ", (summary or ""))
    clean_summary = re.sub(r"\s+", " ", clean_summary).strip()[:700]
    combined = f"{clean_title}\n\n{clean_summary}".strip()
    if not combined:
        return title, summary, None
    translated, original_lang = _translate_cached(combined)
    if translated == combined:
        return title, summary, original_lang
    if "\n\n" in translated:
        new_title, new_summary = translated.split("\n\n", 1)
        return new_title.strip() or title, new_summary.strip() or summary, original_lang
    return translated.strip() or title, summary, original_lang


def preinstall_translation_models() -> None:
    """Best-effort startup install for translation models."""
    preinstall_argos_models()


def _parse_date(entry) -> str:
    """
    Return ISO timestamp from feedparser entry.
    If no reliable published date is available, return empty string so callers
    can safely skip the item instead of defaulting to "now".
    """
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        try:
            dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            return dt.isoformat()
        except Exception:
            return ""
    # No published_parsed → treat as missing date
    return ""


# ── 1. RSS News ───────────────────────────────────────────────────────────────
_RSS_FETCH_TIMEOUT  = 5   # seconds per feed (connect + read)
_RSS_FUTURE_TIMEOUT = 8   # backstop: abandon a worker after this many seconds

def _fetch_single_feed(label: str, url: str, tier: int, cutoff) -> List[Dict]:
    """
    Fetch one RSS feed with a hard timeout.
    Uses requests (which respects timeout) to download the content,
    then feedparser to parse it — feedparser.parse(url) has NO timeout.
    """
    results = []
    try:
        r = requests.get(
            url,
            timeout=_RSS_FETCH_TIMEOUT,
            headers=HEADERS,
            allow_redirects=True,
        )
        r.raise_for_status()
        # Pass raw bytes; feedparser detects encoding automatically
        feed = feedparser.parse(r.content)
    except requests.exceptions.Timeout:
        logger.debug("RSS timeout [%s]", label)
        return []
    except Exception as exc:
        logger.debug("RSS feed error [%s]: %s", label, exc)
        return []

    for entry in feed.entries:
        title   = getattr(entry, "title", "").strip()
        link    = getattr(entry, "link", "")
        summary = getattr(entry, "summary", "")[:400]
        if not title:
            continue

        pub = _parse_date(entry)
        if not pub:
            # No trustworthy published date → skip entirely
            continue
        try:
            dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            if dt < cutoff:
                continue
        except Exception:
            pass

        title, summary, original_lang = _translate_title_summary(title, summary)
        threat = classify(title, summary)
        geo    = _geo_tag(f"{title} {summary}")

        results.append({
            "id":        _article_id(link, title),
            "title":     title,
            "url":       link,
            "source":    label,
            "tier":      tier,
            "published": pub,
            "summary":   summary,
            "original_lang": original_lang,
            "geo":       geo,
            **threat,
        })
    return results


def _fetch_rss() -> List[Dict]:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # Only keep items from the last 24 hours.
    cutoff   = datetime.now(timezone.utc) - timedelta(hours=24)
    articles = []
    seen_ids = set()

    # One worker per feed — all 47 fire simultaneously.
    # _RSS_FUTURE_TIMEOUT backstop ensures no future ever stalls the pool.
    with ThreadPoolExecutor(max_workers=len(RSS_FEEDS)) as ex:
        futures = {
            ex.submit(_fetch_single_feed, label, url, tier, cutoff): label
            for label, url, tier in RSS_FEEDS
        }
        for fut in as_completed(futures):
            try:
                for art in fut.result(timeout=_RSS_FUTURE_TIMEOUT):
                    if art["id"] not in seen_ids:
                        seen_ids.add(art["id"])
                        articles.append(art)
            except Exception as exc:
                logger.debug("RSS future error [%s]: %s", futures[fut], exc)

    articles.sort(key=lambda a: a["severity_score"], reverse=True)
    return articles


def get_news(force=False) -> List[Dict]:
    return _cached("news", 300, _fetch_rss)


def _fetch_rsshub() -> List[Dict]:
    """
    Pull public Telegram OSINT channels.

    Strategy (tried in order per channel):
      1. Direct t.me/s/<channel> scrape  — Telegram's own public web preview,
         no third party, no API key, most reliable.
      2. rsshub.app                      — popular public instance, often rate-limited.
      3. Alternative rsshub mirrors      — community-run instances.

    Errors are logged at WARNING so they're visible in production logs.
    """
    from html.parser import HTMLParser

    # Only keep Telegram/RSShub items from the last 24 hours.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    # ── Lightweight t.me/s/ HTML scraper ─────────────────────────────────────
    class _TmeScraper(HTMLParser):
        """Extract post text + links from t.me/s/<channel> page."""
        def __init__(self):
            super().__init__()
            self.posts = []          # list of {"text": str, "url": str, "ts": str}
            self._in_text = False
            self._cur: dict = {}
            self._buf = []

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            cls = a.get("class", "")
            if tag == "div" and "tgme_widget_message_text" in cls:
                self._in_text = True
                self._buf = []
                self._cur = {}
            if tag == "a" and "tgme_widget_message_date" in cls:
                self._cur["url"] = a.get("href", "")
            if tag == "time":
                self._cur["ts"] = a.get("datetime", "")
            if tag == "br":
                self._buf.append(" ")

        def handle_endtag(self, tag):
            if tag == "div" and self._in_text:
                self._in_text = False
                text = "".join(self._buf).strip()
                if text:
                    self._cur["text"] = text
                    self.posts.append(dict(self._cur))
                self._cur = {}
                self._buf = []

        def handle_data(self, data):
            if self._in_text:
                self._buf.append(data)

    def _scrape_tme(channel_name: str) -> list:
        """Return list of raw post dicts from t.me/s/<channel>.
        Streams and caps at 256 KB — avoids downloading embedded media metadata."""
        url = f"https://t.me/s/{channel_name}"
        try:
            with requests.get(url, headers={
                **HEADERS, "Accept": "text/html",
                "Accept-Encoding": "gzip, deflate",
            }, timeout=8, stream=True, allow_redirects=True) as resp:
                if resp.status_code != 200:
                    logger.warning("t.me scrape HTTP %s for %s",
                                   resp.status_code, channel_name)
                    return []
                chunks, total = [], 0
                for chunk in resp.iter_content(chunk_size=16384):
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= 262144:  # 256 KB cap
                        break
            p = _TmeScraper()
            p.feed(b"".join(chunks).decode("utf-8", errors="replace"))
            return p.posts
        except Exception as exc:
            logger.warning("t.me scrape failed [%s]: %s", channel_name, exc)
            return []

    # ── rsshub fallback instances ─────────────────────────────────────────────
    _RSSHUB_INSTANCES = [
        "https://rsshub.app",
        "https://rsshub.rssforever.com",
        "https://hub.slarker.me",
        "https://rsshub.aikabox.com",
    ]

    def _try_rsshub(channel_name: str) -> list:
        """Race all rsshub instances concurrently — take first with entries."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        def _try_one(base):
            url = f"{base}/telegram/channel/{channel_name}"
            try:
                r = requests.get(url, timeout=5, headers=HEADERS)
                r.raise_for_status()
                feed = feedparser.parse(r.content)
                return feed.entries if feed.entries else []
            except Exception:
                return []

        with ThreadPoolExecutor(max_workers=len(_RSSHUB_INSTANCES)) as ex:
            futs = {ex.submit(_try_one, base): base for base in _RSSHUB_INSTANCES}
            for fut in as_completed(futs):
                entries = fut.result()
                if entries:
                    logger.debug("rsshub OK via %s for %s", futs[fut], channel_name)
                    return entries
        return []

    # ── Per-channel name extraction from RSSHUB_FEEDS config ──────────────────
    import re as _re
    def _channel_name(rsshub_url: str) -> str:
        m = _re.search(r"/telegram/channel/(\w+)", rsshub_url)
        return m.group(1) if m else ""

    def _fetch_one_channel(label: str, rsshub_url: str, tier: int) -> tuple[List[Dict], str]:
        """Fetch a single Telegram channel. Returns (articles, channel_name)."""
        channel = _channel_name(rsshub_url)
        if not channel:
            return [], ""
        results = []
        fetched = 0

        posts = _scrape_tme(channel)
        if posts:
            for post in posts:
                text = post.get("text", "").strip()
                url  = post.get("url", f"https://t.me/{channel}")
                ts   = post.get("ts", "")
                if not text:
                    continue
                # Require a valid published timestamp; skip if missing or invalid.
                if not ts:
                    continue
                try:
                    pub = datetime.fromisoformat(ts.replace("Z", "+00:00")).isoformat()
                except Exception:
                    continue
                try:
                    dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
                    if dt < cutoff:
                        continue
                except Exception:
                    pass
                translated_text, original_lang = _translate_cached(text)
                aid = _article_id(url, translated_text[:80])
                threat = classify(translated_text[:200])
                geo    = _geo_tag(translated_text)
                results.append({
                    "id": aid, "title": translated_text[:120], "url": url,
                    "source": label, "tier": tier, "published": pub,
                    "summary": translated_text[:400], "original_lang": original_lang, "geo": geo,
                    "tags": ["telegram", "osint"], **threat,
                })
                fetched += 1

        if fetched == 0:
            logger.debug("t.me scrape empty for %s — trying rsshub fallback", channel)
            entries = _try_rsshub(channel)
            for entry in entries:
                title   = getattr(entry, "title", "").strip()
                link    = getattr(entry, "link", "") or rsshub_url
                summary = getattr(entry, "summary", "")[:400]
                if not title:
                    continue
                pub = _parse_date(entry)
                if not pub:
                    continue
                try:
                    dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
                    if dt < cutoff:
                        continue
                except Exception:
                    pass
                title, summary, original_lang = _translate_title_summary(title, summary)
                threat = classify(title, summary)
                geo    = _geo_tag(f"{title} {summary}")
                results.append({
                    "id": _article_id(link, title), "title": title, "url": link,
                    "source": label, "tier": tier, "published": pub,
                    "summary": summary, "original_lang": original_lang, "geo": geo,
                    "tags": ["telegram", "osint"], **threat,
                })
            if not results:
                logger.debug("All methods failed for TG channel: %s", channel)

        return results, channel

    # ── Parallel fetch across all channels ────────────────────────────────────
    from concurrent.futures import ThreadPoolExecutor, as_completed

    articles  = []
    seen_ids  = set()

    failed_channels = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {
            ex.submit(_fetch_one_channel, label, rsshub_url, tier): label
            for label, rsshub_url, tier in RSSHUB_FEEDS
        }
        for fut in as_completed(futures):
            try:
                chan_articles, channel = fut.result()
                if not chan_articles and channel:
                    failed_channels.append(channel)
                for art in chan_articles:
                    if art["id"] not in seen_ids:
                        seen_ids.add(art["id"])
                        articles.append(art)
            except Exception as exc:
                logger.warning("TG channel future error [%s]: %s", futures[fut], exc)

    if failed_channels:
        shown = ", ".join(sorted(set(failed_channels))[:10])
        remaining = max(0, len(set(failed_channels)) - 10)
        suffix = f" (+{remaining} more)" if remaining else ""
        logger.warning(
            "Telegram fetch failed for %d/%d channels: %s%s",
            len(set(failed_channels)),
            len(RSSHUB_FEEDS),
            shown,
            suffix,
        )

    articles.sort(key=lambda a: a["severity_score"], reverse=True)
    return articles


_RSSHUB_WINDOW = timedelta(hours=24)


def _rsshub_item_after_cutoff(item: Dict, cutoff: datetime) -> bool:
    pub = item.get("published") or ""
    if not pub:
        return False
    try:
        dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
        return dt >= cutoff
    except Exception:
        return False


def _merge_rsshub_feed(old: List[Dict], new: List[Dict]) -> List[Dict]:
    """
    Union Telegram OSINT items by id (new fetch wins on duplicate).
    Drops anything outside the rolling 24h window so the feed stays bounded.
    An empty new fetch does not evict still-valid cached items.
    """
    cutoff = datetime.now(timezone.utc) - _RSSHUB_WINDOW
    seen: set = set()
    out: List[Dict] = []
    for item in new + old:
        aid = item.get("id")
        if not aid or aid in seen:
            continue
        if not _rsshub_item_after_cutoff(item, cutoff):
            continue
        seen.add(aid)
        out.append(item)
    out.sort(key=lambda a: a.get("severity_score", 0), reverse=True)
    return out


def _fetch_rsshub_refresh() -> List[Dict]:
    """Snapshot cache, fetch fresh slice, merge so transient empty fetches never wipe data."""
    with _cache_lock:
        prev = _cache.get("rsshub")
        old = list(prev) if prev else []
    new = _fetch_rsshub()
    return _merge_rsshub_feed(old, new)


def get_rsshub_news() -> List[Dict]:
    return _cached("rsshub", 600, _fetch_rsshub_refresh) or []


# ── 2. USGS Earthquakes ───────────────────────────────────────────────────────
def _fetch_earthquakes() -> List[Dict]:
    # Significant (M4.5+) past 7 days
    url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"
    data = _get(url)
    quakes = []
    for feat in data.get("features", []):
        p = feat["properties"]
        g = feat["geometry"]
        mag = p.get("mag", 0) or 0
        quakes.append({
            "id":        feat["id"],
            "title":     p.get("title", ""),
            "magnitude": mag,
            "place":     p.get("place", ""),
            "time":      datetime.fromtimestamp(p["time"] / 1000, tz=timezone.utc).isoformat(),
            "lat":       g["coordinates"][1],
            "lon":       g["coordinates"][0],
            "depth_km":  g["coordinates"][2],
            "url":       p.get("url", ""),
            "severity":  "critical" if mag >= 7 else "high" if mag >= 6 else "medium" if mag >= 5 else "low",
            "color":     "#ff0040" if mag >= 7 else "#ff6600" if mag >= 6 else "#ffcc00" if mag >= 5 else "#44aaff",
        })
    quakes.sort(key=lambda q: q["magnitude"], reverse=True)
    return quakes


def get_earthquakes() -> List[Dict]:
    return _cached("earthquakes", 600, _fetch_earthquakes) or []


# ── 3. NASA EONET — Natural Events ───────────────────────────────────────────
_EONET_CATEGORY_COLORS = {
    "Wildfires":        "#ff6600",
    "Volcanoes":        "#ff0040",
    "Severe Storms":    "#ffcc00",
    "Floods":           "#44aaff",
    "Earthquakes":      "#ff6600",
    "Drought":          "#aa8844",
    "Dust and Haze":    "#bbaa88",
    "Landslides":       "#886644",
    "Sea and Lake Ice": "#88ddff",
    "Snow":             "#ccddff",
}


def _fetch_eonet() -> List[Dict]:
    url = "https://eonet.gsfc.nasa.gov/api/v3/events"
    params = {"status": "open", "limit": 200, "days": 30}
    data = _get(url, params=params)
    events = []
    for ev in data.get("events", []):
        cat_name = ev["categories"][0]["title"] if ev.get("categories") else "Natural Event"
        # Use most recent geometry
        geoms = ev.get("geometry", [])
        if not geoms:
            continue
        latest = sorted(geoms, key=lambda g: g.get("date", ""), reverse=True)[0]
        coords = latest.get("coordinates")
        if not coords:
            continue
        # EONET uses [lon, lat] or [[lon, lat], ...] for tracks
        if isinstance(coords[0], list):
            coords = coords[0]
        if len(coords) < 2:
            continue
        events.append({
            "id":       ev["id"],
            "title":    ev["title"],
            "category": cat_name,
            "lat":      coords[1],
            "lon":      coords[0],
            "date":     latest.get("date", ""),
            "url":      ev.get("sources", [{}])[0].get("url", ""),
            "color":    _EONET_CATEGORY_COLORS.get(cat_name, "#888888"),
        })
    return events


def get_eonet_events() -> List[Dict]:
    return _cached("eonet", 900, _fetch_eonet) or []


# ── 4a. GDELT Events 2.0 — 15-min CSV export (CDN, no rate limits) ───────────
# GDELT publishes raw event CSV files every 15 minutes to a public CDN.
# No API key, no rate limiting, immune to the DOC 2.0 query blocks.
# Docs: http://data.gdeltproject.org/documentation/GDELT-Event_Codebook-V2.0.pdf

# GDELT CAMEO event root codes we care about
# QuadClass 3=Verbal Conflict, 4=Material Conflict
# GoldsteinScale: -10 (most destabilizing) to +10 (most cooperative)
_GDELT_CONFLICT_ROOT_CODES = {
    "13",  # Threaten
    "14",  # Protest / demonstrate
    "15",  # Exhibit military force posture / mobilize
    "16",  # Reduce diplomatic relations
    "17",  # Coerce
    "18",  # Assault / armed attack
    "19",  # Fight / use conventional military force
    "20",  # Use unconventional mass violence / atrocity
}

# 61 fixed tab-separated columns in GDELT 2.0 event CSV
_GDELT_CSV_COLS = [
    "GLOBALEVENTID","SQLDATE","MonthYear","Year","FractionDate",
    "Actor1Code","Actor1Name","Actor1CountryCode","Actor1KnownGroupCode",
    "Actor1EthnicCode","Actor1Religion1Code","Actor1Religion2Code",
    "Actor1Type1Code","Actor1Type2Code","Actor1Type3Code",
    "Actor2Code","Actor2Name","Actor2CountryCode","Actor2KnownGroupCode",
    "Actor2EthnicCode","Actor2Religion1Code","Actor2Religion2Code",
    "Actor2Type1Code","Actor2Type2Code","Actor2Type3Code",
    "IsRootEvent","EventCode","EventBaseCode","EventRootCode",
    "QuadClass","GoldsteinScale","NumMentions","NumSources","NumArticles",
    "AvgTone","Actor1Geo_Type","Actor1Geo_FullName","Actor1Geo_CountryCode",
    "Actor1Geo_ADM1Code","Actor1Geo_ADM2Code","Actor1Geo_Lat","Actor1Geo_Long",
    "Actor1Geo_FeatureID","Actor2Geo_Type","Actor2Geo_FullName",
    "Actor2Geo_CountryCode","Actor2Geo_ADM1Code","Actor2Geo_ADM2Code",
    "Actor2Geo_Lat","Actor2Geo_Long","Actor2Geo_FeatureID",
    "ActionGeo_Type","ActionGeo_FullName","ActionGeo_CountryCode",
    "ActionGeo_ADM1Code","ActionGeo_ADM2Code","ActionGeo_Lat","ActionGeo_Long",
    "ActionGeo_FeatureID","DATEADDED","SOURCEURL",
]


def _fetch_gdelt() -> List[Dict]:
    """
    Fetch the latest GDELT 2.0 event CSV from the public CDN.
    Steps:
      1. GET lastupdate.txt  → 3 lines, one per file type; grab the .export.CSV.zip URL
      2. Download and unzip the ~2-5 MB CSV
      3. Parse rows, filter to conflict CAMEO codes with valid geo + source URL
    No rate limiting, no API key, no blocking.
    """
    import csv as _csv
    import io as _io
    import zipfile as _zf

    LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt"

    try:
        lu = requests.get(LASTUPDATE_URL, headers=HEADERS, timeout=10)
        lu.raise_for_status()
    except Exception as exc:
        logger.warning("GDELT lastupdate.txt fetch failed: %s", exc)
        return []

    # lastupdate.txt format: "size hash http://...CSV.zip\n" (3 lines)
    csv_zip_url = None
    for line in lu.text.strip().splitlines():
        parts = line.split()
        if len(parts) >= 3 and "export.CSV.zip" in parts[2]:
            csv_zip_url = parts[2]
            break

    if not csv_zip_url:
        logger.warning("GDELT lastupdate.txt: no export.CSV.zip URL found. Content: %s",
                       lu.text[:200])
        return []

    try:
        zr = requests.get(csv_zip_url, headers=HEADERS, timeout=12)
        zr.raise_for_status()
    except Exception as exc:
        logger.warning("GDELT CSV zip download failed [%s]: %s", csv_zip_url, exc)
        return []

    try:
        with _zf.ZipFile(_io.BytesIO(zr.content)) as zf:
            csv_name = next((n for n in zf.namelist() if n.endswith(".CSV")), None)
            if not csv_name:
                logger.warning("GDELT zip contains no .CSV file: %s", zf.namelist())
                return []
            raw_csv = zf.read(csv_name).decode("utf-8", errors="replace")
    except Exception as exc:
        logger.warning("GDELT zip parse failed: %s", exc)
        return []

    articles = []
    seen_urls: set = set()

    reader = _csv.DictReader(
        _io.StringIO(raw_csv),
        fieldnames=_GDELT_CSV_COLS,
        delimiter="\t",
    )

    for row in reader:
        try:
            root     = str(row.get("EventRootCode", "")).strip()
            if root not in _GDELT_CONFLICT_ROOT_CODES:
                continue

            quad     = int(row.get("QuadClass") or 0)
            gold     = float(row.get("GoldsteinScale") or 0.0)
            mentions = int(row.get("NumMentions") or 0)
            url      = row.get("SOURCEURL", "").strip()
            lat_s    = row.get("ActionGeo_Lat", "").strip()
            lon_s    = row.get("ActionGeo_Long", "").strip()

            # Require meaningful conflict signal, valid geo, source URL, min coverage.
            # Both constraints must pass: QuadClass >= 3 and Goldstein <= -2.0.
            if quad < 3 or gold > -2.0:
                continue
            if not url or not lat_s or not lon_s:
                continue
            if mentions < 3:
                continue
            if url in seen_urls:
                continue
            seen_urls.add(url)

            lat = float(lat_s)
            lon = float(lon_s)
            if lat == 0.0 and lon == 0.0:
                continue

            a1       = (row.get("Actor1Name") or "").strip().title()
            a2       = (row.get("Actor2Name") or "").strip().title()
            location = (row.get("ActionGeo_FullName") or "").strip()

            # Build a readable title from actors + location
            actors = " vs ".join(p for p in [a1, a2] if p)
            title  = f"{actors} — {location}" if actors else location
            if not title.strip():
                continue
            title = title[:120]

            # Parse DATEADDED: YYYYMMDDHHMMSS
            raw_dt = str(row.get("DATEADDED", "")).strip()
            try:
                pub = datetime.strptime(raw_dt, "%Y%m%d%H%M%S").replace(
                    tzinfo=timezone.utc).isoformat()
            except Exception:
                pub = datetime.now(timezone.utc).isoformat()

            title, summary, original_lang = _translate_title_summary(
                title,
                f"Actors: {actors} | Location: {location} | Goldstein: {gold:+.1f} | Mentions: {mentions}",
            )
            threat = classify(title, summary)

            articles.append({
                "id":        _article_id(url, title),
                "title":     title,
                "url":       url,
                "source":    "GDELT/Events2",
                "tier":      2,
                "published": pub,
                "summary":   summary,
                "original_lang": original_lang,
                "geo":       {"lat": lat, "lon": lon, "location": location},
                **threat,
            })

        except Exception as exc:
            logger.debug("GDELT row parse error: %s", exc)
            continue

    articles.sort(key=lambda a: a["severity_score"], reverse=True)
    logger.info("GDELT CSV: %d conflict events parsed from %s", len(articles), csv_zip_url)
    return articles


def get_gdelt() -> List[Dict]:
    """Cached wrapper — 15 min TTL matching GDELT's own update cadence."""
    return _cached("gdelt", 900, _fetch_gdelt) or []






# ── 5. ADSB.lol — Live military flight tracking (free, no API key) ───────────
_ADSB_LOL_URL = "https://api.adsb.lol/v2/mil"
_ADSB_REQUEST_TIMEOUT_S = 20
_ADSB_MAX_RETRIES = 3
_ADSB_BASE_BACKOFF_S = 1.0
_ADSB_MIN_REQUEST_GAP_S = 2.0
# adsb.lol / common ADS-B: alt_baro is feet; gs is knots (not m/s).
_FEET_TO_M = 0.3048
_KNOTS_TO_MS = 1852.0 / 3600.0  # 0.514444…

# Optional heuristics: can add tags, but never override dbFlags.military.
_ADSB_HEURISTIC_CALLSIGN_PREFIXES = (
    "RCH",
    "REACH",
    "FORTE",
)

_adsb_last_request_ts = 0.0
_adsb_request_lock = threading.Lock()

# Lightweight registration-prefix hints for origin country display in dashboard popups.
_REG_PREFIX_COUNTRY_HINTS = (
    ("N", "United States"),
    ("C", "Canada"),
    ("G", "United Kingdom"),
    ("D", "Germany"),
    ("F", "France"),
    ("I", "Italy"),
    ("EC", "Spain"),
    ("PH", "Netherlands"),
    ("RA", "Russia"),
    ("RF", "Russia"),
    ("B", "China"),
    ("JA", "Japan"),
    ("HL", "South Korea"),
    ("VT", "India"),
    ("VH", "Australia"),
)

# ICAO hex prefix hints (best-effort) to improve country attribution for military tails.
_ICAO_PREFIX_COUNTRY_HINTS = (
    ("AE", "United States"),
    ("AF", "United States"),
    ("43C", "United Kingdom"),
    ("43D", "United Kingdom"),
    ("43E", "United Kingdom"),
    ("3A8", "France"),
    ("3A9", "France"),
    ("3AA", "France"),
    ("3C0", "Germany"),
    ("3C1", "Germany"),
    ("3C2", "Germany"),
    ("3C3", "Germany"),
    ("3C4", "Germany"),
    ("3C5", "Germany"),
    ("3A0", "Italy"),
    ("3A1", "Italy"),
    ("340", "Spain"),
    ("341", "Spain"),
    ("342", "Spain"),
    ("480", "Netherlands"),
    ("481", "Netherlands"),
    ("44C", "Belgium"),
    ("44D", "Belgium"),
    ("489", "Poland"),
    ("48A", "Poland"),
    ("47A", "Norway"),
    ("47B", "Norway"),
    ("4A0", "Sweden"),
    ("4A1", "Sweden"),
    ("C00", "Canada"),
    ("C01", "Canada"),
    ("C02", "Canada"),
    ("7C8", "Australia"),
    ("7C9", "Australia"),
    ("7CA", "Australia"),
    ("840", "Japan"),
    ("841", "Japan"),
    ("842", "Japan"),
    ("843", "Japan"),
    ("71D", "South Korea"),
    ("71E", "South Korea"),
    ("71F", "South Korea"),
    ("738", "Israel"),
    ("739", "Israel"),
    ("73A", "Israel"),
    ("73B", "Israel"),
    ("710", "Saudi Arabia"),
    ("711", "Saudi Arabia"),
    ("712", "Saudi Arabia"),
    ("896", "United Arab Emirates"),
    ("897", "United Arab Emirates"),
    ("4BA", "Turkey"),
    ("4BB", "Turkey"),
    ("4BC", "Turkey"),
    ("800", "India"),
    ("801", "India"),
    ("802", "India"),
    ("803", "India"),
    ("780", "China"),
    ("781", "China"),
    ("782", "China"),
    ("783", "China"),
    ("784", "China"),
    ("730", "Iran"),
    ("731", "Iran"),
    ("732", "Iran"),
    ("760", "Pakistan"),
    ("761", "Pakistan"),
    ("762", "Pakistan"),
    ("128", "North Korea"),
    ("129", "North Korea"),
    ("010", "Egypt"),
    ("011", "Egypt"),
    ("E40", "Brazil"),
    ("E41", "Brazil"),
    ("43", "Russia"),
)


def _infer_country_from_registration(registration: Optional[str]) -> Optional[str]:
    if not registration:
        return None
    reg = str(registration).strip().upper()
    for prefix, country in _REG_PREFIX_COUNTRY_HINTS:
        if reg.startswith(prefix):
            return country
    return None


def _infer_country_from_icao(icao: Optional[str]) -> Optional[str]:
    if not icao:
        return None
    hx = str(icao).strip().upper()
    for prefix, country in _ICAO_PREFIX_COUNTRY_HINTS:
        if hx.startswith(prefix):
            return country
    return None


def _adsb_lol_normalize_aircraft(aircraft: Dict[str, Any], timestamp_iso: str) -> Optional[Dict[str, Any]]:
    """Normalize one adsb.lol aircraft item into SPECTRE-compatible schema."""

    icao = str(aircraft.get("hex") or "").strip().lower()
    if not icao:
        return None

    lat = _coerce_float(aircraft.get("lat"))
    lon = _coerce_float(aircraft.get("lon"))
    if lat is None or lon is None:
        return None

    callsign_raw = aircraft.get("flight")
    callsign = str(callsign_raw).strip() if callsign_raw not in (None, "") else None
    registration_raw = aircraft.get("r")
    registration = str(registration_raw).strip() if registration_raw not in (None, "") else None

    alt = aircraft.get("alt_baro")
    alt_ft = int(alt) if isinstance(alt, (int, float)) else _coerce_float(alt)
    altitude = int(round(alt_ft * _FEET_TO_M)) if alt_ft is not None else None

    gs_kn = _coerce_float(aircraft.get("gs"))
    speed_ms = round(gs_kn * _KNOTS_TO_MS, 2) if gs_kn is not None else None
    heading = _coerce_float(aircraft.get("track"))
    aircraft_type = aircraft.get("type")
    aircraft_type = str(aircraft_type).strip() if aircraft_type not in (None, "") else None
    category = aircraft.get("category")
    category = str(category).strip() if category not in (None, "") else None
    country_hint = _infer_country_from_registration(registration) or _infer_country_from_icao(icao)

    tags = ["military"]
    if callsign:
        cs_upper = callsign.upper()
        if any(cs_upper.startswith(prefix) for prefix in _ADSB_HEURISTIC_CALLSIGN_PREFIXES):
            tags.append("callsign_heuristic")

    return {
        # requested normalized schema
        "source": "adsb_lol",
        "icao": icao,
        "callsign": callsign,
        "latitude": lat,
        "longitude": lon,
        "altitude": altitude,
        "ground_speed": speed_ms,
        "ground_speed_knots": gs_kn,
        "heading": heading,
        "aircraft_type": aircraft_type,
        "timestamp": timestamp_iso,
        "tags": tags,
        "military": True,
        "registration": registration,
        "category": category,
        "country": country_hint,
        "origin": "adsb.lol /v2/mil",
        # backwards compatibility with existing dashboard fields
        "icao24": icao,
        "lat": lat,
        "lon": lon,
        "altitude_m": altitude,
        "speed_ms": speed_ms,
        "interesting": True,
    }


def _adsb_rate_limit_wait() -> None:
    """Simple local pacing so we do not spam the public endpoint."""
    global _adsb_last_request_ts
    with _adsb_request_lock:
        now = time.time()
        elapsed = now - _adsb_last_request_ts
        if elapsed < _ADSB_MIN_REQUEST_GAP_S:
            time.sleep(_ADSB_MIN_REQUEST_GAP_S - elapsed)
        _adsb_last_request_ts = time.time()


def _fetch_flights() -> List[Dict]:
    """
    Fetch live aircraft from adsb.lol /v2/mil endpoint.
    Endpoint already returns military registered aircraft.
    Retries with exponential backoff and returns [] on failure.
    """
    for attempt in range(_ADSB_MAX_RETRIES):
        try:
            _adsb_rate_limit_wait()
            r = requests.get(_ADSB_LOL_URL, headers=HEADERS, timeout=_ADSB_REQUEST_TIMEOUT_S)
            r.raise_for_status()
            payload = r.json()
            aircraft_list = payload.get("ac") or payload.get("aircraft") or []
            if not isinstance(aircraft_list, list):
                logger.warning("adsb.lol unexpected payload shape: %s", type(aircraft_list))
                return []

            seen_icao: set = set()
            flights: List[Dict] = []
            ts_iso = datetime.now(timezone.utc).isoformat()
            for ac in aircraft_list:
                if not isinstance(ac, dict):
                    continue
                normalized = _adsb_lol_normalize_aircraft(ac, ts_iso)
                if not normalized:
                    continue
                icao = normalized["icao"]
                if icao in seen_icao:
                    continue
                seen_icao.add(icao)
                flights.append(normalized)
            return flights
        except Exception as exc:
            last_exc = exc
            if attempt < _ADSB_MAX_RETRIES - 1:
                backoff_s = _ADSB_BASE_BACKOFF_S * (2 ** attempt)
                time.sleep(backoff_s)
                continue
            logger.warning("adsb.lol flight fetch failed after retries: %s", exc)
    return []


def get_flights() -> List[Dict]:
    # Use a new cache key so old OpenSky disk-cache payloads are not reused.
    return _cached("flights_adsb_lol", 300, _fetch_flights) or []


# ── 6. Satellite Tracking (CelesTrak + SGP4, filtered high-value targets) ─────
_SAT_TLE_URLS = {
    "military": [
        "https://celestrak.org/NORAD/elements/gp.php?GROUP=military&FORMAT=tle",
        "https://www.celestrak.org/NORAD/elements/gp.php?GROUP=military&FORMAT=tle",
    ],
    "active": [
        "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
        "https://www.celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
    ],
}
_SAT_EXCLUDE_PATTERNS = ("STARLINK", "ONEWEB", "IRIDIUM", "CUBESAT", "DEB")
_SAT_INCLUDE_PATTERNS = {
    "military": ("USA", "NROL", "KH", "LACROSSE", "ONYX", "CRYSTAL", "SBIRS", "DSP"),
    "comms": ("WGS", "MUOS", "AEHF", "SKYNET", "MERIDIAN"),
}
_SAT_FETCH_TIMEOUT_S = int(os.getenv("SPECTRE_SAT_TIMEOUT_S", "25"))
_SAT_FETCH_MAX_RETRIES = int(os.getenv("SPECTRE_SAT_MAX_RETRIES", "3"))
_SAT_FETCH_BASE_BACKOFF_S = float(os.getenv("SPECTRE_SAT_BACKOFF_S", "1.0"))
_satrec_cache: Dict[str, Any] = {}
_satrec_cache_lock = threading.Lock()


def _gmst_rad(dt: datetime) -> float:
    """Approximate Greenwich Mean Sidereal Time in radians."""
    # Reference epoch: J2000 at 2000-01-01 12:00:00 UTC.
    j2000 = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    delta_days = (dt - j2000).total_seconds() / 86400.0
    gmst_deg = (280.46061837 + 360.98564736629 * delta_days) % 360.0
    return gmst_deg * (3.141592653589793 / 180.0)


def _eci_to_geodetic_km(x: float, y: float, z: float, dt: datetime) -> Optional[Dict[str, float]]:
    """Convert TEME-like ECI coordinates to approximate geodetic lat/lon/alt."""
    try:
        # Rotate ECI -> ECEF using GMST.
        theta = _gmst_rad(dt)
        cos_t = float(__import__("math").cos(theta))
        sin_t = float(__import__("math").sin(theta))
        x_ecef = x * cos_t + y * sin_t
        y_ecef = -x * sin_t + y * cos_t
        z_ecef = z

        # WGS84 constants.
        a = 6378.137
        b = 6356.7523142
        e2 = 1.0 - (b * b) / (a * a)
        ep2 = (a * a - b * b) / (b * b)

        lon = __import__("math").atan2(y_ecef, x_ecef)
        p = __import__("math").sqrt(x_ecef * x_ecef + y_ecef * y_ecef)
        if p == 0:
            return None
        th = __import__("math").atan2(a * z_ecef, b * p)
        sin_th = __import__("math").sin(th)
        cos_th = __import__("math").cos(th)
        lat = __import__("math").atan2(
            z_ecef + ep2 * b * sin_th * sin_th * sin_th,
            p - e2 * a * cos_th * cos_th * cos_th,
        )
        sin_lat = __import__("math").sin(lat)
        n = a / __import__("math").sqrt(1.0 - e2 * sin_lat * sin_lat)
        alt_km = p / __import__("math").cos(lat) - n

        return {
            "lat": lat * (180.0 / 3.141592653589793),
            "lon": ((lon * (180.0 / 3.141592653589793) + 540.0) % 360.0) - 180.0,
            "alt_km": alt_km,
        }
    except Exception:
        return None


def _iter_tle_blocks(raw_text: str):
    lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            yield name, l1, l2
            i += 3
        else:
            i += 1


def _sat_category_for_name(name: str) -> Optional[str]:
    n = (name or "").upper().strip()
    if not n:
        return None
    if any(x in n for x in _SAT_EXCLUDE_PATTERNS):
        return None
    for category, patterns in _SAT_INCLUDE_PATTERNS.items():
        if any(p in n for p in patterns):
            return category
    return None


def _priority_for_category(category: str, name: str) -> int:
    n = (name or "").upper()
    if category == "military":
        if any(k in n for k in ("USA", "NROL", "KH", "LACROSSE", "ONYX", "CRYSTAL", "SBIRS", "DSP")):
            return 100
        return 90
    if category == "comms":
        return 65
    return 30


def _fetch_tle_group(group: str, urls: List[str]) -> List[Dict[str, str]]:
    last_exc: Exception | None = None
    for attempt in range(max(1, _SAT_FETCH_MAX_RETRIES)):
        for url in urls:
            try:
                resp = requests.get(url, headers=HEADERS, timeout=_SAT_FETCH_TIMEOUT_S)
                resp.raise_for_status()
                raw = resp.text
                out: List[Dict[str, str]] = []
                for name, line1, line2 in _iter_tle_blocks(raw):
                    out.append({"group": group, "name": name, "line1": line1, "line2": line2})
                return out
            except Exception as exc:
                last_exc = exc
                continue
        # Backoff before next retry round (covers transient DNS/connect issues).
        if attempt < _SAT_FETCH_MAX_RETRIES - 1:
            backoff_s = _SAT_FETCH_BASE_BACKOFF_S * (2 ** attempt)
            time.sleep(backoff_s)

    logger.warning("CelesTrak fetch failed [%s] after retries: %s", group, last_exc)
    return []


def _build_satrec(key: str, line1: str, line2: str) -> Optional[Satrec]:
    if Satrec is None:
        return None
    with _satrec_cache_lock:
        cached = _satrec_cache.get(key)
        if cached is not None:
            return cached
    try:
        sat = Satrec.twoline2rv(line1, line2)
    except Exception:
        return None
    with _satrec_cache_lock:
        _satrec_cache[key] = sat
    return sat


def _fetch_satellites() -> List[Dict]:
    if Satrec is None or jday is None:
        logger.warning("sgp4 not installed; satellite feed disabled")
        return []

    ingested: List[Dict[str, str]] = []
    for group, url in _SAT_TLE_URLS.items():
        ingested.extend(_fetch_tle_group(group, url))

    total_ingested = len(ingested)
    now_utc = datetime.now(timezone.utc)
    jd, fr = jday(  # type: ignore[misc]
        now_utc.year, now_utc.month, now_utc.day,
        now_utc.hour, now_utc.minute,
        now_utc.second + (now_utc.microsecond / 1_000_000.0),
    )

    out: List[Dict] = []
    breakdown = {"military": 0, "comms": 0}

    for tle in ingested:
        group = tle["group"]
        name = tle["name"]
        line1 = tle["line1"]
        line2 = tle["line2"]

        category = "military" if group == "military" else _sat_category_for_name(name)
        if category not in ("military", "comms"):
            continue

        satrec_key = f"{line1}|{line2}"
        sat = _build_satrec(satrec_key, line1, line2)
        if sat is None:
            continue

        try:
            err, r, _v = sat.sgp4(jd, fr)
        except Exception:
            continue
        if err != 0:
            # Skip malformed/out-of-range propagations without crashing.
            continue

        geo = _eci_to_geodetic_km(r[0], r[1], r[2], now_utc)
        if not geo:
            continue

        # Keep returned set focused for dashboard performance.
        priority = _priority_for_category(category, name)
        sat_name = name.strip()
        if not sat_name:
            continue
        satnum = line1[2:7].strip()
        out.append({
            "id": f"{satnum}:{sat_name}",
            "name": sat_name,
            "norad_id": satnum or None,
            "group": group,
            "category": category,
            "tags": ["space", category],
            "priority": priority,
            "lat": round(geo["lat"], 5),
            "lon": round(geo["lon"], 5),
            "alt_km": round(geo["alt_km"], 1),
            "timestamp": now_utc.isoformat(),
            "source": "celestrak_tle_sgp4",
        })
        breakdown[category] = breakdown.get(category, 0) + 1

    out.sort(key=lambda s: s.get("priority", 0), reverse=True)
    if len(out) > 300:
        out = out[:300]

    logger.info(
        "Sat ingest=%d filtered=%d breakdown=%s",
        total_ingested,
        len(out),
        {k: v for k, v in breakdown.items() if v > 0},
    )
    return out


def get_satellites() -> List[Dict]:
    return _cached("satellites_mil_comms", 600, _fetch_satellites) or []


# ── 6. Country Risk (dynamic adjustment) ─────────────────────────────────────
def get_country_risk(news_items: List[Dict] = None) -> List[Dict]:
    """
    Start from baseline COUNTRY_RISK values and boost based on recent news.
    """
    # Count recent high/critical articles per location
    boosts: Dict[str, int] = {}
    if news_items:
        for art in news_items:
            if art.get("geo"):
                loc = art["geo"]["location"]
                score = art.get("severity_score", 1)
                if score >= 3:
                    boosts[loc] = boosts.get(loc, 0) + (score - 2)

    results = []
    for country, data in COUNTRY_RISK.items():
        boost = boosts.get(country, 0)
        raw_risk = min(100, data["risk"] + boost * 2)
        results.append({
            "country": country,
            "risk":    raw_risk,
            "lat":     data["lat"],
            "lon":     data["lon"],
            "iso":     data["iso"],
            "tier":    "critical" if raw_risk >= 80 else
                       "high"     if raw_risk >= 60 else
                       "medium"   if raw_risk >= 40 else "low",
            "color":   "#ff0040" if raw_risk >= 80 else
                       "#ff6600" if raw_risk >= 60 else
                       "#ffcc00" if raw_risk >= 40 else "#44aaff",
        })

    results.sort(key=lambda c: c["risk"], reverse=True)
    return results


# ── 7. Wikipedia Geosearch — nearby events/articles ──────────────────────────
def get_wiki_geosearch(lat: float, lon: float, radius: int = 10000) -> List[Dict]:
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action":    "query",
        "list":      "geosearch",
        "gscoord":   f"{lat}|{lon}",
        "gsradius":  radius,
        "gslimit":   10,
        "format":    "json",
        "gsprop":    "type|name",
    }
    data = _get(url, params=params)
    results = []
    for item in data.get("query", {}).get("geosearch", []):
        results.append({
            "title": item["title"],
            "lat":   item["lat"],
            "lon":   item["lon"],
            "url":   f"https://en.wikipedia.org/wiki/{item['title'].replace(' ', '_')}",
        })
    return results


# ── 8. Aggregate summary ──────────────────────────────────────────────────────
def get_summary_stats(
    news: List[Dict],
    earthquakes: List[Dict],
    events: List[Dict],
    flights: List[Dict],
) -> Dict:
    severity_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    cat_counts: Dict[str, int] = {}

    for art in news:
        sev = art.get("severity", "info")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1
        for cat in art.get("categories", []):
            cat_counts[cat] = cat_counts.get(cat, 0) + 1

    top_categories = sorted(cat_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    critical_news  = [a for a in news if a.get("severity") == "critical"][:5]
    high_news      = [a for a in news if a.get("severity") == "high"][:10]
    big_quakes     = [q for q in earthquakes if q.get("magnitude", 0) >= 6.0]

    return {
        "timestamp":         datetime.now(timezone.utc).isoformat(),
        "news_total":        len(news),
        "severity_counts":   severity_counts,
        "top_categories":    [{"category": c, "count": n} for c, n in top_categories],
        "critical_news":     critical_news,
        "high_news":         high_news,
        "earthquake_total":  len(earthquakes),
        "big_earthquakes":   big_quakes,
        "natural_events":    len(events),
        "flights_tracked":   len(flights),
        "interesting_flights": [f for f in flights if f.get("interesting")],
        "global_threat_level": (
            "critical" if severity_counts["critical"] >= 3 else
            "high"     if severity_counts["high"] >= 5 or severity_counts["critical"] >= 1 else
            "elevated" if severity_counts["medium"] >= 10 else
            "guarded"
        ),
    }


# ── 9. Internet Blackout Monitor — IODA (Georgia Tech, free, no API key) ─────
# Official HTTP API (JSON): https://api.ioda.inetintel.cc.gatech.edu/v2/
# The dashboard hostname serves the SPA; /api/v2/* there is not the JSON API.
IODA_API = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts"


def _ioda_alert_country_iso(entity: dict) -> Optional[str]:
    """
    Map an IODA alert entity to an ISO-3166 alpha-2 country code for map placement.
    Alerts are mostly region / asn / geoasn; only a few are type country.
    """
    et = (entity.get("type") or "").lower()
    code = str(entity.get("code") or "")
    attrs = entity.get("attrs") or {}
    if et == "country":
        c = code.upper().strip()
        return c[:2] if len(c) >= 2 else None
    if et == "region":
        cc = attrs.get("country_code")
        if cc and len(str(cc)) >= 2:
            return str(cc).upper()[:2]
    if et == "geoasn" and "-" in code:
        # e.g. "39822-UA" → UA (ASN scoped to a country)
        tail = code.rsplit("-", 1)[-1]
        if len(tail) == 2 and tail.isalpha():
            return tail.upper()
    return None


def _fetch_blackouts() -> List[Dict]:
    """
    Fetch internet disruption alerts from IODA (Internet Outage Detection
    and Analysis) at Georgia Tech. Completely free, no API key required.
    Docs: https://api.ioda.inetintel.cc.gatech.edu/v2/
    """
    until_ts = int(datetime.now(timezone.utc).timestamp())
    from_ts = until_ts - 86400  # last 24 hours

    try:
        data = _get(IODA_API, timeout=12, params={
            "from": from_ts,
            "until": until_ts,
            "limit": 500,
            # Include alerts that overlap the window but started/ended outside it
            "extendWindow": 86400,
        })
    except Exception as exc:
        logger.warning("IODA fetch failed: %s", exc)
        return []

    raw = data.get("data") if isinstance(data, dict) else data
    if isinstance(raw, dict):
        raw = raw.get("alerts") or raw.get("data") or []
    if not isinstance(raw, list):
        logger.debug("IODA unexpected response shape: %s", type(raw))
        return []

    # Build a quick iso2 → geo lookup from COUNTRY_RISK
    _iso2_geo: Dict[str, Dict] = {
        v["iso"].upper(): {"lat": v["lat"], "lon": v["lon"], "name": k}
        for k, v in COUNTRY_RISK.items()
        if v.get("iso")
    }

    # Aggregate by country — keep the highest severity per country
    seen: Dict[str, Dict] = {}
    rank = {"critical": 3, "warning": 2, "info": 1, "normal": 0}

    for alert in raw:
        try:
            entity = alert.get("entity") or {}
            level = (alert.get("level") or alert.get("condition") or "normal").lower()
            if level == "normal":
                continue

            iso = _ioda_alert_country_iso(entity)
            if not iso:
                continue

            geo = _iso2_geo.get(iso)
            if not geo:
                continue

            if iso not in seen or rank.get(level, 0) > rank.get(seen[iso]["level"], 0):
                raw_ts = alert.get("time", "")
                if isinstance(raw_ts, (int, float)):
                    ts = datetime.fromtimestamp(raw_ts, tz=timezone.utc).isoformat()
                else:
                    ts = str(raw_ts) or datetime.now(timezone.utc).isoformat()

                ds = alert.get("datasource") or ""
                method = alert.get("method") or ""
                sig_bits = [alert.get("condition") or level]
                if ds:
                    sig_bits.append(ds)
                if method:
                    sig_bits.append(method)
                signals = " / ".join(s for s in sig_bits if s)

                seen[iso] = {
                    "country": geo["name"],
                    "iso": iso,
                    "level": level if level in rank else "warning",
                    "lat": geo["lat"],
                    "lon": geo["lon"],
                    "started": ts,
                    "source": "IODA/GeorgiaTech",
                    "signals": signals,
                    "color": "#ff0040" if level == "critical" else
                             "#ffcc00" if level == "warning" else "#888888",
                }
        except Exception as exc:
            logger.debug("IODA alert parse error: %s", exc)

    result = list(seen.values())
    result.sort(
        key=lambda x: {"critical": 2, "warning": 1, "info": 0}.get(x["level"], 0),
        reverse=True,
    )
    return result


def get_blackouts() -> List[Dict]:
    return _cached("blackouts", 600, _fetch_blackouts) or []


_MILITARY_BASES_PATH = os.path.join(os.path.dirname(__file__), "military_bases.json")
_military_bases_cache: Optional[List[Dict]] = None


def get_military_bases() -> List[Dict]:
    """
    Forward military installations from bundled military_bases.json (lat/lng → lon for map).
    Loaded once per process.
    """
    global _military_bases_cache
    if _military_bases_cache is not None:
        return _military_bases_cache
    try:
        with open(_MILITARY_BASES_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as exc:
        logger.warning("Could not load military_bases.json: %s", exc)
        _military_bases_cache = []
        return []

    out: List[Dict] = []
    for b in raw:
        if not isinstance(b, dict):
            continue
        try:
            lat, lng = b.get("lat"), b.get("lng")
            if lat is None or lng is None:
                continue
            out.append({
                "name":     b.get("name") or "Installation",
                "country":  b.get("country") or "",
                "operator": b.get("operator") or "",
                "branch":   b.get("branch") or "",
                "lat":      float(lat),
                "lon":      float(lng),
            })
        except (TypeError, ValueError):
            continue
    _military_bases_cache = out
    return out


_NUCLEAR_PATH = os.path.join(os.path.dirname(__file__), "nuclear_facilities.json")
_nuclear_cache: Optional[List[Dict]] = None


def get_nuclear_facilities() -> List[Dict]:
    """
    Nuclear facilities reference data from bundled nuclear_facilities.json (lat/lng → lon).
    Loaded once per process.
    """
    global _nuclear_cache
    if _nuclear_cache is not None:
        return _nuclear_cache
    try:
        with open(_NUCLEAR_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as exc:
        logger.warning("Could not load nuclear_facilities.json: %s", exc)
        _nuclear_cache = []
        return []

    out: List[Dict] = []
    for b in raw:
        if not isinstance(b, dict):
            continue
        try:
            lat, lng = b.get("lat"), b.get("lng")
            if lat is None or lng is None:
                continue
            notes = b.get("notes") or ""
            if len(notes) > 500:
                notes = notes[:497] + "…"
            out.append({
                "name":          b.get("name") or "Facility",
                "country":       b.get("country") or "",
                "type":          b.get("type") or "",
                "status":        b.get("status") or "",
                "operator":      b.get("operator") or "",
                "threat_level":  (b.get("threat_level") or "").lower(),
                "notes":         notes,
                "lat":           float(lat),
                "lon":           float(lng),
            })
        except (TypeError, ValueError):
            continue
    _nuclear_cache = out
    return out


# ── 10. Static lists: broadcasts & cameras ────────────────────────────────────
def get_broadcasts() -> List[Dict]:
    """Return curated free radio streams (static config list)."""
    return BROADCAST_STREAMS


def get_cameras() -> List[Dict]:
    """Return curated public camera/live-feed list (static config list)."""
    return PUBLIC_CAMERAS


# ── 11. Merged OSINT feed (RSS + Telegram/RSShub) ────────────────────────────
def get_all_osint() -> List[Dict]:
    """
    Combine RSS + Telegram OSINT into one deduped feed.
    Sorted by severity then recency.
    """
    rss   = get_news()      or []
    tg    = get_rsshub_news() or []

    seen  = {a["id"] for a in rss}
    dedup_tg = [a for a in tg if a["id"] not in seen]

    combined = rss + dedup_tg
    # Highest severity first, and newest first within each severity bucket.
    combined.sort(
        key=lambda a: (a.get("severity_score", 0), a.get("published", "")),
        reverse=True,
    )
    return combined