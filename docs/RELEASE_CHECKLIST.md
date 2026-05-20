# Release checklist

A lightweight checklist for cutting a new Refinery release. Keep changes small and reversible.

## Before tagging

- [ ] All changes for the release are merged to `main`.
- [ ] CI is green on the latest `main` commit.
- [ ] `CHANGELOG.md` has a new section for the version with user-visible changes summarized in plain English.
- [ ] `pyproject.toml` `version` is bumped (semver: `MAJOR.MINOR.PATCH`).
- [ ] `CITATION.cff` `version` and `date-released` are updated to match.
- [ ] `README.md` install commands still work against the new tag (clone, `uv sync`, `uv run uvicorn app:app`).
- [ ] Docker images build cleanly: `docker compose --profile fish config` and `docker compose --profile download config` validate.
- [ ] Apple Silicon path still works: `scripts/install-fish-macos.sh --dry-run` (or a real reinstall if behavior changed).

## Cut the release

- [ ] Tag the commit: `git tag -a vX.Y.Z -m "Refinery vX.Y.Z"`
- [ ] Push the tag: `git push origin vX.Y.Z`
- [ ] Create a GitHub Release from the tag with the `CHANGELOG.md` entry as the body.
- [ ] Attach any release artifacts that are not built by CI.

## After tagging

- [ ] Verify the release notes render correctly on GitHub.
- [ ] Update the project website (`docs/`) if any user-facing copy needs to change.
- [ ] If breaking changes shipped, post a short summary in the relevant community channels (see [OSS_LAUNCH.md](OSS_LAUNCH.md)).
- [ ] Open an issue for any follow-up work surfaced during the release.

## Hotfix releases

Hotfixes follow the same checklist but skip the documentation polish steps. Cut from a fix branch off the prior tag, cherry-pick the minimal fix into `main`, and tag a `PATCH` bump.
