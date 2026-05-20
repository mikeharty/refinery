#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import mimetypes
import os
import platform
import random
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence

import httpx
from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_API_URL = "https://api.openai.com/v1/audio/transcriptions"
DEFAULT_OPENAI_MODEL = "gpt-4o-transcribe"
DEFAULT_FASTER_WHISPER_MODEL = "large-v3"
DEFAULT_MLX_MODEL = "mlx-community/whisper-large-mlx"
PROVIDERS = {"auto", "faster-whisper", "mlx-whisper", "whisper-cli", "openai"}
TRANSIENT_STATUS_CODES = {408, 409, 429, 500, 502, 503, 504}
REJECTED_TRANSCRIPT_MARKERS = (
    "short reference audio clip for voice-cloning evaluation",
    "transcribe only the spoken words",
    "do not add speaker labels",
    "timestamps, or commentary",
    "transcription by castingwords",
)
MIN_REPETITIVE_TRANSCRIPT_CHARS = 80
MAX_REPEATED_CHAR_RUN = 32


@dataclass(frozen=True)
class AudioTarget:
    audio_path: Path
    lab_path: Path
    relative_audio_path: Path


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    provider: str
    model: str
    request_id: str | None
    usage: Any


@dataclass(frozen=True)
class WriteResult:
    changed: bool
    old_text: str | None
    backup_path: Path | None


@dataclass(frozen=True)
class RejectedTranscript:
    target: AudioTarget
    text: str
    reason: str
    provider: str
    model: str


@dataclass(frozen=True)
class MoveResult:
    source: Path
    destination: Path


class TranscriptionError(RuntimeError):
    pass


class FasterWhisperTranscriber:
    def __init__(
        self,
        *,
        model: str,
        device: str,
        compute_type: str,
        language: str | None,
        prompt: str | None,
        beam_size: int,
    ) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise TranscriptionError(
                "Missing optional local dependency: faster-whisper. "
                "Run with `uv run --with faster-whisper python "
                "scripts/transcribe_ref_labs.py ... --provider faster-whisper` "
                "or install it in your environment."
            ) from exc

        self.model_name = model
        self.language = language
        self.prompt = prompt
        self.beam_size = beam_size
        self.model = WhisperModel(model, device=device, compute_type=compute_type)

    def transcribe(self, target: AudioTarget) -> TranscriptionResult:
        segments, _ = self.model.transcribe(
            str(target.audio_path),
            beam_size=self.beam_size,
            language=self.language,
            initial_prompt=self.prompt,
            condition_on_previous_text=False,
        )
        text = normalize_transcript(" ".join(segment.text for segment in segments))
        if not text:
            raise TranscriptionError(f"Empty transcript for {target.audio_path}")
        return TranscriptionResult(
            text=text,
            provider="faster-whisper",
            model=self.model_name,
            request_id=None,
            usage=None,
        )


class MlxWhisperTranscriber:
    def __init__(
        self,
        *,
        model: str,
        language: str | None,
        prompt: str | None,
    ) -> None:
        if not is_apple_silicon():
            raise TranscriptionError("mlx-whisper requires Apple Silicon macOS.")
        try:
            import mlx_whisper
        except ImportError as exc:
            raise TranscriptionError(
                "Missing optional Apple Silicon dependency: mlx-whisper. "
                "Run with `uv run --with mlx-whisper python "
                "scripts/transcribe_ref_labs.py ... --provider mlx-whisper` "
                "or use scripts/transcribe-ref-labs-local.sh."
            ) from exc

        self.mlx_whisper = mlx_whisper
        self.model_name = model
        self.language = language
        self.prompt = prompt

    def transcribe(self, target: AudioTarget) -> TranscriptionResult:
        kwargs: dict[str, Any] = {
            "path_or_hf_repo": self.model_name,
            "verbose": False,
            "task": "transcribe",
            "condition_on_previous_text": False,
        }
        if self.language:
            kwargs["language"] = self.language
        if self.prompt:
            kwargs["initial_prompt"] = self.prompt

        result = self.mlx_whisper.transcribe(str(target.audio_path), **kwargs)
        text = normalize_transcript(str(result.get("text", "")))
        if not text:
            raise TranscriptionError(f"Empty transcript for {target.audio_path}")
        return TranscriptionResult(
            text=text,
            provider="mlx-whisper",
            model=self.model_name,
            request_id=None,
            usage=None,
        )


