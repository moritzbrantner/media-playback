# AGENTS.md

This repository is the headless media-playback capability.

## Boundaries

- Keep playback orchestration independent from timeline editing and UI presentation.
- `src/index.ts` is the public package surface.
- Keep browser-specific behavior behind the playback adapter seam.
- Do not add demuxing, decoding, frame caches, waveform generation, or UI controls unless the task explicitly requires them.
- Do not make publication part of ordinary feature development.

## TypeScript

- Prefer `type` aliases over `interface`.
- Model state and command outcomes with discriminated unions.
- Keep invalid combinations out of the public type surface.

## Verification

Add the smallest executable evidence for behavior changes and test through the public playback seam when practical.

Canonical commands:

- `bun run test`
- `bun run check-types`
- `bun run verify`
