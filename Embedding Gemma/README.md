# FotoFlow AI Playground

Isolated prototype for Gemini-embedding experiments. Separate repo / Firebase project — no production FotoFlow code or data.

## Scope: Milestones 1–2 only

- **M1 — Development foundation:** React + SCSS + Redux Toolkit, Node + Express API, env vars, local scripts.
- **M2 — Single-image embedding test:** select photo → `POST /api/embeddings` → inspect dimension + timing.

Do not add clustering, vector DBs, storytelling, or Cloud Functions until M2 is verified.

## Quickstart

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
| GET | `/api/health` | API + model + key presence |
| POST | `/api/embeddings` | multipart `image` (or JSON `imageBase64`), optional `outputDimensionality` 128–3072, optional `includeVector` |
| GET | `/api/jobs/:jobId` | job status; `?includeVector=true` to inspect full vector |

Key rules: `GEMINI_API_KEY` lives in `services/api/.env` only. Never expose it in React or git. Full vectors stay server-side unless `includeVector=true`.

## Firebase (M3+)

Dedicated playground project only. Emulators: `firebase emulators:start`. Rules in `firestore.rules` / `storage.rules` deny-all until Auth is wired.