class WhisperCliTranscriber:
    def __init__(
        self,
        *,
        command: str,
        model: str,
        language: str | None,
        prompt: str | None,
    ) -> None:
        if shutil.which(command) is None:
            raise TranscriptionError(
                f"Missing local Whisper command: {command}. "
                "Install OpenAI Whisper with `pip install -U openai-whisper` "
                "or use `--provider faster-whisper`."
            )
        self.command = command
        self.model = model
        self.language = language
        self.prompt = prompt

    def transcribe(self, target: AudioTarget) -> TranscriptionResult:
        with TemporaryDirectory() as output_dir:
            command = build_whisper_cli_command(
                self.command,
                target.audio_path,
                output_dir=Path(output_dir),
                model=self.model,
                language=self.language,
                prompt=self.prompt,
            )
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                stderr = completed.stderr.strip() or completed.stdout.strip()
                raise TranscriptionError(
                    f"Whisper CLI failed for {target.audio_path}: {stderr}"
                )

            output_path = Path(output_dir) / f"{target.audio_path.stem}.txt"
            if not output_path.exists():
                raise TranscriptionError(
                    f"Whisper CLI did not create expected output: {output_path}"
                )
            text = normalize_transcript(output_path.read_text(encoding="utf-8"))
            if not text:
                raise TranscriptionError(f"Empty transcript for {target.audio_path}")
            return TranscriptionResult(
                text=text,
                provider="whisper-cli",
                model=self.model,
                request_id=None,
                usage=None,
            )


class OpenAITranscriber:
    def __init__(
        self,
        *,
        client: httpx.Client,
        api_url: str,
        api_key: str,
        model: str,
        language: str | None,
        prompt: str | None,
        retries: int,
    ) -> None:
        self.client = client
        self.api_url = api_url
        self.api_key = api_key
        self.model = model
        self.language = language
        self.prompt = prompt
        self.retries = retries

    def transcribe(self, target: AudioTarget) -> TranscriptionResult:
        return transcribe_openai_audio(
            self.client,
            target,
            api_url=self.api_url,
            api_key=self.api_key,
            model=self.model,
            language=self.language,
            prompt=self.prompt,
            retries=self.retries,
        )


def normalize_transcript(text: str) -> str:
    return " ".join(text.strip().split())


def transcript_rejection_reason(text: str) -> str | None:
    normalized = normalize_transcript(text)
    lowered = normalized.lower()
    for marker in REJECTED_TRANSCRIPT_MARKERS:
        if marker in lowered:
            return f"matched boilerplate marker: {marker}"

    compact = re.sub(r"[^a-z0-9]+", "", lowered)
    if len(compact) < MIN_REPETITIVE_TRANSCRIPT_CHARS:
        return None

    repeated_char_pattern = rf"([a-z0-9])\1{{{MAX_REPEATED_CHAR_RUN - 1},}}"
    if re.search(repeated_char_pattern, compact):
        return "contains a runaway repeated character"

    for pattern_size in range(2, 13):
        repeated_pattern = rf"([a-z0-9]{{{pattern_size}}})\1{{7,}}"
        if re.search(repeated_pattern, compact):
            return "contains a runaway repeated syllable or token pattern"

    words = re.findall(r"[a-z0-9']+", lowered)
    if len(words) >= 20:
        word, count = Counter(words).most_common(1)[0]
        if len(word) > 1 and count / len(words) >= 0.5:
            return f"contains a runaway repeated word: {word}"

    return None


