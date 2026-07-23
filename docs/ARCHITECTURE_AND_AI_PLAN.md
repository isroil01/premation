# Motion Editor & Motion Back: Full Architecture Analysis & AI/MCP Master Plan

## Executive Summary

This document provides an end-to-end architectural evaluation of **Motion Back** (NestJS + Prisma backend) and **Motion Editor** (React + WebGL + Electron frontend), identifies current bottlenecks, bugs, and security risks, and establishes the blueprint for transforming the platform into a premier **AI-Native 3D/2D Motion Graphics & Video Generation System** equipped with **BYOK (Bring Your Own Key) Multi-Modal AI** and **MCP (Model Context Protocol)** capabilities.

---

## 1. Comprehensive System Analysis

### 1.1 Motion Back Backend Architecture (`motion-back`)

The backend is built as a NestJS modular application with Postgres (via Prisma ORM), JWT authentication, and file storage via Cloudinary or local disk.

#### Core Modules:
1. **`AuthModule`**: Handles registration, login, JWT token issuance, and password resets (`PasswordResetToken`).
2. **`ProjectsModule`**: Manages CRUD operations for project documents, versions (`ProjectVersion`), auto-saving, soft deletion/trash, and project facts extraction.
3. **`AiGatewayModule`**: Enforces encrypted storage (AES-256-GCM) of user API keys (BYOK) and proxies streaming requests to AI providers.
4. **`RenderModule`**: Receives zip archives of browser-rendered PNG/JPG frame sequences and runs local `ffmpeg` process to encode MP4 video files.
5. **`SyncModule`**: RFC-compliant client-side encrypted backup vault (`SyncState` and `SyncChunk`).

#### Key Technical Shortages & Bugs in `motion-back`:

> [!CAUTION]
> **CRITICAL SECURITY BUG: BYOK API Key Leakage**
> In `motion-back/src/ai/ai-gateway.service.ts`:
> ```typescript
> async keyStatus(ownerId: string): Promise<Record<ByokProvider, KeyStatus>> {
>   // ...
>   out[r.provider as ByokProvider] = {
>     present: true,
>     hint: r.hint,
>     key: decryptKey(r.encryptedKey), // <-- BUG! LEAKS PLAINTEXT KEY TO CLIENT
>   };
>   return out;
> }
> ```
> The codebase advertises that keys are decrypted only on the server during provider calls and never returned to the client. However, `keyStatus` leaks decrypted keys over HTTP, which the frontend stores into browser `localStorage`.

1. **Provider Scope Limitation**: The AI Gateway currently supports only LLM text APIs (`openai`, `anthropic`, `gemini`). It lacks integration for:
   - AI Video Generators (Fal.ai / HunyuanVideo / Wan2.1 / CogVideoX, Runway Gen-3, Luma Dream Machine, Replicate).
   - AI 3D Mesh Generators (Tripo3D, Meshy, Rodin).
   - AI Speech & Audio Synthesis (ElevenLabs, Suno).
2. **Synchronous Render Execution**: `RenderWorker` runs `ffmpeg` directly in NestJS process memory without a dedicated background job queue (e.g. BullMQ / Redis). High render loads will block CPU cores and crash API response times.
3. **Absence of MCP (Model Context Protocol)**: No MCP server endpoint (SSE or HTTP JSON-RPC) is exposed for external AI agents or IDE extensions.

---

### 1.2 Motion Editor Frontend Architecture (`motion-editor`)

The frontend is a monorepo application structured around modular packages:
- `@motion/scene`: Scene graph hierarchy (Nodes: Root, Composition, Group, Rectangle, Ellipse, Path, Text, Image, Video, Audio, Camera, Light).
- `@motion/renderer`: WebGL / 2D Canvas rendering engine.
- `@motion/timeline`: Keyframes, tracks, easing curves (Bezier, Linear, Hold, Spring).
- `@motion/ai-tools`: Client-side agent loop (`AgentLoop.ts`) and tool definitions (`toolHandlers.ts`).

#### Key Technical Shortages in `motion-editor`:
1. **Limited 3D Capabilities**: While camera and light node types exist, the rendering engine lacks full **3D Mesh Loading (.glb/.gltf)**, **PBR (Physically Based Rendering) Shader Pipelines**, **Environment Map HDRI Lighting**, and **Shadow Maps**.
2. **Plaintext Key Caching**: `aiProviderStore.ts` writes API keys returned from the backend directly into browser `localStorage` (`localStorage.setItem('motion_editor_local_ai_key_...')`), exposing user keys to XSS attacks.
3. **2D-Focused AI Generation**: The current `AgentLoop` can create basic rectangles, text, and 2D position keyframes, but cannot process prompts for 3D camera sweeps, AI video synthesis, or 3D asset generation.

