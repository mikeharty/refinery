FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

RUN useradd --create-home --shell /usr/sbin/nologin appuser

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev

COPY . .
RUN chown -R appuser:appuser /app

USER appuser

ENV PATH="/app/.venv/bin:${PATH}" \
    REFERENCE_ROOT=/app/refs \
    FISH_TTS_URL=http://fish-speech:8080/v1/tts \
    PORT=5055

EXPOSE 5055

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5055/', timeout=2)"

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-5055}"]
