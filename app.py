from __future__ import annotations

import json
import logging
import os
import random
import time
from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
from itertools import combinations
from math import comb
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from dotenv import load_dotenv
import httpx
import ormsgpack
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("refinery")

_APP_DIR = Path(__file__).resolve().parent
load_dotenv(_APP_DIR / ".env")


def _app_relative_path(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = _APP_DIR / path
    return path.resolve()


def _int_env(name: str, default: int, min_value: int = 0) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(min_value, value)


def _float_env(name: str, default: float, min_value: float = 0.0) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return max(min_value, value)


REF_ROOT = _app_relative_path(os.environ.get("REFERENCE_ROOT", "refs"))
FISH_TTS_URL = os.environ.get("FISH_TTS_URL", "http://127.0.0.1:8080/v1/tts")
FISH_API_KEY = os.environ.get("FISH_API_KEY")
FISH_MODEL = os.environ.get("FISH_MODEL", "s2-pro")
PORT = _int_env("PORT", 5055, min_value=1)
MAX_REFS_PER_VARIANT = 5
MAX_VARIANTS = 12
MAX_TEXTS_PER_VARIANT = 8
MAX_STYLES_PER_RUN = 4
MAX_TEXT_CHARS = 2000
MAX_TTS_CACHE_ITEMS = _int_env("MAX_TTS_CACHE_ITEMS", 256)
FISH_TTS_TIMEOUT_SECONDS = _float_env("FISH_TTS_TIMEOUT_SECONDS", 0.0)
FISH_CONNECT_TIMEOUT_SECONDS = _float_env(
    "FISH_CONNECT_TIMEOUT_SECONDS", 10.0, min_value=0.1
)

DEFAULT_TTS_SETTINGS = {
    "model": FISH_MODEL,
    "temperature": 0.7,
    "top_p": 0.7,
    "repetition_penalty": 1.2,
    "chunk_length": 300,
    "max_new_tokens": 1024,
    "latency": "normal",
    "normalize": True,
    "condition_on_previous_chunks": True,
    "prosody": {
        "speed": 1.0,
        "volume": 0.0,
        "normalize_loudness": True,
    },
}

_TTS_CACHE: OrderedDict[str, bytes] = OrderedDict()

_HEALTH_CACHE: Dict[str, Any] = {"ts": 0.0, "data": None}
_HEALTH_TTL = 5.0
_HEALTH_TIMEOUT = 2.5

_TEXTS_FILE = _APP_DIR / "texts.json"
_FALLBACK_TEXTS = [
    "The quick brown fox jumps over the lazy dog.",
    "She sells seashells by the seashore on sunny summer days.",
    "Welcome home. All systems are running normally.",
]


def _load_texts_data() -> dict | list:
    """Load texts.json as-is (dict of moods or flat list)."""
    if _TEXTS_FILE.exists():
        try:
            data = json.loads(_TEXTS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, (dict, list)):
                return data
        except (json.JSONDecodeError, OSError):
            log.warning("Failed to load %s, using fallback texts", _TEXTS_FILE)
    return _FALLBACK_TEXTS


TEXTS_DATA = _load_texts_data()


def _flatten_texts(data: dict | list) -> list[str]:
    """Flatten texts data to a single list for API fallback."""
    if isinstance(data, list):
        return [t for t in data if isinstance(t, str)]
    texts = []
    for v in data.values():
        if isinstance(v, list):
            texts.extend(t for t in v if isinstance(t, str))
    return texts or _FALLBACK_TEXTS


DEFAULT_TEXTS = _flatten_texts(TEXTS_DATA)

app = FastAPI()
templates = Jinja2Templates(directory=_APP_DIR / "templates")
app.mount("/static", StaticFiles(directory=_APP_DIR / "static"), name="static")


@dataclass
class RefFile:
    wav: Path
    lab: Path
    text: str


def _ref_set_key(ref_dir: Path) -> str:
    return ref_dir.relative_to(REF_ROOT).as_posix()


def _list_ref_files(ref_dir: Path) -> List[RefFile]:
    refs: List[RefFile] = []
    for wav in sorted(ref_dir.glob("*.wav")):
        lab = wav.with_suffix(".lab")
        if not lab.exists():
            continue
        refs.append(
            RefFile(wav=wav, lab=lab, text=lab.read_text(encoding="utf-8").strip())
        )
    return refs


def list_voices() -> Dict[str, List[RefFile]]:
    voices: Dict[str, List[RefFile]] = {}
    if not REF_ROOT.exists():
        return voices
    for voice_dir in sorted(p for p in REF_ROOT.rglob("*") if p.is_dir()):
        refs = _list_ref_files(voice_dir)
        if refs:
            voices[_ref_set_key(voice_dir)] = refs
    return voices


def _clamp_float(
    value: Any, default: float, min_value: float, max_value: float
) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(max_value, number))


