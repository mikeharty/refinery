import importlib.util
import sys
from types import SimpleNamespace
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "transcribe_ref_labs.py"
SPEC = importlib.util.spec_from_file_location("transcribe_ref_labs", SCRIPT_PATH)
assert SPEC is not None
transcribe_ref_labs = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = transcribe_ref_labs
assert SPEC.loader is not None
SPEC.loader.exec_module(transcribe_ref_labs)


def test_find_audio_targets_defaults_to_wav_and_matching_lab(tmp_path: Path) -> None:
    root = tmp_path / "refs"
    mood = root / "neutral"
    mood.mkdir(parents=True)
    wav = mood / "hello.wav"
    mp3 = mood / "hello.mp3"
    nested_wav = mood / "nested" / "again.WAV"
    nested_wav.parent.mkdir()
    wav.write_bytes(b"RIFF")
    mp3.write_bytes(b"ID3")
    nested_wav.write_bytes(b"RIFF")

    targets = transcribe_ref_labs.find_audio_targets(root, [".wav"])

    assert [target.relative_audio_path.as_posix() for target in targets] == [
        "neutral/hello.wav",
        "neutral/nested/again.WAV",
    ]
    assert [target.lab_path.name for target in targets] == ["hello.lab", "again.lab"]


def test_find_audio_targets_deduplicates_lab_when_multiple_extensions(
    tmp_path: Path,
) -> None:
    root = tmp_path / "refs"
    root.mkdir()
    (root / "line.wav").write_bytes(b"RIFF")
    (root / "line.mp3").write_bytes(b"ID3")

    targets = transcribe_ref_labs.find_audio_targets(root, [".wav", ".mp3"])

    assert len(targets) == 1
    assert targets[0].audio_path.name == "line.wav"


def test_normalize_transcript_collapses_to_one_lab_line() -> None:
    assert transcribe_ref_labs.normalize_transcript("  Hello,\n\tworld.  ") == "Hello, world."


def test_resolve_auto_provider_prefers_mlx_on_apple_silicon(monkeypatch) -> None:
    monkeypatch.setattr(transcribe_ref_labs, "is_apple_silicon", lambda: True)
    monkeypatch.setattr(
        transcribe_ref_labs,
        "has_python_module",
        lambda name: name == "mlx_whisper",
    )

    provider = transcribe_ref_labs.resolve_provider(
        "auto",
        whisper_command="missing-whisper-command",
        api_key="sk-test",
    )

    assert provider == "mlx-whisper"


def test_resolve_auto_provider_prefers_faster_whisper_when_available(
    monkeypatch,
) -> None:
    monkeypatch.setattr(transcribe_ref_labs, "is_apple_silicon", lambda: False)
    monkeypatch.setattr(
        transcribe_ref_labs,
        "has_python_module",
        lambda name: name == "faster_whisper",
    )

    provider = transcribe_ref_labs.resolve_provider(
        "auto",
        whisper_command="missing-whisper-command",
        api_key="sk-test",
    )

    assert provider == "faster-whisper"


def test_resolve_auto_provider_falls_back_to_openai(monkeypatch) -> None:
    monkeypatch.setattr(transcribe_ref_labs, "has_python_module", lambda name: False)
    monkeypatch.setattr(transcribe_ref_labs.shutil, "which", lambda command: None)

    provider = transcribe_ref_labs.resolve_provider(
        "auto",
        whisper_command="missing-whisper-command",
        api_key="sk-test",
    )

    assert provider == "openai"


def test_build_whisper_cli_command_includes_lab_friendly_options(tmp_path: Path) -> None:
    audio_path = tmp_path / "clip.wav"
    output_dir = tmp_path / "out"

    command = transcribe_ref_labs.build_whisper_cli_command(
        "whisper",
        audio_path,
        output_dir=output_dir,
        model="large-v3",
        language="en",
        prompt="short clip",
    )

    assert command == [
        "whisper",
        str(audio_path),
        "--model",
        "large-v3",
        "--output_format",
        "txt",
        "--output_dir",
        str(output_dir),
        "--task",
        "transcribe",
        "--verbose",
        "False",
        "--language",
        "en",
        "--initial_prompt",
        "short clip",
    ]


