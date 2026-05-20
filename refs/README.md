# Reference audio

Each folder under `refs/` that directly contains paired `.wav` and `.lab` files is treated as a separate voice, mood, or style reference set. A usable reference clip is a paired `.wav` and `.lab` file with the same basename:

```text
refs/
  my_voice/
    clip_01.wav
    clip_01.lab
  bender-moods/
    angry/
      angry_01.wav
      angry_01.lab
    tired/
      tired_01.wav
      tired_01.lab
```

The `.lab` file must contain the exact words spoken in its paired audio file.

Nested mood folders are supported. A grouping folder such as `refs/bender-moods/` can contain mood-specific sets, and Refinery will show them as `bender-moods/angry`, `bender-moods/tired`, and so on. It does not merge those folders into one parent pool; choose one mood set at a time. This is useful when style tags alone make Fish recreate the mood badly or drift away from the original speaker. In that case, keep refs for the same voice separated by mood so the selected set captures the voice as it actually sounds in that register.

## Included sample

The `ljspeech_linda_johnson` folder contains a small sample set from [The LJ Speech Dataset](https://keithito.com/LJ-Speech-Dataset/). The official dataset page describes LJSpeech as public-domain audio, text, and annotations from a single speaker, Linda Johnson.

The bundled clips are short LJSpeech segments. For Fish-Speech/Fish Audio reference testing, use multiple refs per variant so the total conditioning audio is closer to the recommended range.

## Adding your own refs

Only add voice samples that you have permission to use. Local audio and `.lab` transcript files are ignored by default so private reference material does not get committed accidentally.

If you have audio without reliable `.lab` files, run the project script from the repository root:

```bash
scripts/transcribe-ref-labs-local.sh refs/my_voice --dry-run
scripts/transcribe-ref-labs-local.sh refs/my_voice --language en
```

The script transcribes `.wav` files, writes matching `.lab` files, and keeps backups plus a manifest in `output/transcriptions/`. It bootstraps local Whisper automatically, using `mlx-whisper` on Apple Silicon and `faster-whisper` elsewhere.