def _clamp_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(max_value, number))


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def normalize_tts_settings(raw: Optional[dict]) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    defaults = DEFAULT_TTS_SETTINGS
    raw_prosody = raw.get("prosody") if isinstance(raw.get("prosody"), dict) else {}
    default_prosody = defaults["prosody"]

    model = str(raw.get("model") or defaults["model"]).strip() or defaults["model"]
    if model not in {"s2-pro", "s1"}:
        model = defaults["model"]

    latency = str(raw.get("latency") or defaults["latency"]).strip()
    if latency not in {"normal", "balanced", "low"}:
        latency = defaults["latency"]

    return {
        "model": model,
        "temperature": _clamp_float(
            raw.get("temperature"), defaults["temperature"], 0.0, 1.0
        ),
        "top_p": _clamp_float(raw.get("top_p"), defaults["top_p"], 0.0, 1.0),
        "repetition_penalty": _clamp_float(
            raw.get("repetition_penalty"),
            defaults["repetition_penalty"],
            1.0,
            2.0,
        ),
        "chunk_length": _clamp_int(
            raw.get("chunk_length"), defaults["chunk_length"], 100, 300
        ),
        "max_new_tokens": _clamp_int(
            raw.get("max_new_tokens"),
            defaults["max_new_tokens"],
            256,
            2048,
        ),
        "latency": latency,
        "normalize": _as_bool(raw.get("normalize"), defaults["normalize"]),
        "condition_on_previous_chunks": _as_bool(
            raw.get("condition_on_previous_chunks"),
            defaults["condition_on_previous_chunks"],
        ),
        "prosody": {
            "speed": _clamp_float(
                raw_prosody.get("speed"), default_prosody["speed"], 0.5, 2.0
            ),
            "volume": _clamp_float(
                raw_prosody.get("volume"), default_prosody["volume"], -24.0, 24.0
            ),
            "normalize_loudness": _as_bool(
                raw_prosody.get("normalize_loudness"),
                default_prosody["normalize_loudness"],
            ),
        },
    }


def sanitize_texts(raw: Any) -> list[str]:
    values = raw if isinstance(raw, list) else DEFAULT_TEXTS[:MAX_TEXTS_PER_VARIANT]
    texts = []
    for item in values:
        if not isinstance(item, str):
            continue
        text = item.strip()
        if text:
            texts.append(text[:MAX_TEXT_CHARS])
    return texts or DEFAULT_TEXTS[:MAX_TEXTS_PER_VARIANT]


def sanitize_name_list(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        name = item.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def sanitize_ref_scores(raw: Any) -> Dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, float] = {}
    for name, value in raw.items():
        if not isinstance(name, str):
            continue
        try:
            score = float(value)
        except (TypeError, ValueError):
            continue
        if score == 0:
            continue
        out[name] = max(-10.0, min(10.0, score))
    return out


def sanitize_styles(raw: Any) -> list[str]:
    values = raw if isinstance(raw, list) else [""]
    styles: list[str] = []
    seen = set()
    for item in values:
        if not isinstance(item, str):
            continue
        style = item.strip()
        key = style.lower()
        if key in seen:
            continue
        seen.add(key)
        styles.append(style[:120])
        if len(styles) >= MAX_STYLES_PER_RUN:
            break
    return styles or [""]


def extract_leading_tags(text: str) -> tuple[list[str], str]:
    tags: list[str] = []
    rest = text.strip()
    while rest.startswith("["):
        close = rest.find("]")
        if close <= 1:
            break
        tag_text = rest[1:close].strip()
        if not tag_text or "[" in tag_text:
            break
        tags.append(f"[{tag_text}]")
        rest = rest[close + 1 :].lstrip()
    if not rest:
        return [], text.strip()
    return tags, rest