def test_mlx_whisper_transcriber_uses_greedy_decoding(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    def fake_transcribe(audio_path: str, **kwargs: object) -> dict[str, str]:
        captured["audio_path"] = audio_path
        captured["kwargs"] = kwargs
        return {"text": " hello world "}

    monkeypatch.setattr(transcribe_ref_labs, "is_apple_silicon", lambda: True)
    monkeypatch.setitem(
        sys.modules,
        "mlx_whisper",
        SimpleNamespace(transcribe=fake_transcribe),
    )
    audio_path = tmp_path / "clip.wav"
    audio_path.write_bytes(b"RIFF")
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=audio_path.with_suffix(".lab"),
        relative_audio_path=Path("clip.wav"),
    )
    transcriber = transcribe_ref_labs.MlxWhisperTranscriber(
        model="mlx-community/whisper-large-mlx",
        language="en",
        prompt="short clip",
    )

    result = transcriber.transcribe(target)

    assert result.text == "hello world"
    assert result.provider == "mlx-whisper"
    assert captured["audio_path"] == str(audio_path)
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["path_or_hf_repo"] == "mlx-community/whisper-large-mlx"
    assert kwargs["language"] == "en"
    assert kwargs["initial_prompt"] == "short clip"
    assert "beam_size" not in kwargs


def test_validate_transcript_rejects_prompt_leak(tmp_path: Path) -> None:
    audio_path = tmp_path / "clip.wav"
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=audio_path.with_suffix(".lab"),
        relative_audio_path=Path("clip.wav"),
    )

    try:
        transcribe_ref_labs.validate_transcript(
            "Transcribe only the spoken words. Do not add speaker labels.",
            target,
        )
    except transcribe_ref_labs.TranscriptionError as exc:
        assert "Rejected likely non-speech transcript" in str(exc)
    else:
        raise AssertionError("expected leaked prompt transcript to be rejected")


def test_validate_transcript_rejects_runaway_character_loop(tmp_path: Path) -> None:
    audio_path = tmp_path / "clip.wav"
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=audio_path.with_suffix(".lab"),
        relative_audio_path=Path("clip.wav"),
    )

    try:
        transcribe_ref_labs.validate_transcript("A" + ("H" * 140), target)
    except transcribe_ref_labs.TranscriptionError as exc:
        assert "runaway repeated character" in str(exc)
    else:
        raise AssertionError("expected repeated character transcript to be rejected")


def test_validate_transcript_rejects_runaway_pattern_loop(tmp_path: Path) -> None:
    audio_path = tmp_path / "clip.wav"
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=audio_path.with_suffix(".lab"),
        relative_audio_path=Path("clip.wav"),
    )

    try:
        transcribe_ref_labs.validate_transcript("buhduh " * 35, target)
    except transcribe_ref_labs.TranscriptionError as exc:
        assert "runaway repeated syllable" in str(exc)
    else:
        raise AssertionError("expected repeated pattern transcript to be rejected")


def test_result_status_lines_include_original_text_on_update() -> None:
    write_result = transcribe_ref_labs.WriteResult(
        changed=True,
        old_text="Filename derived text",
        backup_path=None,
    )

    assert transcribe_ref_labs.result_status_lines(
        write_result,
        "Actual spoken words.",
    ) == [
        "  updated:",
        "    old: Filename derived text",
        "    new: Actual spoken words.",
    ]