def validate_transcript(text: str, target: AudioTarget) -> None:
    reason = transcript_rejection_reason(text)
    if reason:
        normalized = normalize_transcript(text)
        raise TranscriptionError(
            f"Rejected likely non-speech transcript for {target.audio_path} "
            f"({reason}): {normalized}"
        )


def scan_root_rejected_dir(scan_root: Path) -> Path:
    resolved_root = scan_root.resolve()
    refs_root = (ROOT_DIR / "refs").resolve()
    try:
        suffix = resolved_root.relative_to(refs_root)
    except ValueError:
        suffix = Path(resolved_root.name)
    return ROOT_DIR / "rejected" / suffix


def sidecar_paths(target: AudioTarget) -> list[Path]:
    suffixes = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".lab")
    paths = [target.audio_path.with_suffix(suffix) for suffix in suffixes]
    return [path for path in paths if path.exists()]


def unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    for index in range(2, 1000):
        candidate = path.with_name(f"{path.stem}-{index}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not find available destination for {path}")


def move_rejected_targets(
    rejected: Sequence[RejectedTranscript],
    *,
    rejected_dir: Path,
) -> list[MoveResult]:
    moves: list[MoveResult] = []
    seen_sources: set[Path] = set()

    for rejected_item in rejected:
        target = rejected_item.target
        target_dir = rejected_dir / target.relative_audio_path.parent
        target_dir.mkdir(parents=True, exist_ok=True)

        for source in sidecar_paths(target):
            if source in seen_sources:
                continue
            seen_sources.add(source)
            destination = unique_destination(target_dir / source.name)
            shutil.move(str(source), str(destination))
            moves.append(MoveResult(source=source, destination=destination))

    return moves


def rejected_summary_lines(
    rejected: Sequence[RejectedTranscript],
    *,
    rejected_dir: Path,
) -> list[str]:
    if not rejected:
        return []

    lines = [
        "",
        f"Rejected transcript candidates: {len(rejected)}",
    ]
    for item in rejected:
        lines.extend(
            [
                f"- {item.target.relative_audio_path}",
                f"  reason: {item.reason}",
                f"  transcript: {item.text}",
            ]
        )
    lines.extend(
        [
            "",
            f"Suggestion: move the paired audio/.lab files to {rejected_dir}",
            "That folder is outside refs/, so Refinery will not pick them up.",
        ]
    )
    return lines


def maybe_move_rejected_targets(
    rejected: Sequence[RejectedTranscript],
    *,
    rejected_dir: Path,
) -> list[MoveResult]:
    for line in rejected_summary_lines(rejected, rejected_dir=rejected_dir):
        print(line)

    if not rejected:
        return []
    if not sys.stdin.isatty():
        print("Not moving rejected files because stdin is not interactive.")
        return []

    confirmation = input("Move rejected files now? Type 'y' to move, any other key to skip: ")
    if confirmation.strip().lower() != "y":
        print("Skipped moving rejected files.")
        return []

    moves = move_rejected_targets(rejected, rejected_dir=rejected_dir)
    print(f"Moved {len(moves)} file(s) to {rejected_dir}")
    for move in moves:
        print(f"  {move.source} -> {move.destination}")
    return moves


def result_status_lines(write_result: WriteResult, transcript: str) -> list[str]:
    if not write_result.changed:
        return [f"  unchanged: {transcript}"]
    old_text = write_result.old_text if write_result.old_text else "<missing>"
    return [
        "  updated:",
        f"    old: {old_text}",
        f"    new: {transcript}",
    ]


def normalize_extensions(extensions: Sequence[str]) -> tuple[str, ...]:
    normalized = []
    for extension in extensions:
        extension = extension.strip().lower()
        if not extension:
            continue
        if not extension.startswith("."):
            extension = f".{extension}"
        normalized.append(extension)
    if not normalized:
        raise ValueError("At least one audio extension is required")
    return tuple(dict.fromkeys(normalized))