def build_samples(texts: list[str], styles: list[str]) -> list[dict]:
    samples = []
    for style in styles:
        for text in texts:
            phrase_tags, base_text = extract_leading_tags(text)
            display_style = " ".join([*phrase_tags, style]).strip()
            render_text = f"{style} {base_text}" if style else base_text
            samples.append(
                {
                    "style": display_style,
                    "base_text": base_text,
                    "text": render_text,
                }
            )
    return samples


def build_fish_request(text: str, chosen_refs: List[RefFile], settings: dict) -> Dict:
    refs_payload = []
    for ref in chosen_refs:
        audio_bytes = ref.wav.read_bytes()
        refs_payload.append({"audio": audio_bytes, "text": ref.text})

    return {
        "text": text,
        "format": "wav",
        "chunk_length": settings["chunk_length"],
        "references": refs_payload,
        "reference_id": None,
        "normalize": settings["normalize"],
        "max_new_tokens": settings["max_new_tokens"],
        "top_p": settings["top_p"],
        "repetition_penalty": settings["repetition_penalty"],
        "temperature": settings["temperature"],
        "latency": settings["latency"],
        "condition_on_previous_chunks": settings["condition_on_previous_chunks"],
        "prosody": settings["prosody"],
    }


def build_fish_headers(settings: dict) -> dict:
    headers = {
        "content-type": "application/msgpack",
        "model": settings["model"],
    }
    if FISH_API_KEY:
        headers["Authorization"] = f"Bearer {FISH_API_KEY}"
    return headers


def build_tts_timeout() -> httpx.Timeout:
    if FISH_TTS_TIMEOUT_SECONDS <= 0:
        return httpx.Timeout(
            connect=FISH_CONNECT_TIMEOUT_SECONDS,
            read=None,
            write=None,
            pool=None,
        )
    return httpx.Timeout(
        connect=FISH_CONNECT_TIMEOUT_SECONDS,
        read=FISH_TTS_TIMEOUT_SECONDS,
        write=FISH_TTS_TIMEOUT_SECONDS,
        pool=FISH_CONNECT_TIMEOUT_SECONDS,
    )


