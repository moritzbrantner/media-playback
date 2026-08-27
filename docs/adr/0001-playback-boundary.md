# ADR 0001: Keep playback orchestration separate from media backends

## Status

Accepted.

## Decision

Expose one headless playback surface and keep backend-specific behavior behind an adapter.

The first adapter targets `HTMLMediaElement`. Forward video timing uses presented-frame callbacks when available. Seeking remains a discrete asynchronous command. If a newer seek replaces an older one, the older result is reported as superseded rather than allowed to overwrite current state.

Timeline-to-source mapping belongs to timeline/editor callers. UI belongs to UI packages. Deterministic frame decoding and reverse playback may be added later through deeper backends without changing the basic playback ownership rule.

## Consequences

- Consumers observe one authoritative playback clock instead of reconciling competing clocks.
- Normal browser playback continues to use the browser media pipeline.
- Frame-accurate reverse playback is intentionally unsupported by the HTML adapter.
