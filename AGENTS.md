# Repository change control

This repository has a production cloud backend and a separate preview frontend.
Changes must be scoped to the user's request and must preserve unrelated behavior.

## Required before editing

- Inspect `git status` and the existing diff; preserve changes that are already in the worktree.
- Identify the exact files and runtime path involved before changing code.
- Do not perform opportunistic refactors, formatting sweeps, dependency upgrades, or deployment changes.

## Runtime and deployment rules

- `CLOUD_API_BASE_URL` is the cloud ingest backend at `http://<server-ip>:8000`.
- `image.aituring.xyz` is a preview frontend only; it must never become the ingest API base URL.
- Keep `frontend/.env.gallery`, `frontend/vite.config.ts`, and `frontend/vercel.json` aligned.
- Keep AMap browser configuration separate from cloud ingest routing.
- Run `python3 scripts/check_runtime_contracts.py` after any routing, proxy, environment, or deployment change.

## Verification and delivery

- Run the relevant focused tests and the frontend build after behavior changes.
- Review `git diff --check` and the complete diff before committing.
- Report failures and unverified runtime conditions explicitly; a successful build is not proof that Docker or production is healthy.
- Do not commit or push unrelated changes. Production deployment requires an explicit, reviewable change and the protected-branch checks.