def tts_cache_key(text: str, chosen_refs: list[RefFile], settings: dict) -> str:
    ref_state = []
    for ref in chosen_refs:
        stat = ref.wav.stat()
        try:
            ref_name = ref.wav.relative_to(REF_ROOT).as_posix()
        except ValueError:
            ref_name = str(ref.wav)
        ref_state.append(
            {
                "name": ref_name,
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "text": ref.text,
            }
        )
    payload = {
        "text": text,
        "refs": ref_state,
        "settings": settings,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def cache_get(key: str) -> Optional[bytes]:
    if MAX_TTS_CACHE_ITEMS <= 0:
        return None
    audio = _TTS_CACHE.get(key)
    if audio is not None:
        _TTS_CACHE.move_to_end(key)
    return audio


def cache_set(key: str, audio: bytes) -> None:
    if MAX_TTS_CACHE_ITEMS <= 0:
        return
    _TTS_CACHE[key] = audio
    _TTS_CACHE.move_to_end(key)
    while len(_TTS_CACHE) > MAX_TTS_CACHE_ITEMS:
        _TTS_CACHE.popitem(last=False)


SCORE_WEIGHT_BASE = 2.0
SCORE_WEIGHT_MIN = 0.05
SCORE_WEIGHT_MAX = 16.0


def _score_to_weight(score: float) -> float:
    """Map a cell-aggregated score to a multiplicative selection weight.

    score = 0 → weight 1. Each +1 doubles, each -1 halves. Clamped to keep one
    big winner or loser from collapsing the distribution.
    """
    weight = SCORE_WEIGHT_BASE**score
    return max(SCORE_WEIGHT_MIN, min(SCORE_WEIGHT_MAX, weight))


def _weighted_pick(
    refs: List[RefFile],
    n: int,
    weights_by_name: Dict[str, float],
    preferred_names: set[str],
    require_preferred: bool,
) -> Optional[List[RefFile]]:
    if n == 0:
        return []
    if not refs:
        return None
    available = refs[:]
    chosen: List[RefFile] = []
    while len(chosen) < n and available:
        weights = [weights_by_name.get(r.wav.name, 1.0) for r in available]
        idx = random.choices(range(len(available)), weights=weights, k=1)[0]
        chosen.append(available.pop(idx))
    if (
        require_preferred
        and preferred_names
        and not any(r.wav.name in preferred_names for r in chosen)
    ):
        return None
    return chosen


def choose_combinations(
    refs: List[RefFile],
    n: int,
    limit: int,
    ref_scores: Optional[Dict[str, float]] = None,
    pinned: Optional[List[str]] = None,
    excluded: Optional[List[str]] = None,
) -> List[List[RefFile]]:
    """Pick `limit` distinct ref combinations of size `n`.

    `ref_scores` maps ref filename → signed score (typically the sum of
    per-cell +1/-1 ratings). A positive score makes a ref more likely to be
    picked; a negative score makes it less likely. Refs not in the map are
    weight 1. At least half of the returned combos are guaranteed to contain
    at least one *preferred* ref (score > 0), when any exist.

    `pinned` is a hard-include list: every returned combo must contain pinned
    refs up to the requested combo size. `excluded` is a hard-exclude list:
    those refs are removed from the pool before sampling.
    """
    excluded_set = set(excluded or [])
    refs = [r for r in refs if r.wav.name not in excluded_set]
    if not refs:
        return []

    n = max(1, min(n, MAX_REFS_PER_VARIANT, len(refs)))

    pinned_names = [name for name in (pinned or []) if name not in excluded_set]
    pinned_refs = [r for r in refs if r.wav.name in set(pinned_names)]
    if len(pinned_refs) > n:
        pinned_refs = pinned_refs[:n]
    pinned_set = {r.wav.name for r in pinned_refs}
    pool_refs = [r for r in refs if r.wav.name not in pinned_set]

    free_slots = max(0, n - len(pinned_refs))
    total_combos = (
        comb(len(pool_refs), free_slots) if free_slots <= len(pool_refs) else 0
    ) or 1
    limit = max(1, min(limit, MAX_VARIANTS, total_combos))

    scores = ref_scores or {}
    weights_by_name = {
        name: _score_to_weight(float(score)) for name, score in scores.items()
    }
    available_names = {r.wav.name for r in refs}
    preferred_names = {
        name
        for name, score in scores.items()
        if float(score) > 0 and name in available_names
    }

    combos: List[List[RefFile]] = []
    seen = set()

    def add_combo(combo: Optional[List[RefFile]]):
        if not combo or len(combo) != n:
            return False
        key = tuple(sorted(r.wav.name for r in combo))
        if key in seen:
            return False
        seen.add(key)
        combos.append(combo)
        return True

    target_preferred = (limit + 1) // 2 if preferred_names else 0
    attempts = 0
    max_attempts = max(50, limit * 10)

    while len(combos) < limit and attempts < max_attempts:
        require_preferred = len(combos) < target_preferred
        free = _weighted_pick(
            pool_refs,
            free_slots,
            weights_by_name,
            preferred_names,
            require_preferred=require_preferred,
        )
        if free is None:
            break
        add_combo(pinned_refs + free)
        attempts += 1

    if len(combos) < limit and free_slots > 0:
        remaining = list(combinations(pool_refs, free_slots))
        random.shuffle(remaining)
        for tail in remaining:
            add_combo(pinned_refs + list(tail))
            if len(combos) >= limit:
                break

    if len(combos) < limit and free_slots == 0 and pinned_refs:
        # All slots pinned: the only combo is the pinned set itself.
        add_combo(pinned_refs[:])

    return combos[:limit]


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    voices = list_voices()
    voice_refs = {name: [r.wav.name for r in refs] for name, refs in voices.items()}
    boot_payload = {
        "voices": list(voices.keys()),
        "voiceRefs": voice_refs,
        "maxRefs": MAX_REFS_PER_VARIANT,
        "maxVariants": MAX_VARIANTS,
        "maxTexts": MAX_TEXTS_PER_VARIANT,
        "textsData": TEXTS_DATA,
        "defaultSettings": DEFAULT_TTS_SETTINGS,
    }
    return templates.TemplateResponse(
        request,
        "index.html",
        context={
            "voices": voices,
            "voice_refs": voice_refs,
            "texts_data": TEXTS_DATA,
            "max_refs": MAX_REFS_PER_VARIANT,
            "max_variants": MAX_VARIANTS,
            "max_texts": MAX_TEXTS_PER_VARIANT,
            "default_tts_settings": DEFAULT_TTS_SETTINGS,
            "boot_payload": boot_payload,
        },
    )


def _fish_endpoint_kind() -> str:
    """Categorize the configured Fish endpoint so the UI can show targeted setup."""
    parsed = urlparse(FISH_TTS_URL)
    host = (parsed.hostname or "").lower()
    if host in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}:
        return "local"
    if host.endswith("fish.audio"):
        return "hosted"
    return "custom"


