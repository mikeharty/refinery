# Contributing

Thanks for helping improve Refinery. The project is small, so the best contributions are focused and easy to review.

## Development setup

```bash
git clone https://github.com/mikeharty/refinery.git
cd refinery
cp .env.example .env
uv sync
uv run uvicorn app:app --host 0.0.0.0 --port 5055 --reload
```

Open <http://localhost:5055>.

## Local checks

Run these before opening a pull request:

```bash
uv run python -m py_compile app.py
uv run pytest
node --check static/app.js
bash -n scripts/install-fish-macos.sh scripts/start-fish-macos.sh scripts/uninstall-fish-macos.sh
docker compose config
docker compose --profile fish config
docker compose --profile download config
```

## Voice reference policy

Do not add private, copyrighted, leaked, or non-consensual voice samples. Any new bundled reference material must be public domain or clearly open-licensed, and the source/license must be documented next to the files.

For bug reports, avoid attaching private voice refs or transcripts. A minimal public-domain reproduction is preferred.

## Pull request scope

- Keep changes narrowly scoped.
- Include screenshots or short screen recordings for UI changes.
- Include the exact Fish backend path tested when changing TTS behavior: hosted API, native macOS Fish-Speech, Docker Compose Fish-Speech, or another local server.
- Explain ranking/refinement changes in terms of the listening workflow they improve.