def test_rejected_summary_suggests_folder_outside_refs(tmp_path: Path) -> None:
    audio_path = tmp_path / "refs" / "voice" / "clip.wav"
    audio_path.parent.mkdir(parents=True)
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=audio_path.with_suffix(".lab"),
        relative_audio_path=Path("clip.wav"),
    )
    rejected = transcribe_ref_labs.RejectedTranscript(
        target=target,
        text="AHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
        reason="contains a runaway repeated character",
        provider="mlx-whisper",
        model="mlx-community/whisper-large-mlx",
    )
    rejected_dir = tmp_path / "rejected" / "voice"

    lines = transcribe_ref_labs.rejected_summary_lines(
        [rejected],
        rejected_dir=rejected_dir,
    )

    assert "Rejected transcript candidates: 1" in lines
    assert f"Suggestion: move the paired audio/.lab files to {rejected_dir}" in lines
    assert "That folder is outside refs/, so Refinery will not pick them up." in lines


def test_move_rejected_targets_moves_audio_and_lab_sidecars(tmp_path: Path) -> None:
    source_dir = tmp_path / "refs" / "voice"
    source_dir.mkdir(parents=True)
    audio_path = source_dir / "clip.wav"
    mp3_path = source_dir / "clip.mp3"
    lab_path = source_dir / "clip.lab"
    audio_path.write_bytes(b"RIFF")
    mp3_path.write_bytes(b"ID3")
    lab_path.write_text("Bad loop\n", encoding="utf-8")
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=lab_path,
        relative_audio_path=Path("clip.wav"),
    )
    rejected = transcribe_ref_labs.RejectedTranscript(
        target=target,
        text="Bad loop",
        reason="contains a runaway repeated word",
        provider="mlx-whisper",
        model="mlx-community/whisper-large-mlx",
    )
    rejected_dir = tmp_path / "rejected" / "voice"

    moves = transcribe_ref_labs.move_rejected_targets(
        [rejected],
        rejected_dir=rejected_dir,
    )

    assert {move.destination.name for move in moves} == {
        "clip.wav",
        "clip.mp3",
        "clip.lab",
    }
    assert not audio_path.exists()
    assert not mp3_path.exists()
    assert not lab_path.exists()
    assert (rejected_dir / "clip.wav").read_bytes() == b"RIFF"
    assert (rejected_dir / "clip.mp3").read_bytes() == b"ID3"
    assert (rejected_dir / "clip.lab").read_text(encoding="utf-8") == "Bad loop\n"


def test_write_lab_file_updates_and_backs_up_existing_lab(tmp_path: Path) -> None:
    audio_path = tmp_path / "refs" / "clip.wav"
    lab_path = tmp_path / "refs" / "clip.lab"
    backup_dir = tmp_path / "output" / "backups"
    audio_path.parent.mkdir()
    audio_path.write_bytes(b"RIFF")
    lab_path.write_text("Filename derived text\n", encoding="utf-8")
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=lab_path,
        relative_audio_path=Path("clip.wav"),
    )

    result = transcribe_ref_labs.write_lab_file(
        target,
        "  Actual spoken words.  ",
        backup_dir=backup_dir,
    )

    assert result.changed is True
    assert result.old_text == "Filename derived text"
    assert lab_path.read_text(encoding="utf-8") == "Actual spoken words.\n"
    assert result.backup_path == backup_dir / "clip.lab"
    assert result.backup_path.read_text(encoding="utf-8") == "Filename derived text\n"


def test_write_lab_file_leaves_matching_lab_unchanged(tmp_path: Path) -> None:
    audio_path = tmp_path / "refs" / "clip.wav"
    lab_path = tmp_path / "refs" / "clip.lab"
    backup_dir = tmp_path / "output" / "backups"
    audio_path.parent.mkdir()
    audio_path.write_bytes(b"RIFF")
    lab_path.write_text("Already correct\n", encoding="utf-8")
    target = transcribe_ref_labs.AudioTarget(
        audio_path=audio_path,
        lab_path=lab_path,
        relative_audio_path=Path("clip.wav"),
    )

    result = transcribe_ref_labs.write_lab_file(
        target,
        "Already   correct",
        backup_dir=backup_dir,
    )

    assert result.changed is False
    assert result.backup_path is None
    assert lab_path.read_text(encoding="utf-8") == "Already correct\n"
