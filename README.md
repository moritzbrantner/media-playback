# media-playback

Headless media playback primitives for browser and native editor workflows.

The package establishes one ownership rule:

> Forward playback has one authoritative clock. Seeking is a discrete asynchronous command.

It intentionally contains no timeline editor and no visual controls.

## MVP

- `createMediaPlayback(adapter)` provides the stable playback surface.
- `createHtmlMediaElementAdapter(element)` adapts `<video>` or `<audio>`.
- Explicit precise and fast seek modes.
- Newer seeks supersede stale in-flight seeks.
- Video uses `requestVideoFrameCallback` as its clock when available.
- Audio and older video environments fall back to media-element time/events.
- Reverse playback is rejected unless a future backend explicitly advertises support.
- Errors and unsupported operations are returned as typed results.

## Example

```ts
import {
  createHtmlMediaElementAdapter,
  createMediaPlayback,
} from "@moritzbrantner/media-playback";

const video = document.querySelector("video");

if (!video) {
  throw new Error("Missing video element");
}

const playback = createMediaPlayback(createHtmlMediaElementAdapter(video));

await playback.load({ type: "url", url: "/clip.webm" });
await playback.seek({ timeMs: 12_500, mode: "precise" });
await playback.play();

const unsubscribe = playback.subscribe((snapshot) => {
  if (snapshot.status === "playing") {
    console.log(snapshot.currentTimeMs);
  }
});

// Later:
unsubscribe();
playback.dispose();
```

## Boundary with editors and UI

A timeline editor maps timeline time to source-media time and sends playback commands here. It should not implement browser drift state machines itself.

A UI package may provide transport buttons, scrubbers, timecode fields, and loading indicators. Those components should not know about browser media events, keyframes, decoders, or playback clocks.

## Not in this MVP

- WebCodecs/demuxer backend
- decoded-frame cache
- exact frame stepping
- frame-accurate reverse playback
- audio/video mixing
- timeline semantics
- React components

Those capabilities can be added behind the playback boundary when there is a concrete consumer.