def find_audio_targets(root: Path, extensions: Sequence[str]) -> list[AudioTarget]:
    resolved_root = root.resolve()
    normalized_extensions = normalize_extensions(extensions)
    audio_files = sorted(path for path in resolved_root.rglob("*") if path.is_file())
    targets: list[AudioTarget] = []
    seen_labs: set[Path] = set()

    for extension in normalized_extensions:
        for audio_path in audio_files:
            if audio_path.suffix.lower() != extension:
                continue

            lab_path = audio_path.with_suffix(".lab")
            if lab_path in seen_labs:
                continue
            seen_labs.add(lab_path)
            targets.append(
                AudioTarget(
                    audio_path=audio_path,
                    lab_path=lab_path,
                    relative_audio_path=audio_path.relative_to(resolved_root),
                )
            )

    return targets


def backup_lab_file(target: AudioTarget, backup_dir: Path) -> Path:
    backup_path = backup_dir / target.relative_audio_path.with_suffix(".lab")
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target.lab_path, backup_path)
    return backup_path


def write_lab_file(
    target: AudioTarget, transcript: str, backup_dir: Path | None
) -> WriteResult:
    normalized = normalize_transcript(transcript)
    if not normalized:
        raise ValueError(f"Empty transcript for {target.audio_path}")

    old_text = None
    if target.lab_path.exists():
        old_text = target.lab_path.read_text(encoding="utf-8").strip()

    changed = old_text is None or normalize_transcript(old_text) != normalized
    if not changed:
        return WriteResult(changed=False, old_text=old_text, backup_path=None)

    backup_path = None
    if backup_dir is not None and target.lab_path.exists():
        backup_path = backup_lab_file(target, backup_dir)

    target.lab_path.write_text(f"{normalized}\n", encoding="utf-8")
    return WriteResult(changed=True, old_text=old_text, backup_path=backup_path)


def default_run_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ROOT_DIR / "output" / "transcriptions" / stamp


def guess_content_type(path: Path) -> str:
    content_type, _ = mimetypes.guess_type(path.name)
    return content_type or "application/octet-stream"


def extract_transcript(response: httpx.Response) -> tuple[str, Any]:
    content_type = response.headers.get("content-type", "")
    if "application/json" not in content_type:
        return normalize_transcript(response.text), None

    data = response.json()
    text = data.get("text")
    if not isinstance(text, str):
        raise TranscriptionError("Transcription response did not include text")
    return normalize_transcript(text), data.get("usage")


def summarize_error(response: httpx.Response) -> str:
    try:
        body = response.json()
    except json.JSONDecodeError:
        body = response.text
    return f"{response.status_code} {response.reason_phrase}: {body}"


def sleep_before_retry(attempt: int) -> None:
    delay = min(2**attempt, 30) + random.uniform(0, 0.5)
    time.sleep(delay)


def build_whisper_cli_command(
    command: str,
    audio_path: Path,
    *,
    output_dir: Path,
    model: str,
    language: str | None,
    prompt: str | None,
) -> list[str]:
    args = [
        command,
        str(audio_path),
        "--model",
        model,
        "--output_format",
        "txt",
        "--output_dir",
        str(output_dir),
        "--task",
        "transcribe",
        "--verbose",
        "False",
    ]
    if language:
        args.extend(["--language", language])
    if prompt:
        args.extend(["--initial_prompt", prompt])
    return args


