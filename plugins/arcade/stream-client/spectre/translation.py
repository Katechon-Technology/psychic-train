"""
Translation helpers for feed ingestion.

- Detect source language with langid (normalized probability confidence).
- Translate non-English text to English with Argos Translate.
- Best effort only: failures never raise to callers.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
from typing import Optional, Tuple

import langid
from langid.langid import LanguageIdentifier, model

logger = logging.getLogger(__name__)


def _translation_logs_enabled() -> bool:
    return os.getenv("SPECTRE_TRANSLATION_LOGS", "").strip().lower() in {"1", "true", "yes", "on"}


if not _translation_logs_enabled():
    # Hard-disable noisy third-party translation loggers from stdout/stderr.
    for _name in ("argostranslate", "argostranslate.utils", "stanza", "stanza.models"):
        _l = logging.getLogger(_name)
        _l.setLevel(logging.CRITICAL + 1)
        _l.disabled = True
        _l.propagate = False
    # Keep our translation module silent too unless explicitly enabled.
    logger.setLevel(logging.CRITICAL + 1)
    logger.disabled = True
    logger.propagate = False

_IDENTIFIER = LanguageIdentifier.from_modelstring(model, norm_probs=True)
_MIN_CONFIDENCE = float(os.getenv("SPECTRE_LANGID_MIN_CONF", "0.85"))

def _default_model_dir() -> str:
    # Railway users often mount a persistent volume at /data.
    env_dir = os.getenv("SPECTRE_ARGOS_MODEL_DIR", "").strip()
    if env_dir:
        return env_dir
    railway_data = os.getenv("RAILWAY_VOLUME_MOUNT_PATH", "").strip() or "/data"
    if os.path.isdir(railway_data):
        return os.path.join(railway_data, "spectre_argos")
    return os.path.join(os.path.dirname(__file__), ".argos_packages")


# Persist downloaded Argos model files so restarts/redeploys can reuse them.
_ARGOS_MODEL_DIR = _default_model_dir()
_REQUIRED_PAIRS = (("ru", "en"), ("uk", "en"), ("ar", "en"), ("zh", "en"))

_argos_lock = threading.Lock()
_argos_initialized = False
_argos_available = False


def _detect_language(text: str) -> Tuple[Optional[str], float]:
    if not text or not text.strip():
        return None, 0.0
    try:
        lang, conf = _IDENTIFIER.classify(text)
        return str(lang), float(conf)
    except Exception:
        return None, 0.0


def _translation_exists(src_lang: str, dst_lang: str, translate_mod) -> bool:
    try:
        installed = translate_mod.get_installed_languages()
        src_obj = next((l for l in installed if l.code == src_lang), None)
        dst_obj = next((l for l in installed if l.code == dst_lang), None)
        if not src_obj or not dst_obj:
            return False
        _ = src_obj.get_translation(dst_obj)
        return True
    except Exception:
        return False


def _ensure_argos_ready() -> bool:
    global _argos_initialized, _argos_available
    with _argos_lock:
        if _argos_initialized:
            return _argos_available
        _argos_initialized = True
        os.makedirs(_ARGOS_MODEL_DIR, exist_ok=True)
        # Keep Argos data inside the persisted directory whenever possible.
        os.environ.setdefault("ARGOS_PACKAGES_DIR", _ARGOS_MODEL_DIR)
        try:
            import argostranslate.package as argos_package
            import argostranslate.translate as argos_translate
        except Exception as exc:
            logger.warning("Argos Translate unavailable: %s", exc)
            _argos_available = False
            return False

        try:
            argos_package.update_package_index()
            available = argos_package.get_available_packages()
        except Exception as exc:
            logger.warning("Argos package index update failed: %s", exc)
            available = []

        for src, dst in _REQUIRED_PAIRS:
            try:
                if _translation_exists(src, dst, argos_translate):
                    continue
                local_model = os.path.join(_ARGOS_MODEL_DIR, f"{src}_{dst}.argosmodel")
                if not os.path.exists(local_model):
                    pkg = next(
                        (p for p in available if p.from_code == src and p.to_code == dst),
                        None,
                    )
                    if not pkg:
                        logger.warning("Argos model not found for %s->%s", src, dst)
                        continue
                    downloaded = pkg.download()
                    try:
                        shutil.copy2(downloaded, local_model)
                    except Exception:
                        local_model = downloaded
                argos_package.install_from_path(local_model)
            except Exception as exc:
                logger.warning("Argos model install failed for %s->%s: %s", src, dst, exc)

        _argos_available = any(
            _translation_exists(src, dst, argos_translate) for src, dst in _REQUIRED_PAIRS
        )
        if not _argos_available:
            logger.warning("Argos translation models unavailable; continuing without translation")
        return _argos_available


def _translate_to_english(text: str, src_lang: str) -> str:
    try:
        import argostranslate.translate as argos_translate

        installed = argos_translate.get_installed_languages()
        src_obj = next((l for l in installed if l.code == src_lang), None)
        en_obj = next((l for l in installed if l.code == "en"), None)
        if not src_obj or not en_obj:
            return text
        translation = src_obj.get_translation(en_obj)
        translated = translation.translate(text)
        return translated if translated else text
    except Exception:
        return text


def translate_if_needed(text: str) -> Tuple[str, Optional[str]]:
    """
    Translate non-English text to English.
    Returns (translated_text, detected_source_lang).
    - If text is English or confidence is low, returns (original_text, None)
    - On any failure, returns original text without raising
    """
    if not text:
        return text, None

    src_lang, confidence = _detect_language(text)
    if not src_lang or src_lang == "en":
        return text, None
    if confidence < _MIN_CONFIDENCE:
        return text, None
    if not _ensure_argos_ready():
        return text, src_lang

    translated = _translate_to_english(text, src_lang)
    return translated, src_lang


def preinstall_argos_models() -> None:
    """
    Best-effort startup installer for required translation models.
    Safe to call repeatedly.
    """
    _ensure_argos_ready()
