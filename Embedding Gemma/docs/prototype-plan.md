# FotoFlow AI Playground — Prototype Plan

Isolated prototype for Gemini-embedding experiments. Separate React + Firebase + Node.js environment following FotoFlow's existing stack, with Gemini embeddings as the first AI capability.

Goal: a small, isolated FotoFlow AI Playground where you can process a real wedding shoot, inspect embeddings, experiment with clustering, and eventually test automatic storytelling — without risking the production FotoFlow app.

Use a separate GitHub repository and Firebase project for this prototype. Reuse the architectural conventions of FotoFlow, but avoid importing production application code or connecting to production data initially.

## 1. Minimal development stack

| Layer          | Technology               | Purpose                                         |
| -------------- | ------------------------ | ----------------------------------------------- |
| Frontend       | React + JavaScript       | Upload photos and inspect processing results    |
| UI styling     | SCSS                     | Reuse FotoFlow's styling approach               |
| App state      | Redux Toolkit            | Track uploads, jobs, and processing results     |
| Backend        | Node.js + Express        | Orchestrate processing and expose API endpoints |
| Cloud backend  | Firebase Cloud Functions | Add cloud processing when needed                |
| Database       | Cloud Firestore          | Store experiments, jobs, and embedding metadata |
| File storage   | Firebase Storage         | Store test photos and generated derivatives     |
| Authentication | Firebase Auth            | Keep the playground private                     |
| AI             | Gemini Embedding 2       | Generate image embeddings                       |
| Development    | Firebase Emulator Suite  | Test Firebase services locally                  |

## 2. Repository structure

Small monorepo: React app + Node.js API without production-scale microservice overhead.

```
fotoflow-ai-playground/
├── apps/
│   └── web/                 # React + SCSS + Redux Toolkit
├── services/
│   └── api/                 # Node.js + Express
├── functions/               # Firebase Cloud Functions (later)
├── packages/
│   └── shared/              # Shared types and utilities (later)
├── firebase.json
├── firestore.rules
├── storage.rules
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

The web app handles uploading and visualizing photos; the API handles secure AI calls and processing; Firebase provides persistence when needed. Cloud Functions can later host production-like asynchronous jobs.

## 3. Minimal tooling

- **Node.js LTS + npm** — use one supported Node.js LTS version across the repo. Check the selected Firebase Functions runtime compatibility before pinning it. See [Node.js](https://nodejs.org/) and [npm documentation](https://docs.npmjs.com/).
- **React + Vite** — fast local development, HMR, lightweight frontend foundation. Use JavaScript rather than introducing TypeScript into this first experiment. See [Vite setup guide](https://vite.dev/guide/).
- **Firebase CLI + Emulator Suite** — local Firestore, Storage, and Auth development with a dedicated Firebase project for cloud testing. See [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite).

### Initial setup commands

```bash
mkdir fotoflow-ai-playground
cd fotoflow-ai-playground

npm init -y
npm create vite@latest apps/web -- --template react

mkdir -p services/api
cd services/api
npm init -y
npm install express cors dotenv @google/genai
npm install -D nodemon

cd ../..
npm install
npm install -D concurrently
npm install @reduxjs/toolkit react-redux sass firebase
```

Initialize Firebase after installing the CLI:

```bash
npm install -g firebase-tools
firebase login
firebase init
```

Select Firestore, Functions, Emulators, and Storage as appropriate. Choose JavaScript for the initial Functions setup, and associate it with the new playground Firebase project — never the production FotoFlow project. See [Firebase CLI documentation](https://firebase.google.com/docs/cli).

## 4. Gemini Embedding 2 — secure connection

Use the official `@google/genai` JavaScript SDK in the Node.js API, not in React. Model ID: `gemini-embedding-2`. Supports image embeddings and configurable output dimensions.

Initial API surface — three endpoints:

| Endpoint               | Responsibility                                                   |
| ---------------------- | ---------------------------------------------------------------- |
| `GET /api/health`      | Confirm the API is running                                       |
| `POST /api/embeddings` | Generate an embedding for a test image                           |
| `GET /api/jobs/:jobId` | Retrieve processing status when asynchronous jobs are introduced |

For the first test, send one local image to the API and return the embedding dimension and processing time. Don't return the full vector to the UI unless actively inspecting it.

Store the API key in the API's local environment file:

```bash
# services/api/.env
GEMINI_API_KEY=your_key_here
```

Add the file to `.gitignore`; commit only an `.env.example` with placeholder values. Never expose the Gemini API key in React, browser requests, or committed source code.

For initial experiments, keep embeddings in local JSON or in-memory state. Add Firestore persistence once the basic pipeline works.

## 5. Build order

### Prototype milestones

1. **Development foundation** — React, SCSS, Redux Toolkit, Node API, environment variables, working local scripts.
2. **Single-image embedding test** — upload one JPEG, call Gemini Embedding 2 securely, display processing status and vector dimensions.
3. **Batch photo processing** — load a small shoot folder, process images with concurrency limits, retries, progress tracking, resumable jobs.
4. **Embedding inspector** — display thumbnails, dimensions, processing time, cosine similarity between selected images.
5. **Clustering experiment** — compare embeddings, experiment with HDBSCAN to discover visually related moments.
6. **Storytelling experiment** — select representative images from clusters, use timestamps, generate a draft highlight sequence.

### Recommendation

Start with Milestone 1 and Milestone 2 only. Don't add clustering, vector databases, AI storytelling, or Cloud Functions processing until the single-image embedding pipeline is verified.

One technical consideration for the batch stage: a shoot may contain thousands of large photos. The prototype will need bounded concurrency, retries, caching, and resumability before processing entire shoots reliably.

First success criterion: select a photo → generate an embedding securely → inspect the result → repeat for several photos. Everything else builds on that foundation.