def transcribe_openai_audio(
    client: httpx.Client,
    target: AudioTarget,
    *,
    api_url: str,
    api_key: str,
    model: str,
    language: str | None,
    prompt: str | None,
    retries: int,
) -> TranscriptionResult:
    data = {
        "model": model,
        "response_format": "json",
    }
    if language:
        data["language"] = language
    if prompt:
        data["prompt"] = prompt

    headers = {"Authorization": f"Bearer {api_key}"}

    for attempt in range(retries + 1):
        with target.audio_path.open("rb") as audio_file:
            files = {
                "file": (
                    target.audio_path.name,
                    audio_file,
                    guess_content_type(target.audio_path),
                )
            }
            response = client.post(
                api_url,
                headers=headers,
                data=data,
                files=files,
            )

        if response.status_code < 400:
            text, usage = extract_transcript(response)
            if not text:
                raise TranscriptionError(f"Empty transcript for {target.audio_path}")
            return TranscriptionResult(
                text=text,
                provider="openai",
                model=model,
                request_id=response.headers.get("x-request-id"),
                usage=usage,
            )

        if response.status_code not in TRANSIENT_STATUS_CODES or attempt >= retries:
            raise TranscriptionError(summarize_error(response))

        sleep_before_retry(attempt)

    raise TranscriptionError(f"Failed to transcribe {target.audio_path}")