@app.get("/api/health")
async def health(refresh: bool = False):
    """Probe the configured Fish endpoint; cache for ~5s to avoid hammering."""
    now = time.time()
    if (
        not refresh
        and _HEALTH_CACHE["data"]
        and now - _HEALTH_CACHE["ts"] < _HEALTH_TTL
    ):
        return _HEALTH_CACHE["data"]

    url = FISH_TTS_URL
    kind = _fish_endpoint_kind()
    base = {
        "url": url,
        "kind": kind,
        "model": FISH_MODEL,
        "has_key": bool(FISH_API_KEY),
    }

    try:
        async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT) as client:
            # /v1/tts is POST-only; HEAD usually yields 405 — that's still "reachable".
            resp = await client.request("HEAD", url)
        if resp.status_code in (401, 403):
            data = {**base, "fish": "unauthorized", "status": resp.status_code}
        else:
            data = {**base, "fish": "ok", "status": resp.status_code}
    except httpx.ConnectError:
        data = {**base, "fish": "offline", "error": "connection refused"}
    except httpx.ConnectTimeout:
        data = {**base, "fish": "offline", "error": "connect timeout"}
    except httpx.TimeoutException:
        data = {**base, "fish": "offline", "error": "timeout"}
    except httpx.RequestError as e:
        data = {**base, "fish": "offline", "error": str(e)[:200]}

    _HEALTH_CACHE["ts"] = now
    _HEALTH_CACHE["data"] = data
    return data


@app.get("/api/refs/{ref_path:path}")
async def serve_ref(ref_path: str):
    """Stream a source reference .wav so the UI can preview what each ref sounds like."""
    if "/" not in ref_path:
        raise HTTPException(status_code=400, detail="Invalid ref path")
    voice, filename = ref_path.rsplit("/", 1)
    voices = list_voices()
    if voice not in voices:
        raise HTTPException(status_code=404, detail="Unknown voice")
    if (
        not filename.endswith(".wav")
        or "/" in filename
        or "\\" in filename
        or ".." in filename
    ):
        raise HTTPException(status_code=400, detail="Invalid filename")
    ref_map = {r.wav.name: r for r in voices[voice]}
    ref = ref_map.get(filename)
    if ref is None or not ref.wav.is_file():
        raise HTTPException(status_code=404, detail="Ref not found")
    return FileResponse(ref.wav, media_type="audio/wav")


