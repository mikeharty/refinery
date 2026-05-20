import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app


client = TestClient(app.app)


def _sample_voice() -> tuple[str, list[str]]:
    voices = app.list_voices()
    refs = voices["ljspeech_linda_johnson"]
    return "ljspeech_linda_johnson", [ref.wav.name for ref in refs]


def test_lists_bundled_sample_refs() -> None:
    voice, ref_names = _sample_voice()

    assert voice == "ljspeech_linda_johnson"
    assert len(ref_names) >= app.MAX_REFS_PER_VARIANT + 1


def _write_ref_pair(ref_dir: Path, stem: str, transcript: str = "hello") -> None:
    ref_dir.mkdir(parents=True, exist_ok=True)
    (ref_dir / f"{stem}.wav").write_bytes(b"RIFF")
    (ref_dir / f"{stem}.lab").write_text(transcript, encoding="utf-8")


def test_list_voices_discovers_nested_mood_ref_sets(monkeypatch, tmp_path) -> None:
    ref_root = tmp_path / "refs"
    _write_ref_pair(ref_root / "bender-moods" / "angry", "angry_01", "angry line")
    _write_ref_pair(ref_root / "bender-moods" / "tired", "tired_01", "tired line")

    monkeypatch.setattr(app, "REF_ROOT", ref_root)

    voices = app.list_voices()

    assert sorted(voices) == ["bender-moods/angry", "bender-moods/tired"]
    assert [ref.wav.name for ref in voices["bender-moods/angry"]] == ["angry_01.wav"]


def test_nested_mood_ref_set_can_generate_variants_and_preview_audio(
    monkeypatch, tmp_path
) -> None:
    ref_root = tmp_path / "refs"
    _write_ref_pair(ref_root / "bender-moods" / "angry", "angry_01", "angry one")
    _write_ref_pair(ref_root / "bender-moods" / "angry", "angry_02", "angry two")

    monkeypatch.setattr(app, "REF_ROOT", ref_root)

    response = client.post(
        "/api/variants",
        json={
            "voice": "bender-moods/angry",
            "n_refs": 1,
            "limit": 1,
            "texts": ["bite my shiny metal line"],
        },
    )

    assert response.status_code == 200
    assert response.json()["voice"] == "bender-moods/angry"
    preview = client.get("/api/refs/bender-moods/angry/angry_01.wav")
    assert preview.status_code == 200
    assert preview.content == b"RIFF"


def test_variants_generate_sanitized_plans() -> None:
    voice, _ = _sample_voice()

    response = client.post(
        "/api/variants",
        json={
            "voice": voice,
            "n_refs": 99,
            "limit": 99,
            "texts": ["  a short test phrase  "],
            "styles": ["", "[calm]", "[CALM]"],
            "settings": {"temperature": 99, "prosody": {"speed": 0}},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["voice"] == voice
    assert 1 <= len(body["plans"]) <= app.MAX_VARIANTS
    assert all(len(plan["ref_names"]) <= app.MAX_REFS_PER_VARIANT for plan in body["plans"])
    assert body["plans"][0]["samples"] == [
        {
            "style": "",
            "base_text": "a short test phrase",
            "text": "a short test phrase",
        },
        {
            "style": "[calm]",
            "base_text": "a short test phrase",
            "text": "[calm] a short test phrase",
        },
    ]
    assert body["settings"]["temperature"] == 1.0
    assert body["settings"]["prosody"]["speed"] == 0.5


def test_build_samples_extracts_phrase_tags_without_speaking_them() -> None:
    samples = app.build_samples(
        ["[neutral] This should not start with neutral.", "[soft tone] [tired] Keep it low."],
        [""],
    )

    assert samples == [
        {
            "style": "[neutral]",
            "base_text": "This should not start with neutral.",
            "text": "This should not start with neutral.",
        },
        {
            "style": "[soft tone] [tired]",
            "base_text": "Keep it low.",
            "text": "Keep it low.",
        },
    ]


def test_build_samples_combines_phrase_tags_with_explicit_style_prompt() -> None:
    samples = app.build_samples(["[neutral] Keep it steady."], ["[calm]"])

    assert samples == [
        {
            "style": "[neutral] [calm]",
            "base_text": "Keep it steady.",
            "text": "[calm] Keep it steady.",
        }
    ]


def test_variants_return_400_when_exclusions_empty_ref_pool() -> None:
    voice, ref_names = _sample_voice()

    response = client.post(
        "/api/variants",
        json={
            "voice": voice,
            "n_refs": 3,
            "limit": 6,
            "texts": ["hello"],
            "excluded": ref_names,
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "No refs available after exclusions"


def test_tts_rejects_too_many_refs_before_upstream_call() -> None:
    voice, ref_names = _sample_voice()

    response = client.post(
        "/api/tts",
        json={
            "voice": voice,
            "text": "hello",
            "refs": ref_names[: app.MAX_REFS_PER_VARIANT + 1],
        },
    )

    assert response.status_code == 400
    assert "refs must contain" in response.json()["detail"]


def test_build_tts_timeout_waits_indefinitely_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(app, "FISH_TTS_TIMEOUT_SECONDS", 0.0)
    monkeypatch.setattr(app, "FISH_CONNECT_TIMEOUT_SECONDS", 12.5)

    timeout = app.build_tts_timeout()

    assert timeout.connect == 12.5
    assert timeout.read is None
    assert timeout.write is None
    assert timeout.pool is None


def test_tts_deduplicates_refs_before_validating_selection(monkeypatch) -> None:
    voice, ref_names = _sample_voice()
    app._TTS_CACHE.clear()
    captured: dict[str, list[str]] = {}

    original_build = app.build_fish_request

    def capture_build_fish_request(text, chosen_refs, settings):
        captured["refs"] = [ref.wav.name for ref in chosen_refs]
        return original_build(text, chosen_refs, settings)

    class FakeResponse:
        status_code = 200
        content = b"RIFF"
        text = ""

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(app, "build_fish_request", capture_build_fish_request)
    monkeypatch.setattr(app.httpx, "AsyncClient", FakeAsyncClient)

    response = client.post(
        "/api/tts",
        json={
            "voice": voice,
            "text": "dedupe test",
            "refs": [ref_names[0]] * (app.MAX_REFS_PER_VARIANT + 2),
        },
    )

    assert response.status_code == 200
    assert captured["refs"] == [ref_names[0]]
