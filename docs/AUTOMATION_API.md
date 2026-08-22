# Automation API — Complete Reference

Programmatically render **automation templates** (compositions with exposed dynamic inputs) to **MP4** via REST. Designed for n8n, Zapier, CI pipelines, and custom backends.

This document covers the full workflow: authoring in the editor → publishing → API keys → render jobs → download. It also documents the internal render worker and how this repo relates to **motion-back** (the public API server, which lives in a separate repository).

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Architecture](#2-architecture)
3. [Plan gating and quotas](#3-plan-gating-and-quotas)
4. [End-to-end workflow](#4-end-to-end-workflow)
5. [Template authoring (editor)](#5-template-authoring-editor)
6. [Template inputs](#6-template-inputs)
7. [REST API reference](#7-rest-api-reference)
8. [Authentication](#8-authentication)
9. [Render job lifecycle](#9-render-job-lifecycle)
10. [Code examples](#10-code-examples)
11. [Environment and configuration](#11-environment-and-configuration)
12. [Render worker (internal)](#12-render-worker-internal)
13. [UI in this app](#13-ui-in-this-app)
14. [Limitations and known gaps](#14-limitations-and-known-gaps)
15. [Related APIs (not Automation)](#15-related-apis-not-automation)
16. [Source file index](#16-source-file-index)

---

## 1. What it is

| Aspect | Detail |
|--------|--------|
| **Purpose** | Render pre-authored video templates with dynamic inputs without opening the editor |
| **Typical callers** | n8n, Zapier, GitHub Actions, custom Node/Python services |
| **Core idea** | Author exposes layers as named inputs (`character`, `headline`, …); callers send `{ templateId, inputs }` |
| **Output** | MP4 hosted on Cloudinary (`videoUrl` in job response) |
| **Auth (external)** | API keys (`pm_live_*`) via `Authorization: Bearer` |
| **Auth (editor/dashboard)** | JWT session (same `/v1/*` paths, different credential) |

**One sentence:** Create a template once in Premation, expose variables, then trigger unlimited automated MP4 exports from any HTTP client.

---

## 2. Architecture

```mermaid
flowchart TB
    subgraph callers [External callers]
        N8N[n8n / Zapier / CI]
    end

    subgraph editor_repo [motion-editor repo]
        Author[Template authoring UI]
        Client[src/core/api/client.ts]
        Apply[applyTemplateInputs]
        Proxy[electron/apiProxy.ts]
        RW[packages/render-worker]
    end

    subgraph backend [motion-back — separate repo]
        API["Public REST /api/v1/*"]
        Queue[Redis: premation-automation-render]
        Consumer[AutomationRenderConsumer]
    end

    CDN[(Cloudinary CDN)]

    Author -->|JWT POST /v1/templates| API
    N8N -->|Bearer pm_live_*| API
    Client -->|Browser: fetch + JWT| API
    Client -->|Electron: path only| Proxy
    Proxy -->|JWT in main process| API

    API --> Queue
    Consumer --> Queue
    Consumer -->|POST /render + RENDER_WORKER_SECRET| RW
    RW --> CDN
    Consumer -->|updates job| API
    API -->|jobId, videoUrl| N8N
```

### Component roles

| Layer | Location | Role |
|-------|----------|------|
| **Editor client** | `src/core/api/client.ts` | Typed HTTP client for all `/v1/*` endpoints |
| **Transport** | `src/core/api/transport.ts` | Auth headers, errors, pagination |
| **Env** | `src/core/api/env.ts` | Browser vs Electron base URL resolution |
| **Electron proxy** | `electron/apiProxy.ts` | Main process attaches JWT; renderer never sees token |
| **Input application** | `src/core/automation/applyInputs.ts` | Maps `{ headline: "…" }` onto document JSON |
| **Publish** | `src/core/automation/publishTemplate.ts` | Captures document + fields → `POST /v1/templates` |
| **Render worker** | `packages/render-worker/` | Private headless renderer called by motion-back |
| **Public API** | **motion-back** (NestJS, not in this repo) | Keys, quotas, queue, webhooks, template storage |

### Two auth paths, same URLs

- **Dashboard / editor:** JWT session → `api.request()` → on desktop, `electron/apiProxy.ts` adds `Authorization: Bearer <accessToken>` in the main process.
- **External automation:** API key → direct HTTP to motion-back with `Authorization: Bearer pm_live_…`.

Both use the same `/api/v1/*` route prefix (see comment in `client.ts` line ~943).

### Implementation verification (motion-editor)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Publish stores full `EditorDocument` | ✅ | `captureDocument()` — scene, animation, comps, timelines, motion blur, guides, color management |
| Keyframes preserved on media replace | ✅ | `applyTemplateInputs` writes target prop only; `document.animation` unchanged |
| Position/scale/rotation/opacity/easing/timing kept | ✅ | Tracks live on Transform props, not `src` |
| Server uses same path as desktop export | ✅ | `packages/render-worker/render/renderEntry.ts` → `renderOffline()` |
| MP4 background + transparent PNG on server | ✅ | Remote HTTP(S) URLs in `Transform.src`; worker fetches via `AppTextureProvider` |
| Worker resolves remote assets | ✅ | Public HTTPS URLs; local `blob:` / Windows paths rejected |
| Output matches desktop export | ✅* | Same code path; worker uses SwiftShader vs desktop GPU may differ slightly |
| Webhook `callbackUrl` | ⚠️ | Type + validation in this repo; POST delivery in **motion-back** |
| n8n via standard HTTP Request | ✅ | Documented in `ApiKeysSection` snippets |

\* Pixel-identical output is best-effort: headless SwiftShader vs desktop GPU.

---

## 3. Plan gating and quotas

Automation is **plan-gated**. The server exposes limits via `GET /v1/usage`:

```typescript
interface ApiUsageSummary {
  period: string;
  renderJobs: number;
  renderDurationMs: number;
  renderedMinutes: number;
  reservedRenderMinutes?: number;
  apiRequests: number;
  assetProcessingBytes: number;
  activeApiKeys?: number;
  limits: {
    apiEnabled: boolean;              // must be true to use API keys
    monthlyRenderMinutes: number | null;
    monthlyApiRequests: number | null;
    maxActiveApiKeys?: number | null;
    maxUploadBytes?: number | null;
  };
}
```

| Check | Where |
|-------|-------|
| Plan includes API | `limits.apiEnabled === true` on billing plan (`PlanDto.apiEnabled`) |
| UI gate | Dashboard → **Developer / API** tab (`ApiKeysSection.tsx`) |
| Server enforcement | 403 when plan lacks API or quotas exceeded |

---

## 4. End-to-end workflow

### Phase A — Author in the editor

1. Build a composition (text, video, shapes, effects, keyframes).
2. Open **Template Authoring** in the editor side panel.
3. Select layers and **expose** them as template fields (text, color, number, image, media).
4. Each field gets a **public slug id** (e.g. `character`, `headline`) — not internal layer UUIDs.
5. Preview inputs locally (same `applyTemplateInputs` logic as the server).

### Phase B — Publish template

1. Sign in to cloud.
2. Click **Save as Animation Template** (or equivalent publish action).
3. Editor calls `POST /v1/templates` with:
   - Frozen `EditorDocument` snapshot (`captureDocument()`)
   - Input manifest (`inputs[]`)
   - Composition metadata (width, height, fps, duration)
4. Server returns `AutomationTemplateRecord` with `id` (e.g. `tpl_7f8a9b`).

**Implementation:** `src/core/automation/publishTemplate.ts`

### Phase C — Create API key

1. Open Dashboard → **Developer / API**.
2. Confirm `GET /v1/usage` shows `apiEnabled: true`.
3. Create key: `POST /v1/keys` with name, optional scopes, optional expiry.
4. **Copy the secret immediately** — shown once only (`CreatedApiKey.secret`).
5. Store securely (n8n credentials, env var, secrets manager).

### Phase D — Trigger render (external caller)

```http
POST /api/v1/renders
Authorization: Bearer pm_live_…
Content-Type: application/json

{
  "templateId": "tpl_7f8a9b",
  "inputs": {
    "headline": "Launch Special 2026",
    "accentColor": "#2988ff",
    "character": "https://cdn.example.com/photo.jpg"
  },
  "output": {
    "format": "mp4",
    "width": 1080,
    "height": 1920,
    "fps": 30
  }
}
```

**Server-side steps (motion-back, not in this repo):**

1. Validate API key, scopes (`renders:write`), plan quotas.
2. Load template document + input manifest.
3. Apply inputs (equivalent to `applyTemplateInputs()` in this repo).
4. Fetch remote asset URLs (SSRF-protected).
5. Create job record (`status: queued`).
6. Enqueue to Redis queue `premation-automation-render`.
7. Return `{ jobId, status: "queued" }`.

### Phase E — Render execution

1. **AutomationRenderConsumer** (motion-back worker node) dequeues job.
2. Calls render worker:

   ```http
   POST http://render-worker:4100/render
   Authorization: Bearer $RENDER_WORKER_SECRET
   Idempotency-Key: <jobId>

   {
     "jobId": "clx9zz110000",
     "document": { "...": "EditorDocument" },
     "durationSeconds": 6.5,
     "output": { "format": "mp4", "width": 1080, "height": 1920, "fps": 30 }
   }
   ```

3. Render worker pipeline (see [§12](#12-render-worker-internal)):
   - Spawn offscreen Electron window (one per job)
   - `restoreDocument(document)`
   - `renderOffline()` → `frame_0000.jpg`, `frame_0001.jpg`, …
   - ffmpeg → H.264 MP4
   - Cloudinary upload → `videoUrl`
4. motion-back updates job → `status: completed`, sets `videoUrl`.

### Phase F — Retrieve result

**Poll:**

```http
GET /api/v1/renders/{jobId}
Authorization: Bearer pm_live_…
```

Response when done:

```json
{
  "jobId": "clx9zz110000",
  "status": "completed",
  "progress": 100,
  "videoUrl": "https://res.cloudinary.com/…/video.mp4",
  "error": null,
  "createdAt": "2026-08-22T09:00:00.000Z"
}
```

**Download (302 redirect):**

```http
GET /api/v1/renders/{jobId}/download
Authorization: Bearer pm_live_…
→ 302 Location: https://…mp4
```

**Optional webhook:** Include `callbackUrl` in the render request body. When the job finishes, motion-back POSTs once to that URL (with safe retries). See [§9](#9-render-job-lifecycle) and `AutomationRenderWebhookPayload` in `client.ts`.

---

## 5. Template authoring (editor)

### Where in the UI

| UI | File |
|----|------|
| Template fields panel | `src/layout/Templates/TemplateFieldsPanel.tsx` |
| Authoring section in editor | `src/layout/EditorLayout/DemoPanels.tsx` |
| Core authoring logic | `src/core/template/templateAuthoring.ts` |

### Publish requirements

From `publishTemplate.ts`:

- User must be **signed in**.
- At least **one exposed input**.
- Every input `id` must pass `isPublicFieldId()` (see [§6](#6-template-inputs)).
- Document captured via `captureDocument()` — full project snapshot, not live scene graph.

### What gets stored

| Field | Description |
|-------|-------------|
| `document` | Frozen `EditorDocument` JSON |
| `inputs` | Public manifest (id, label, kind, required) |
| `width`, `height`, `fps`, `durationSeconds` | Composition settings |
| `projectId` | Optional link to cloud project |

Motion/keyframes on transform properties are preserved. Replacing a media `src` does **not** drop Position/Scale/Rotation/Opacity tracks — that is intentional for “create once, automate many times.”

---

## 6. Template inputs

### Input kinds

| Kind | Value type | Written to | Notes |
|------|------------|------------|-------|
| `text` | `string` | Text layer content | |
| `color` | `string` | Color property (hex, etc.) | |
| `number` | `number` | Numeric property | Must be finite |
| `image` | `string` | Image `src` | URL or embedded ref; HTTP(S) URLs SSRF-checked |
| `media` | `string` | Video/image `src` | Same URL rules; typically **required** |

### Public field IDs

Rules (`src/core/automation/fieldIds.ts`):

- Must match `/^[a-z][a-zA-Z0-9]{0,63}$/`
- Start with a letter; letters and digits only
- No underscores, dashes, or dots (avoids accidental layer-id paste)
- Auto-generated from layer label: `"Background Video"` → `backgroundVideo`

### Applying inputs

Function: `applyTemplateInputs(doc, inputs, fields?)` in `src/core/automation/applyInputs.ts`

| Behavior | Detail |
|----------|--------|
| Unknown keys | Error: `Unknown input "foo".` |
| Invalid types | Error per field |
| Private URLs | Rejected client-side; server re-checks |
| Missing required | `image` / `media` fields need value or HTTP default |
| Output | `{ document, applied[], errors[] }` |

### Allowed asset URLs (SSRF)

Client-side check: `isAllowedAssetUrl()` in `src/core/automation/assetUrls.ts`

**Blocked:**

- Non HTTP(S) schemes
- `localhost`, `127.0.0.1`, private IPv4 ranges, link-local
- `.localhost`, `.local`, `.internal` hostnames
- Raw IPv6
- Google metadata hosts

Server applies the real SSRF gate (including redirects). Client check gives early feedback in the editor.

---

## 7. REST API reference

**Base URL:** `{BACKEND_ORIGIN}/api`

| Runtime | Default base |
|---------|--------------|
| Browser dev | `/api` (Vite proxy → `http://localhost:4000`) |
| Electron | `VITE_BACKEND_ORIGIN` or `http://localhost:4000` |
| Production | `VITE_BACKEND_ORIGIN` (e.g. Railway deployment) |

All paths below are relative to `/api`.

---

### API keys — `/v1/keys`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/keys?limit=&offset=` | JWT | List keys (paginated) |
| `POST` | `/v1/keys` | JWT | Create key (secret shown once) |
| `DELETE` | `/v1/keys/:id` | JWT | Revoke key immediately |

**Create body:**

```json
{
  "name": "n8n Workflow",
  "scopes": ["renders:read", "renders:write", "templates:read", "usage:read"],
  "expiresAt": "2027-08-22T00:00:00.000Z"
}
```

**`ApiKeySummary`:**

```typescript
{
  id: string;
  name: string;
  prefix: string;           // e.g. "pm_live_ab12" — not the secret
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
  revokedAt: string | null;
  scopes?: string[];
  expiresAt?: string | null;
}
```

**`CreatedApiKey`** extends summary with `secret: string` (one-time).

---

### Automation templates — `/v1/templates`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/templates` | JWT or API key | List templates |
| `GET` | `/v1/templates/:id` | JWT or API key | Get one template |
| `POST` | `/v1/templates` | JWT | Publish template |
| `DELETE` | `/v1/templates/:id` | JWT | Delete template |

**`AutomationTemplateInput`:**

```typescript
{
  id: string;
  label: string;
  kind: 'text' | 'color' | 'number' | 'image' | 'media';
  required?: boolean;
}
```

**`PublishTemplateRequest`:**

```typescript
{
  name: string;
  description?: string;
  document: unknown;          // EditorDocument
  inputs: AutomationTemplateInput[];
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  projectId?: string;
}
```

---

### Automation renders — `/v1/renders`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/renders` | API key | Queue render job |
| `GET` | `/v1/renders/:id` | API key | Poll job status |
| `GET` | `/v1/renders/:id/download` | API key | 302 redirect to MP4 |

**`AutomationRenderRequest`:**

```typescript
{
  templateId: string;
  inputs: Record<string, string | number>;
  callbackUrl?: string;  // optional webhook — validated with same SSRF rules as asset URLs
  output?: {
    format?: 'mp4';
    width?: number;
    height?: number;
    fps?: number;
  };
}
```

**Webhook payload** (`AutomationRenderWebhookPayload`, POSTed to `callbackUrl` once per job):

```typescript
// success
{ "jobId": "render_123", "status": "completed", "videoUrl": "https://…" }

// failure
{ "jobId": "render_123", "status": "failed", "error": "…" }
```

Validation helper (editor + motion-back should share rules): `src/core/automation/callbackUrl.ts` → `isAllowedCallbackUrl()`.

**`AutomationRenderJob`:**

```typescript
{
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  videoUrl?: string | null;
  error?: string | null;
  createdAt?: string;
}
```

---

### Usage — `/v1/usage`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/v1/usage` | JWT or API key | Current period usage + limits |

---

### Animation templates — `/v1/animations` (separate feature)

Cloud-synced **animation preset** library — not the same as automation **video templates**.

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST/DELETE` | `/v1/animations`, `/v1/animations/:id` | Preset CRUD |

---

## 8. Authentication

### API key format

| Property | Value |
|----------|-------|
| Prefix | `pm_live_*` (visible in dashboard) |
| Header | `Authorization: Bearer <full_secret>` |
| Shown once | On `POST /v1/keys` create only |
| Revocation | Immediate via `DELETE /v1/keys/:id` |

### Scopes

Defined in `ApiKeysSection.tsx` (mirrors server `api-keys.service.ts`):

| Scope | Default | Permission |
|-------|---------|------------|
| `renders:read` | ✓ | Poll render jobs, download |
| `renders:write` | ✓ | Create render jobs |
| `templates:read` | ✓ | List/get templates |
| `templates:write` | ✗ | Publish templates (editor JWT typical) |
| `usage:read` | ✓ | Read `/v1/usage` |

Default grant: everything except `templates:write`.

### Expiry options (UI)

Never, 30 days, 90 days, 1 year.

### Render worker secret (internal only)

| Variable | Purpose |
|----------|---------|
| `RENDER_WORKER_SECRET` | Bearer token for `POST /render` on render worker |
| Shared between motion-back worker nodes and `packages/render-worker` |
| **Not** an end-user API key |

---

## 9. Render job lifecycle

```
queued → processing → completed
                   ↘ failed
                   ↘ cancelled
```

| Status | Meaning |
|--------|---------|
| `queued` | Accepted, waiting for worker |
| `processing` | Render worker executing |
| `completed` | `videoUrl` available |
| `failed` | See `error` field (sanitized for public API) |
| `cancelled` | Job cancelled |

### Error handling (client)

`ApiError` from `src/core/api/transport.ts`:

```typescript
{
  status: number;
  body: unknown;
  requestId?: string;
}
```

Common cases in UI:

| Status | Meaning |
|--------|---------|
| `401` | Sign-in expired (JWT) or invalid API key |
| `403` | Plan lacks `apiEnabled` or quota exceeded |
| `404` | Route not deployed yet |

### Idempotency (render worker)

`Idempotency-Key: <jobId>` on worker `POST /render` deduplicates in-flight and completed renders. Failed jobs are evicted so genuine retries can proceed.

---

## 10. Code examples

Replace `{BASE}` with your backend origin + `/api` (e.g. `https://your-backend.railway.app/api`).

### cURL — create render

```bash
curl -X POST {BASE}/v1/renders \
  -H "Authorization: Bearer pm_live_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "tpl_7f8a9b",
    "inputs": {
      "headline": "Launch Special 2026",
      "accentColor": "#2988ff"
    }
  }'
```

### Node.js

```javascript
const response = await fetch('{BASE}/v1/renders', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer pm_live_your_api_key_here',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    templateId: 'tpl_7f8a9b',
    inputs: {
      headline: 'Automated Export',
      accentColor: '#2988ff',
    },
  }),
});
const job = await response.json();
console.log('Render Job ID:', job.jobId);
```

### Poll until complete

```javascript
async function waitForRender(jobId, apiKey) {
  for (;;) {
    const res = await fetch(`{BASE}/v1/renders/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const job = await res.json();
    if (job.status === 'completed') return job.videoUrl;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error ?? job.status);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
```

### Python

```python
import requests

response = requests.post(
    '{BASE}/v1/renders',
    headers={
        'Authorization': 'Bearer pm_live_your_api_key_here',
        'Content-Type': 'application/json',
    },
    json={
        'templateId': 'tpl_7f8a9b',
        'inputs': {
            'headline': 'Weekly Highlights',
            'accentColor': '#2988ff',
        },
    },
)
job = response.json()
print(f"Render Job queued: {job['jobId']}")
```

### n8n HTTP Request node

```
Method: POST
URL: {BASE}/v1/renders
Authentication: Header Auth
Header Name: Authorization
Header Value: Bearer pm_live_…

Body (JSON):
{
  "templateId": "{{ $json.templateId }}",
  "inputs": {{ $json.dynamicInputs }},
  "callbackUrl": "{{ $json.webhookUrl }}"
}
```

Download when complete:

```
GET {BASE}/v1/renders/{{ jobId }}/download
```

### Publish template (editor — JWT)

```typescript
import { api } from '@core/api/client';
import { publishCurrentTemplate } from '@core/automation/publishTemplate';

// From UI action:
const result = await publishCurrentTemplate('My Template', 'Optional description');
if (result.ok) console.log('Template id:', result.id);

// Or directly:
await api.publishAutomationTemplate({
  name: 'Anime Cooking Reaction',
  document: captureDocument(),
  inputs: [{ id: 'character', label: 'Character', kind: 'media', required: true }],
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 6.5,
});
```

Live snippets with your deployment URL: Dashboard → **Developer / API** → copy from quickstart tabs (curl, Node, Python, webhook).

---

## 11. Environment and configuration

### Editor / client (this repo)

| Variable | Purpose | Default |
|----------|---------|---------|
| `VITE_BACKEND_ORIGIN` | Absolute motion-back origin (Electron, CSP) | `http://localhost:4000` |
| `VITE_MOTION_API_URL` | Browser API base path | `/api` |
| `MOTION_API_TARGET` | Vite dev proxy target | `http://localhost:4000` |
| `MOTION_BACKEND_ORIGIN` | Electron main runtime override | — |

Files: `.env.production.example`, `src/core/api/env.ts`, `vite.config.ts`, `electron/apiBase.ts`

### Render worker

| Variable | Default | Required |
|----------|---------|----------|
| `RENDER_WORKER_SECRET` | — | **Yes** |
| `PORT` | `4100` | No |
| `CLOUDINARY_URL` | — | For upload (`cloudinary://key:secret@cloud`) |
| `RENDER_WORKER_MAX_CONCURRENT` | `1` | No |
| `RENDER_WORKER_JOB_TIMEOUT_MS` | `900000` (15 min) | No |
| `RENDER_WORKER_MAX_BODY_BYTES` | `67108864` (64 MB) | No |
| `FFMPEG_PATH` | `ffmpeg` | No |
| `RENDER_WORKER_KEEP_TEMP` | — | Debug: keep staging dir |

### motion-back worker node (external)

```env
SERVICE_ROLE=worker
RENDER_WORKER_URL=http://render-worker.internal:4100
RENDER_WORKER_SECRET=<same secret as render worker>
REDIS_URL=redis://…
```

`SERVICE_ROLE=worker` enables `AutomationRenderConsumer` on queue `premation-automation-render`. API nodes enqueue only; at least one worker node must consume or jobs stay `queued`.

---

## 12. Render worker (internal)

**Package:** `packages/render-worker/`  
**Not public API** — called only by motion-back.

### Pipeline

```
POST /render
  → offscreen BrowserWindow (one per job, always destroyed after)
  → restoreDocument(document)
  → renderOffline() → frame_0000.jpg, frame_0001.jpg, …
  → ffmpeg → out.mp4 (H.264, yuv420p, +faststart)
  → Cloudinary signed upload
  ← { videoUrl, renderDurationMs }
```

Uses the **same** `renderOffline` path as desktop export (`@core/export/offlineRenderer`) — automation MP4 and hand-exported MP4 match by construction.

### Run locally

```bash
cd packages/render-worker
npm run build
RENDER_WORKER_SECRET=… CLOUDINARY_URL=cloudinary://… npm start
node smoke.mjs   # end-to-end smoke test
```

### Determinism

SwiftShader flags match `packages/render-tests` golden harness — output does not depend on host GPU. Renders are **CPU-bound**; budget ~1 core per concurrent job; 1080p often slower than realtime.

### Limits

| Limit | Detail |
|-------|--------|
| Format | MP4 only |
| Alpha | Flattened to background (no alpha in MP4) |
| Audio | Not wired in worker yet |
| Plugin effects | Skipped silently (no plugins installed) |
| Document size | Max body bytes configurable |

Full detail: `packages/render-worker/README.md`

---

## 13. UI in this app

| Surface | Path | Purpose |
|---------|------|---------|
| **Developer / API** tab | `src/pages/DashboardPage.tsx` | Hosts API keys section |
| **ApiKeysSection** | `src/layout/Settings/ApiKeysSection.tsx` | Key CRUD, quotas, code snippets |
| **BillingSection** | `src/layout/Settings/BillingSection.tsx` | Plans with Automation API feature |
| **Template authoring** | `src/layout/Templates/TemplateFieldsPanel.tsx` | Expose layers, publish |
| **Editor panel** | `src/layout/EditorLayout/DemoPanels.tsx` | Template authoring in editor |

Dashboard sidebar label: **Developer / API** — “API keys and usage for the Automation API — render your templates from n8n, a script, or CI.”

**Not automation API:** `RenderQueuePanel` is the **local desktop export queue**, unrelated to cloud automation renders.

---

## 14. Limitations and known gaps

### Supported today

- MP4 output with optional width/height/fps overrides
- Input kinds: text, color, number, image, media
- Remote assets via public HTTP(S) URLs (Cloudinary URLs included)
- Polling and download redirect
- Webhook `callbackUrl` in TypeScript client + UI snippets (delivery in motion-back)

### Not supported / partial

| Item | Status |
|------|--------|
| Formats other than MP4 | Not supported |
| Alpha in output | Flattened |
| Audio in automation renders | Not in worker pipeline |
| Custom plugin effects in worker | Silently skipped |
| `GET /v1/renders` list | Not in client |
| Cancel job via client | Status exists; no client method |
| motion-back server source | Separate repository |
| Local `C:\…` / `blob:` asset paths in API inputs | Must be server-accessible HTTP(S) URLs |
| Editor slot-fit (`fillSlot`) on server apply | Server writes `src` only; author layout at publish time |

### External dependencies

These are referenced in this repo but implemented in **motion-back**:

- `AutomationRenderConsumer`
- `src/automation/render-consumer.ts`
- `api-keys.service.ts`
- Server-side `applyTemplateInputs` + asset fetch
- Webhook delivery to `callbackUrl`

---

## 15. Related APIs (not Automation)

| API | Path | Purpose |
|-----|------|---------|
| **Hosted editor render** | `POST /render`, `GET /render/:id` | Cloud export from editor UI (JWT, not API keys) |
| **Animation presets** | `/v1/animations` | Cloud animation preset library |
| **Local desktop export** | Electron IPC `render:*` | In-app export queue |

Do not confuse `/render` (editor cloud export) with `/v1/renders` (automation templates).

---

## 16. Source file index

### Automation logic

| File | Role |
|------|------|
| `src/core/automation/applyInputs.ts` | Apply named inputs to document |
| `src/core/automation/applyInputs.test.ts` | Input application tests |
| `src/core/automation/assetUrls.ts` | SSRF URL validation |
| `src/core/automation/assetUrls.test.ts` | URL rule tests |
| `src/core/automation/fieldIds.ts` | Public slug IDs |
| `src/core/automation/fieldIds.test.ts` | Slug validation tests |
| `src/core/automation/publishTemplate.ts` | Publish from editor |
| `src/core/automation/callbackUrl.ts` | Webhook URL validation |
| `src/core/automation/tiktokAutomation.fixture.ts` | Canonical TikTok automation scenario |
| `src/core/automation/tiktokAutomation.test.ts` | Keyframe preservation + motion sampling tests |

### API client

| File | Role |
|------|------|
| `src/core/api/client.ts` | **Endpoint definitions and TypeScript types** |
| `src/core/api/transport.ts` | HTTP transport, auth, errors |
| `src/core/api/env.ts` | Runtime URL resolution |
| `src/core/api/cloudDocument.ts` | Document capture/restore |

### Electron

| File | Role |
|------|------|
| `electron/apiProxy.ts` | JWT proxy from renderer |
| `electron/apiBase.ts` | Backend origin resolution |

### Render worker

| File | Role |
|------|------|
| `packages/render-worker/README.md` | Worker ops guide |
| `packages/render-worker/electron/main.cjs` | HTTP server + job runner |
| `packages/render-worker/render/renderEntry.ts` | Render pipeline entry |
| `packages/render-worker/smoke.mjs` | Smoke test |
| `packages/render-worker/tiktok-smoke.mjs` | TikTok scenario smoke (remote MP4 + PNG) |
| `packages/render-worker/benchmark.mjs` | Performance benchmark (1080×1920) |

### UI

| File | Role |
|------|------|
| `src/layout/Settings/ApiKeysSection.tsx` | Developer dashboard + snippets |
| `src/layout/Settings/ApiKeysSection.test.tsx` | Plan gating tests |
| `src/layout/Templates/TemplateFieldsPanel.tsx` | Template field UI |
| `src/core/template/templateAuthoring.ts` | Field authoring state |

### Tests documenting behavior

| File | Covers |
|------|--------|
| `src/core/automation/applyInputs.test.ts` | Input errors, URL rejection, motion preservation |
| `src/core/automation/tiktokAutomation.test.ts` | Full TikTok scenario (position/scale/rotation/opacity) |
| `src/core/automation/assetUrls.test.ts` | SSRF rules |
| `src/core/automation/fieldIds.test.ts` | Slug generation |
| `src/layout/Settings/ApiKeysSection.test.tsx` | API access gating |
| `src/core/export/frameContract.test.ts` | Frame naming contract with worker |
| `electron/apiProxy.test.ts` | Proxy path validation |

---

## Quick reference card

```
1. Author  → expose layers as template fields in editor
2. Publish → POST /v1/templates (JWT)
3. Key     → POST /v1/keys (JWT) → save pm_live_… secret once
4. Render  → POST /v1/renders { templateId, inputs, callbackUrl? } (API key)
5. Poll    → GET /v1/renders/:jobId until status === "completed" (or wait for webhook)
6. Download→ GET /v1/renders/:jobId/download → 302 to MP4
```

### Local test commands (this repo)

```bash
# Unit tests — input application + TikTok scenario
npm test -- src/core/automation

# Render worker smoke (requires running worker)
cd packages/render-worker
npm run build
RENDER_WORKER_SECRET=smoke-secret npm start
# in another terminal:
npm run smoke              # basic keyframe rect
npm run smoke:tiktok       # 1080×1920 MP4 + PNG (3s default)
BENCHMARK_SECONDS=30 npm run benchmark
```

Full E2E (`POST /v1/renders` → Redis → worker → Cloudinary) requires **motion-back** running with a worker wired to `RENDER_WORKER_URL`.

**Client types:** `src/core/api/client.ts`  
**Worker ops:** `packages/render-worker/README.md`  
**Dashboard snippets:** Developer / API tab in the app
