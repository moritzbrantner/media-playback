# Context

`media-playback` is a headless playback capability shared by editors and media applications.

## Terms

- **Playback clock**: the single time source used to report forward playback progress.
- **Seek**: a discrete asynchronous request to reposition media.
- **Precise seek**: a seek that prioritizes the requested timestamp.
- **Fast seek**: a backend-assisted approximate seek intended for responsive scrubbing.
- **Adapter**: a backend implementation behind the stable playback surface.
- **Presented-frame clock**: video timing reported when a frame is submitted for presentation, such as `requestVideoFrameCallback`.
- **Buffering**: playback intent is active, but the backend is temporarily unable to advance media time.

## MVP boundary

The MVP owns playback, pause, rate changes, source-load lifecycle, seek lifecycle, async-operation supersession, buffering state, and clock observation. Backend adapters detect their own waiting condition; the playback core only maps that condition into stable public state. A new source load invalidates older in-flight loads and seeks, and source-scoped commands remain unavailable until the current load completes.

It does not own timeline editing, UI controls, media demuxing, deterministic frame decoding, frame caches, or frame-accurate reverse playback.
