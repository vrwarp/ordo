# ADR 0001: Stack

## Decision
TypeScript everywhere in a pnpm monorepo. React 19 for the operator and stage apps.
Node 22 with Fastify for the hub. WebGPU only for the output renderer, no WebGL2 fallback.

## Reasons
- One language lets the live-state reducer, protocol schemas and domain types be shared
  byte for byte between hub, operator and outputs, which is what makes the fallback bus
  and optimistic UI safe.
- React has the broadest ecosystem for the editor and settings UIs; the output render
  path is framework-free regardless.
- WebGPU is the founding document's choice and the venue PC will be verified for it in
  M1. A WebGL2 fallback would double the renderer surface for a machine we control.

## Consequences
- The venue PC must have WebGPU hardware acceleration; if it does not, the fix is a GPU
  driver or hardware change, not code.
- Deployment is one Docker image containing both hub and built apps, so protocol
  versions never drift.
