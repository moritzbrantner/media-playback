# Context

`media-playback` is a headless playback capability shared by editors and media applications.

## Terms

- **Playback clock**: the single time source used to report forward playback progress.
- **Seek**: a discrete asynchronous request to reposition media.
- **Precise seek**: a seek that prioritizes the requested timestamp.
- **Fast seek**: a backend-assisted approximate seek intended for responsive scrubbing.
- **Adapter**: a backend implementation behind the stable playback surface.
- **Presented-frame clock**: video timing reported when a frame is submitted for presentation, such as `requestVideoFrameCallback`.

## MVP boundary

The MVP owns playback, pause, rate changes, seek lifecycle, seek supersession, and clock observation.

It does not own timeline editing, UI controls, media demuxing, deterministic frame decoding, frame caches, or frame-accurate reverse playback.
