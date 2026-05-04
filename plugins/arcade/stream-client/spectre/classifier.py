"""
Keyword-based threat classifier.
Two-tier: instant keyword match + optional confidence boosting.
"""

from typing import Dict, List

# ── Severity tiers (highest match wins) ──────────────────────────────────────
SEVERITY_TIERS = [
    ("critical", 5, [
        "nuclear strike", "chemical weapon", "bioweapon", "dirty bomb",
        "declaration of war", "coup d'état", "mass casualty", "warhead launched",
        "ballistic missile", "genocide", "nuke",
    ]),
    ("high", 4, [
        "airstrike", "air strike", "bombing", "military attack", "explosion",
        "hostage", "assassination", "terrorist attack", "suicide bomb",
        "troops deployed", "invasion", "combat", "killed in action",
        "casualties", "warship", "naval blockade", "cyberattack",
        "pandemic", "epidemic outbreak", "eruption", "tsunami warning",
        "insurgent", "ambush", "siege",
    ]),
    ("medium", 3, [
        "protest", "sanction", "ceasefire", "clash", "unrest", "riot",
        "earthquake", "flood", "hurricane", "cyclone", "typhoon", "wildfire",
        "cyber breach", "data breach", "arrest", "detained", "crisis",
        "blockade", "embargo", "martial law", "state of emergency",
    ]),
    ("low", 2, [
        "tension", "warning", "threat", "concern", "demonstration",
        "dispute", "talks", "negotiations", "election", "vote", "referendum",
        "drought", "food shortage", "economic crisis",
    ]),
    ("info", 1, [
        "report", "update", "statement", "announcement", "meeting", "summit",
    ]),
]

# ── Category labels ──────────────────────────────────────────────────────────
CATEGORIES: Dict[str, List[str]] = {
    "conflict":   ["war", "battle", "attack", "military", "troops", "airstrike",
                   "bombing", "combat", "weapon", "invasion", "frontline"],
    "terrorism":  ["terror", "terrorist", "isis", "isil", "jihad", "extremist",
                   "militant", "bomb", "suicide vest", "al-qaeda", "al qaeda"],
    "cyber":      ["cyber", "hack", "ransomware", "malware", "data breach",
                   "ddos", "phishing", "espionage", "zero-day"],
    "disaster":   ["earthquake", "flood", "hurricane", "tsunami", "volcano",
                   "wildfire", "tornado", "typhoon", "cyclone", "avalanche"],
    "political":  ["coup", "election", "sanction", "protest", "riot", "unrest",
                   "crisis", "government", "parliament", "president"],
    "health":     ["outbreak", "epidemic", "pandemic", "disease", "virus",
                   "health emergency", "pathogen", "quarantine"],
    "economic":   ["market crash", "recession", "default", "inflation",
                   "collapse", "bankruptcy", "famine", "currency crisis"],
    "nuclear":    ["nuclear", "radioactive", "radiation", "warhead",
                   "missile", "icbm", "plutonium", "uranium enrichment"],
    "maritime":   ["warship", "naval", "submarine", "strait", "tanker",
                   "piracy", "coast guard", "ais dark", "blockade"],
    "aerospace":  ["airspace", "no-fly zone", "drone strike", "satellite",
                   "fighter jet", "interception", "hypersonic"],
}

SEVERITY_COLORS = {
    "critical": "#ff0040",
    "high":     "#ff6600",
    "medium":   "#ffcc00",
    "low":      "#44aaff",
    "info":     "#888888",
}


def classify(title: str, summary: str = "") -> Dict:
    """Return severity, score, categories, and color for a piece of text."""
    text = f"{title} {summary}".lower()

    # Determine severity
    severity = "info"
    severity_score = 1
    for tier_name, tier_score, keywords in SEVERITY_TIERS:
        for kw in keywords:
            if kw in text:
                if tier_score > severity_score:
                    severity = tier_name
                    severity_score = tier_score
                break  # one match per tier is enough to raise to that tier

    # Determine categories
    matched_categories = []
    for cat, keywords in CATEGORIES.items():
        if any(kw in text for kw in keywords):
            matched_categories.append(cat)

    return {
        "severity":       severity,
        "severity_score": severity_score,
        "categories":     matched_categories or ["general"],
        "color":          SEVERITY_COLORS[severity],
    }