---

## 2. Target Architecture & Master Plan

```
                                +----------------------------------+
                                |      AI USER / CLIENT AGENT      |
                                | (Claude Desktop / Cursor / AGY)  |
                                +----------------+-----------------+
                                                 | (MCP Protocol)
                                                 v
+--------------------------------------------------------------------------------------------------+
|                                    MCP PROTOCOL SERVER LAYER                                     |
|  - Stdio Transport (Desktop App / CLI)                                                            |
|  - SSE Transport (Remote Cloud Server Endpoint `/mcp/sse`)                                       |
|  - Standard Tools: motion_inspect_scene, motion_create_comp, motion_add_3d_mesh,                |
|                     motion_choreograph_camera, motion_generate_ai_asset, motion_render_mp4     |
+--------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+--------------------------------------------------------------------------------------------------+
|                                  BACKEND BYOK MULTI-MODAL VAULT                                  |
|  +---------------------+  +----------------------+  +---------------------+  +----------------+  |
|  | Text / Reasoning    |  | Video AI Generation  |  | 3D Mesh Generation  |  | Audio / TTS    |  |
|  | OpenAI / Anthropic /|  | Fal.ai / Runway /    |  | Tripo3D / Meshy /   |  | ElevenLabs /   |  |
|  | Gemini 3.5          |  | Luma / Replicate     |  | Rodin               |  | Suno           |  |
|  +---------------------+  +----------------------+  +---------------------+  +----------------+  |
+--------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+--------------------------------------------------------------------------------------------------+
|                                 FRONTEND 3D/2D ENGINE & TIMELINE                                 |
|  - Three.js / WebGL2 PBR Rendering Pipeline                                                     |
|  - GLTF/GLB 3D Model Loader with Skeletal & Morph Animations                                    |
|  - Multi-Track Timeline (Video, Audio, 3D Mesh, 2D Graphic Vector, Camera Rig)                  |
|  - Real-Time Camera Choreography Engine                                                         |
+--------------------------------------------------------------------------------------------------+
```

---

## 3. Implementation Roadmap

### Phase 1: Security Remediation & Multi-Modal BYOK Vault
1. **Fix `AiGatewayService.keyStatus`**: Return only `{ present: boolean, hint: string }`. Completely eliminate key plaintext transmission.
2. **Purge Client Plaintext Caching**: Remove `localStorage` key reads/writes in `aiProviderStore.ts`.
3. **Extend BYOK Provider Support**:
   - Add encryption & gateway routing for Fal.ai, Runway, Luma, Tripo3D, Meshy, ElevenLabs keys.

### Phase 2: Native MCP (Model Context Protocol) Integration
1. **Build NestJS MCP Module (`motion-back/src/mcp`)**:
   - Implement JSON-RPC 2.0 SSE endpoint at `/mcp/sse`.
   - Register full suite of project manipulation, 3D setup, camera choreography, and rendering tools.
2. **Build Local Stdio MCP Server (`motion-editor/electron/mcp-server-cli.ts`)**:
   - Enables CLI and desktop agent tools (Antigravity, Claude Desktop, Cursor) to connect locally without network setup.

### Phase 3: 3D Engine Extension & Multi-Modal AI Asset Synthesis
1. **Integrate GLTF/GLB Loader**: Add Three.js GLTFLoader to `@motion/renderer` and create `'mesh3d'` node type in `@motion/scene`.
2. **Prompt-to-3D Integration**: Add Tripo3D/Meshy API calls in gateway to convert text prompts into textured `.glb` models directly placed in scene tree.
3. **Prompt-to-Video Integration**: Add Fal.ai / Runway / Luma API calls in gateway to generate background video clips placed into timeline tracks.
4. **Camera Choreography Tools**: Add high-level 3D camera controls (Orbit, Target Tracking, Crane Shot, Fly-Through, Bezier Curve Pathing).

---

## 4. Summary of System Benefits

- **Zero-Leak Security Guarantee**: User API keys are stored encrypted (AES-256-GCM) and NEVER leave backend memory.
- **Universal LLM Control via MCP**: Any MCP-compatible AI agent (Antigravity, Claude Desktop, Cursor, Custom Agents) can control the video editor programmatically.
- **High-Impact 3D & Video Capabilities**: Users can produce cinematic 3D motion graphics, 3D model animations, and AI video compositions directly from prompts using their own provider API keys.
