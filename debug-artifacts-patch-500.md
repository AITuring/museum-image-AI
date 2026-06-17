# Debug Session: artifacts-patch-500 [OPEN]

## Symptom
- Frontend save action triggers `PATCH /api/artifacts/22` and receives HTTP 500.
- Browser console also shows `contentScript.bundle.js` `Cannot read properties of undefined (reading 'local')`.

## Hypotheses
1. Frontend payload shape or types do not match backend `ArtifactUpdate` expectations.
2. Backend update path hits a `None`/missing-related-record branch during image or museum/exhibition updates.
3. The local backend proxies to cloud for `/api/artifacts/{id}`, and cloud patch support is missing or failing.
4. ORM/DB constraints fail while rebuilding artifact tags or exhibition links.
5. `contentScript.bundle.js` error is from a browser extension and unrelated to the 500.

## Evidence Plan
- Inspect frontend save payload and backend patch implementation.
- Reproduce the failing request and capture server traceback/output.
- Determine whether current environment is local-update or proxy-to-cloud path.
- Fix only after runtime evidence identifies the actual failing branch.

## Evidence Collected
- Frontend runtime log shows `PATCH /api/artifacts/22` is sent with expected payload and receives raw `HTTP 500`.
- Current gallery frontend is not calling local `localhost:8000`; it proxies to cloud backend `http://123.57.34.90:8000`.
- Cloud `/openapi.json` already exposes `ArtifactUpdate`, so the patch route exists on cloud.
- Direct cloud reproduction:
  - Non-empty tags + `image_id=23` => `500 Internal Server Error`
  - Empty tags + `image_id=23` => `200 OK`
  - Non-empty tags + `image_id=null` after clearing tags => `200 OK`
  - Re-applying non-empty tags on already-tagged artifact => `500 Internal Server Error`

## Conclusion
- Hypothesis 1 rejected: request payload shape is accepted by schema.
- Hypothesis 3 rejected: this is not a missing route / proxy-chain failure.
- Hypothesis 5 supported: browser `contentScript.bundle.js` noise is unrelated.
- Hypothesis 4 confirmed: updating an already-tagged artifact with another non-empty tag set triggers a backend-side relationship/constraint issue.

## Fix
- Changed `sync_artifact_links_and_tags()` to reuse existing `ArtifactTag` / `ArtifactExhibition` rows instead of replacing the whole relationship with freshly constructed rows.
- This avoids violating unique constraints during flush/commit when the artifact already has tags or exhibition links.

## Pending
- Cloud service still needs this backend fix deployed before user-facing verification can pass.
