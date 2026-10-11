# FotoFlow AI Playground

Isolated prototype for Gemini-embedding experiments. Separate repo / Firebase project — no production FotoFlow code or data.

See [docs/prototype-plan.md](docs/prototype-plan.md) for the full prototype plan (stack, structure, tooling, milestones).

## Scope: Milestones 1–3

- **M1 — Development foundation:** React + SCSS + Redux Toolkit, Node + Express API, env vars, local scripts.
- **M2 — Single-image embedding test:** select photo → `POST /api/embeddings` → inspect dimension + timing.
- **M3 — Batch photo processing:** shoot folder (≤50) → `POST /api/batch-jobs` → progress, retries, cache, resume.

Do not add clustering, vector DBs, storytelling, or Cloud Functions until M3 is verified.

## Quickstart8u4

```bash
npm run install:all
cp .env.example .env
cp services/api/.env.example services/api/.env   # add GEMINI_API_KEY
cp apps/web/.env.example apps/web/.env
npm run dev   # api :5050 + web :5173
```

Open http://localhost:5173, select one JPEG, choose dims (768 recommended), Generate embedding.

## API

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| GET | `/api/health` | API + model + key presence + cache stats |
| POST | `/api/embeddings` | multipart `image` (or JSON `imageBase64`), optional `outputDimensionality` 128–3072, optional `includeVector` |
| GET | `/api/jobs/:jobId` | job status; `?includeVector=true` to inspect full vector |
| POST | `/api/batch-jobs` | multipart `images` (≤50) + `outputDimensionality`, `concurrency` (1–8), `maxRetries` (0–5) → 202 `{ batchId }`, async worker pool |
| GET | `/api/batch-jobs/:batchId` | progress `{ total, completed, failed, pending }` + per-file results; `?includeVectors=true` for clustering prep |
| POST | `/api/batch-jobs/:batchId/retry` | re-run failed items only (resumable, no re-upload) |

Batch notes: SHA-256 cache (`services/api/data/embedding-cache.json`) skips repeat Gemini calls; jobs persist to `services/api/data/batch-jobs.json` so progress survives restarts. Offline test with `MOCK_EMBEDDINGS=1` (deterministic fake vectors, no quota).

Key rules: `GEMINI_API_KEY` lives in `services/api/.env` only. Never expose it in React or git. Full vectors stay server-side unless `includeVector=true`.

## Firebase (M3+)

Dedicated playground project only. Emulators: `firebase emulators:start`. Rules in `firestore.rules` / `storage.rules` deny-all until Auth is wired.
