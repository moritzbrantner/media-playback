import { describe, expect, test, vi } from "vitest";

import { createHtmlMediaElementAdapter } from "./html-media-element-adapter";

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

class FakeMediaElement extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 10;
  paused = true;
  ended = false;
  playbackRate = 1;
  readyState = 0;
  error: { code: number; message: string } | null = null;
  fastSeek: ((timeSeconds: number) => void) | undefined;
  requestVideoFrameCallback: ((callback: FrameCallback) => number) | undefined;
  cancelVideoFrameCallback: ((handle: number) => void) | undefined;
  private frameCallback: FrameCallback | undefined;

  constructor(options: { fastSeek?: boolean; frameClock?: boolean } = {}) {
    super();

    if (options.fastSeek) {
      this.fastSeek = (timeSeconds) => {
        this.currentTime = timeSeconds;
      };
    }

    if (options.frameClock) {
      this.requestVideoFrameCallback = (callback) => {
        this.frameCallback = callback;
        return 1;
      };
      this.cancelVideoFrameCallback = () => {
        this.frameCallback = undefined;
      };
    }
  }

  load() {
    this.readyState = 1;
    queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  finishSeek() {
    this.dispatchEvent(new Event("seeked"));
  }

  presentFrame(mediaTime: number) {
    const callback = this.frameCallback;
    this.frameCallback = undefined;
    callback?.(performance.now(), { mediaTime });
  }
}

function asMediaElement(fake: FakeMediaElement) {
  return fake as unknown as HTMLMediaElement;
}

describe("createHtmlMediaElementAdapter", () => {
  test("loads a URL and exposes media metadata", async () => {
    const media = new FakeMediaElement();
    media.duration = 12.5;
    const adapter = createHtmlMediaElementAdapter(asMediaElement(media));

    await adapter.load({ type: "url", url: "/clip.webm" }, new AbortController().signal);

    expect(media.src).toBe("/clip.webm");
    expect(adapter.getSnapshot()).toMatchObject({
      durationMs: 12_500,
      currentTimeMs: 0,
      paused: true,
    });
  });

  test("uses precise currentTime seeking by default and waits for seek completion", async () => {
    const media = new FakeMediaElement();
    const adapter = createHtmlMediaElementAdapter(asMediaElement(media));

    const seek = adapter.seek({
      timeMs: 1_500,
      mode: "precise",
      signal: new AbortController().signal,
    });

    expect(media.currentTime).toBe(1.5);
    media.finishSeek();

    await expect(seek).resolves.toEqual({
      actualTimeMs: 1_500,
      modeUsed: "precise",
    });
  });

  test("uses fastSeek only when explicitly requested and available", async () => {
    const media = new FakeMediaElement({ fastSeek: true });
    const spy = vi.spyOn(media, "fastSeek");
    const adapter = createHtmlMediaElementAdapter(asMediaElement(media));

    const seek = adapter.seek({
      timeMs: 2_000,
      mode: "fast",
      signal: new AbortController().signal,
    });

    expect(spy).toHaveBeenCalledWith(2);
    media.finishSeek();

    await expect(seek).resolves.toMatchObject({
      actualTimeMs: 2_000,
      modeUsed: "fast",
    });
  });

  test("reports presented video frame time when the browser exposes a frame clock", () => {
    const media = new FakeMediaElement({ frameClock: true });
    const adapter = createHtmlMediaElementAdapter(asMediaElement(media));
    const listener = vi.fn();

    adapter.subscribe(listener);
    media.currentTime = 1;
    media.presentFrame(1.25);

    expect(listener).toHaveBeenCalled();
    expect(adapter.getSnapshot().currentTimeMs).toBe(1_250);
    expect(adapter.capabilities.presentedFrameClock).toBe(true);
  });
});