@app.post("/api/tts")
async def synthesize(payload: dict):
    voice = payload.get("voice")
    text = str(payload.get("text") or "").strip()
    raw_ref_names = payload.get("refs", [])
    if not voice or not text or not isinstance(raw_ref_names, list):
        raise HTTPException(status_code=400, detail="voice, text, refs required")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"text must be {MAX_TEXT_CHARS} characters or less",
        )

    ref_names = sanitize_name_list(raw_ref_names)
    if len(ref_names) > MAX_REFS_PER_VARIANT:
        raise HTTPException(
            status_code=400,
            detail=f"refs must contain {MAX_REFS_PER_VARIANT} items or fewer",
        )

    voices = list_voices()
    if voice not in voices:
        raise HTTPException(status_code=404, detail="Unknown voice")

    ref_map = {r.wav.name: r for r in voices[voice]}
    chosen = [ref_map[name] for name in ref_names if name in ref_map]
    if not chosen:
        raise HTTPException(status_code=400, detail="No valid refs selected")

    settings = normalize_tts_settings(payload.get("settings"))
    cache_key = tts_cache_key(text, chosen, settings)
    cached_audio = cache_get(cache_key)
    if cached_audio is not None:
        return Response(
            content=cached_audio,
            media_type="audio/wav",
            headers={"x-refinery-cache": "hit"},
        )

    fish_req = build_fish_request(text, chosen, settings)
    packed = ormsgpack.packb(fish_req)

    log.info(
        "tts_request",
        extra={
            "voice": voice,
            "refs": ref_names,
            "text_len": len(text),
            "fish_url": FISH_TTS_URL,
            "model": settings["model"],
            "timeout_seconds": (
                FISH_TTS_TIMEOUT_SECONDS if FISH_TTS_TIMEOUT_SECONDS > 0 else None
            ),
        },
    )

    try:
        async with httpx.AsyncClient(timeout=build_tts_timeout()) as client:
            resp = await client.post(
                FISH_TTS_URL,
                content=packed,
                headers=build_fish_headers(settings),
            )
    except httpx.TimeoutException as e:
        log.error("fish_request_timeout", exc_info=True)
        _HEALTH_CACHE["data"] = None
        raise HTTPException(status_code=504, detail=f"Upstream timeout: {e}")
    except httpx.RequestError as e:
        log.error("fish_request_failed", exc_info=True)
        # Invalidate health cache so the UI can re-check and show setup.
        _HEALTH_CACHE["data"] = None
        raise HTTPException(status_code=502, detail=f"Upstream connection error: {e}")

    if resp.status_code != 200:
        upstream_text = resp.text[:500]
        log.error(
            "fish_bad_status",
            extra={"status": resp.status_code, "text": upstream_text},
        )
        raise HTTPException(
            status_code=502,
            detail=f"Fish-Speech upstream error {resp.status_code}: {upstream_text}",
        )

    cache_set(cache_key, resp.content)
    return Response(
        content=resp.content,
        media_type="audio/wav",
        headers={"x-refinery-cache": "miss"},
    )


@app.post("/api/variants")
async def generate_variants(payload: dict):
    """
    Create variant plans: combinations of refs (size n_refs) for a voice.
    Returns metadata only; client calls /api/tts for audio fetch.
    """
    voice = payload.get("voice")
    n_refs = _clamp_int(payload.get("n_refs"), 3, 1, MAX_REFS_PER_VARIANT)
    limit = _clamp_int(payload.get("limit"), 6, 1, MAX_VARIANTS)
    texts = sanitize_texts(payload.get("texts"))
    if len(texts) > MAX_TEXTS_PER_VARIANT:
        raise HTTPException(
            status_code=400,
            detail=f"Select {MAX_TEXTS_PER_VARIANT} phrases or fewer",
        )
    styles = sanitize_styles(payload.get("styles"))
    settings = normalize_tts_settings(payload.get("settings"))
    ref_scores = sanitize_ref_scores(payload.get("ref_scores"))
    pinned = sanitize_name_list(payload.get("pinned"))
    excluded = sanitize_name_list(payload.get("excluded"))

    voices = list_voices()
    if voice not in voices:
        raise HTTPException(status_code=404, detail="Unknown voice")
    refs = voices[voice]
    if not [r for r in refs if r.wav.name not in set(excluded)]:
        raise HTTPException(
            status_code=400,
            detail="No refs available after exclusions",
        )
    combos = choose_combinations(
        refs, n_refs, limit, ref_scores=ref_scores, pinned=pinned, excluded=excluded
    )
    if not combos:
        raise HTTPException(status_code=400, detail="No valid ref combinations")
    samples = build_samples(texts, styles)
    log.info(
        "variant_plan",
        extra={
            "voice": voice,
            "n_refs": n_refs,
            "variants": len(combos),
            "texts": len(texts),
            "styles": len(styles),
            "ref_pool_size": len(refs),
        },
    )

    plans = []
    for idx, combo in enumerate(combos, start=1):
        plans.append(
            {
                "id": idx,
                "ref_names": [c.wav.name for c in combo],
                "samples": samples,
                "texts": [sample["text"] for sample in samples],
                "settings": settings,
            }
        )
    return {"voice": voice, "plans": plans, "settings": settings}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=True)
