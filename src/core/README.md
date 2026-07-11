Core architecture and data model notes

This document outlines the initial core data models and service boundaries for the Motion Editor.

Goals
- Provide concise TypeScript-first interfaces for the scene graph, timeline, assets, engines, and service contracts.
- Keep the core decoupled from UI; expose small, well-typed APIs that engines and plugins can implement.

Sections
- Scene graph
- Timeline model
- Assets
- Engine lifecycle & services
- Events & Commands

See `core/types.ts` for TypeScript definitions.