def append_manifest_record(manifest_path: Path, record: dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("a", encoding="utf-8") as manifest:
        manifest.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
        manifest.write("\n")


def resolve_project_path(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT_DIR / path
    return path.resolve()


def has_python_module(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def resolve_provider(provider: str, *, whisper_command: str, api_key: str | None) -> str:
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown transcription provider: {provider}")
    if provider != "auto":
        return provider
    if is_apple_silicon() and has_python_module("mlx_whisper"):
        return "mlx-whisper"
    if has_python_module("faster_whisper"):
        return "faster-whisper"
    if shutil.which(whisper_command):
        return "whisper-cli"
    if api_key:
        return "openai"
    raise TranscriptionError(
        "No local transcription provider found and no OpenAI key is configured. "
        "Use scripts/transcribe-ref-labs-local.sh, install a local Whisper provider, "
        "or use --provider openai with OPENAI_API_KEY."
    )


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return parsed


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe Refinery reference audio into matching .lab files."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default="refs",
        help="Reference root or subfolder to scan. Default: refs",
    )
    parser.add_argument(
        "--provider",
        choices=sorted(PROVIDERS),
        default=os.environ.get("REFINERY_TRANSCRIBE_PROVIDER", "auto"),
        help="Transcription provider. Default: auto",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_TRANSCRIBE_MODEL", DEFAULT_OPENAI_MODEL),
        help=f"OpenAI transcription model. Default: {DEFAULT_OPENAI_MODEL}",
    )
    parser.add_argument(
        "--local-model",
        default=os.environ.get(
            "REFINERY_LOCAL_TRANSCRIBE_MODEL", DEFAULT_FASTER_WHISPER_MODEL
        ),
        help=(
            "faster-whisper or whisper-cli model. "
            f"Default: {DEFAULT_FASTER_WHISPER_MODEL}"
        ),
    )
    parser.add_argument(
        "--mlx-model",
        default=os.environ.get("REFINERY_MLX_TRANSCRIBE_MODEL", DEFAULT_MLX_MODEL),
        help=f"MLX Whisper model for Apple Silicon. Default: {DEFAULT_MLX_MODEL}",
    )
    parser.add_argument(
        "--local-device",
        default=os.environ.get("REFINERY_LOCAL_TRANSCRIBE_DEVICE", "auto"),
        help="faster-whisper device, for example auto, cpu, or cuda. Default: auto",
    )
    parser.add_argument(
        "--local-compute-type",
        default=os.environ.get("REFINERY_LOCAL_TRANSCRIBE_COMPUTE_TYPE", "default"),
        help="faster-whisper compute type, for example default, int8, or float16. Default: default",
    )
    parser.add_argument(
        "--whisper-command",
        default=os.environ.get("REFINERY_WHISPER_COMMAND", "whisper"),
        help="Local OpenAI Whisper CLI command. Default: whisper",
    )
    parser.add_argument(
        "--beam-size",
        type=positive_int,
        default=int(os.environ.get("REFINERY_TRANSCRIBE_BEAM_SIZE", "5")),
        help="Beam size for faster-whisper decoding. Ignored by mlx-whisper. Default: 5",
    )
    parser.add_argument(
        "--api-url",
        default=os.environ.get("OPENAI_TRANSCRIBE_URL", DEFAULT_API_URL),
        help=f"Transcription endpoint. Default: {DEFAULT_API_URL}",
    )
    parser.add_argument(
        "--api-key-env",
        default="OPENAI_API_KEY",
        help="Environment variable containing the API key. Default: OPENAI_API_KEY",
    )
    parser.add_argument(
        "--language",
        default=os.environ.get("OPENAI_TRANSCRIBE_LANGUAGE"),
        help="Optional ISO-639-1 input language, for example: en",
    )
    parser.add_argument(
        "--prompt",
        default=os.environ.get("REFINERY_TRANSCRIBE_PROMPT"),
        help="Optional provider prompt. Local providers default to no prompt.",
    )
    parser.add_argument(
        "--extensions",
        nargs="+",
        default=[".wav"],
        help="Audio extensions to transcribe. Default: .wav",
    )
    parser.add_argument(
        "--missing-only",
        action="store_true",
        help="Only transcribe audio files without an existing .lab file.",
    )
    parser.add_argument(
        "--limit",
        type=positive_int,
        help="Transcribe at most this many files.",
    )
    parser.add_argument(
        "--run-dir",
        type=Path,
        help="Output run directory for manifest and backups. Default: output/transcriptions/<timestamp>",
    )
    parser.add_argument(
        "--no-backup",
        dest="backup",
        action="store_false",
        help="Do not back up replaced .lab files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List matching audio files without calling the transcription API.",
    )
    parser.add_argument(
        "--timeout",
        type=positive_float,
        default=120.0,
        help="HTTP timeout in seconds. Default: 120",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="Retries for rate limits and transient server errors. Default: 3",
    )
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    root = resolve_project_path(args.root)
    if not root.exists():
        print(f"Reference path does not exist: {root}", file=sys.stderr)
        return 2

    targets = find_audio_targets(root, args.extensions)
    if args.missing_only:
        targets = [target for target in targets if not target.lab_path.exists()]
    if args.limit is not None:
        targets = targets[: args.limit]

    if not targets:
        print("No matching audio files found.")
        return 0

    print(f"Found {len(targets)} audio file(s) under {root}")
    if args.dry_run:
        for target in targets:
            status = "missing lab" if not target.lab_path.exists() else "has lab"
            print(f"{target.relative_audio_path} -> {target.lab_path.name} ({status})")
        return 0

    api_key = os.environ.get(args.api_key_env)
    try:
        provider = resolve_provider(
            args.provider,
            whisper_command=args.whisper_command,
            api_key=api_key,
        )
    except (TranscriptionError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if provider == "openai" and not api_key:
        print(
            f"Missing API key for OpenAI transcription: set {args.api_key_env}",
            file=sys.stderr,
        )
        return 2

    run_dir = resolve_project_path(args.run_dir) if args.run_dir else default_run_dir()
    backup_dir = run_dir / "backups" if args.backup else None
    manifest_path = run_dir / "manifest.jsonl"
    run_dir.mkdir(parents=True, exist_ok=True)

    timeout = httpx.Timeout(args.timeout, connect=min(10.0, args.timeout))
    errors = 0
    changed = 0
    unchanged = 0
    rejected_transcripts: list[RejectedTranscript] = []

    print(f"Transcription provider: {provider}")
    print(f"Writing manifest: {manifest_path}")
    if backup_dir is not None:
        print(f"Backing up replaced labs to: {backup_dir}")

    try:
        if provider == "faster-whisper":
            transcriber = FasterWhisperTranscriber(
                model=args.local_model,
                device=args.local_device,
                compute_type=args.local_compute_type,
                language=args.language,
                prompt=args.prompt,
                beam_size=args.beam_size,
            )
            close_client = None
        elif provider == "mlx-whisper":
            transcriber = MlxWhisperTranscriber(
                model=args.mlx_model,
                language=args.language,
                prompt=args.prompt,
            )
            close_client = None
        elif provider == "whisper-cli":
            transcriber = WhisperCliTranscriber(
                command=args.whisper_command,
                model=args.local_model,
                language=args.language,
                prompt=args.prompt,
            )
            close_client = None
        else:
            client = httpx.Client(timeout=timeout)
            transcriber = OpenAITranscriber(
                client=client,
                api_url=args.api_url,
                api_key=api_key or "",
                model=args.model,
                language=args.language,
                prompt=args.prompt,
                retries=max(args.retries, 0),
            )
            close_client = client
    except (OSError, httpx.HTTPError, TranscriptionError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    try:
        for index, target in enumerate(targets, start=1):
            print(f"[{index}/{len(targets)}] {target.relative_audio_path}")
            try:
                transcription = transcriber.transcribe(target)
                rejection_reason = transcript_rejection_reason(transcription.text)
                if rejection_reason:
                    rejected = RejectedTranscript(
                        target=target,
                        text=normalize_transcript(transcription.text),
                        reason=rejection_reason,
                        provider=transcription.provider,
                        model=transcription.model,
                    )
                    rejected_transcripts.append(rejected)
                    append_manifest_record(
                        manifest_path,
                        {
                            "audio_path": str(target.audio_path),
                            "lab_path": str(target.lab_path),
                            "model": transcription.model,
                            "provider": transcription.provider,
                            "rejected": True,
                            "rejection_reason": rejection_reason,
                            "text": rejected.text,
                        },
                    )
                    print(
                        f"  rejected: {rejection_reason}: {rejected.text}",
                        file=sys.stderr,
                    )
                    continue

                write_result = write_lab_file(
                    target,
                    transcription.text,
                    backup_dir=backup_dir,
                )
                if write_result.changed:
                    changed += 1
                else:
                    unchanged += 1

                append_manifest_record(
                    manifest_path,
                    {
                        "audio_path": str(target.audio_path),
                        "backup_path": (
                            str(write_result.backup_path)
                            if write_result.backup_path
                            else None
                        ),
                        "changed": write_result.changed,
                        "lab_path": str(target.lab_path),
                        "model": transcription.model,
                        "old_text": write_result.old_text,
                        "provider": transcription.provider,
                        "request_id": transcription.request_id,
                        "text": transcription.text,
                        "usage": transcription.usage,
                    },
                )
                for line in result_status_lines(write_result, transcription.text):
                    print(line)
            except (OSError, httpx.HTTPError, TranscriptionError, ValueError) as exc:
                errors += 1
                append_manifest_record(
                    manifest_path,
                    {
                        "audio_path": str(target.audio_path),
                        "error": str(exc),
                        "lab_path": str(target.lab_path),
                    },
                )
                print(f"  error: {exc}", file=sys.stderr)
    finally:
        if close_client is not None:
            close_client.close()

    rejected_dir = scan_root_rejected_dir(root)
    moved = maybe_move_rejected_targets(
        rejected_transcripts,
        rejected_dir=rejected_dir,
    )
    for move in moved:
        append_manifest_record(
            manifest_path,
            {
                "destination": str(move.destination),
                "moved_rejected_file": True,
                "source": str(move.source),
            },
        )

    print(
        "Done. "
        f"updated={changed} unchanged={unchanged} "
        f"rejected={len(rejected_transcripts)} moved={len(moved)} errors={errors}"
    )
    return 1 if errors else 0


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv(ROOT_DIR / ".env")
    args = parse_args(argv if argv is not None else sys.argv[1:])
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
