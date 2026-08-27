import { describe, expect, test } from "vitest";

import { createMediaPlayback } from "./playback";
import type {
  MediaPlaybackAdapter,
  MediaPlaybackAdapterSeekResult,
  MediaPlaybackAdapterSnapshot,
  MediaPlaybackSource,
} from "./types";

type PendingSeek = {
  request: {
    timeMs: number;
    mode: "precise" | "fast";
    signal: AbortSignal;
  };
  resolve: (result: MediaPlaybackAdapterSeekResult) => void;
};

function createTestAdapter() {
  const listeners = new Set<() => void>();
  const pendingSeeks: PendingSeek[] = [];
  let snapshot: MediaPlaybackAdapterSnapshot = {
    currentTimeMs: 0,
    durationMs: 10_000,
    paused: true,
    ended: false,
    playbackRate: 1,
  };

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const adapter: MediaPlaybackAdapter = {
    capabilities: {
      preciseSeek: true,
      fastSeek: true,
      reversePlayback: false,
      presentedFrameClock: true,
    },

    async load(_source: MediaPlaybackSource) {
      snapshot = { ...snapshot, currentTimeMs: 0, paused: true, ended: false };
      notify();
    },

    async play() {
      snapshot = { ...snapshot, paused: false };
      notify();
    },

    pause() {
      snapshot = { ...snapshot, paused: true };
      notify();
    },

    seek(request) {
      return new Promise<MediaPlaybackAdapterSeekResult>((resolve, reject) => {
        const handleAbort = () => {
          request.signal.removeEventListener("abort", handleAbort);
          reject(new DOMException("Superseded", "AbortError"));
        };

        request.signal.addEventListener("abort", handleAbort, { once: true });
        pendingSeeks.push({
          request,
          resolve: (result) => {
            request.signal.removeEventListener("abort", handleAbort);
            snapshot = { ...snapshot, currentTimeMs: result.actualTimeMs };
            notify();
            resolve(result);
          },
        });
      });
    },

    setPlaybackRate(playbackRate) {
      snapshot = { ...snapshot, playbackRate };
      notify();
    },

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      listeners.clear();
    },
  };

  return { adapter, pendingSeeks };
}

describe("createMediaPlayback", () => {
  test("owns load, play, pause, and rate state through one public seam", async () => {
    const { adapter } = createTestAdapter();
    const playback = createMediaPlayback(adapter);

    expect(playback.getSnapshot().status).toBe("idle");

    const loaded = await playback.load({ type: "url", url: "/clip.webm" });
    expect(loaded.ok).toBe(true);
    expect(playback.getSnapshot().status).toBe("ready");

    const played = await playback.play();
    expect(played.ok).toBe(true);
    expect(playback.getSnapshot().status).toBe("playing");

    const rate = playback.setPlaybackRate(2);
    expect(rate.ok).toBe(true);
    expect(playback.getSnapshot()).toMatchObject({ status: "playing", playbackRate: 2 });

    const paused = playback.pause();
    expect(paused.ok).toBe(true);
    expect(playback.getSnapshot().status).toBe("ready");
  });

  test("reports stale seeks as superseded instead of allowing them to win", async () => {
    const { adapter, pendingSeeks } = createTestAdapter();
    const playback = createMediaPlayback(adapter);

    await playback.load({ type: "url", url: "/clip.webm" });

    const first = playback.seek({ timeMs: 1_000 });
    const second = playback.seek({ timeMs: 2_000, mode: "fast" });

    expect(pendingSeeks).toHaveLength(2);

    pendingSeeks[1]?.resolve({
      actualTimeMs: 2_050,
      modeUsed: "fast",
    });

    await expect(second).resolves.toEqual({
      ok: true,
      value: {
        status: "completed",
        requestedTimeMs: 2_000,
        actualTimeMs: 2_050,
        modeUsed: "fast",
      },
    });

    await expect(first).resolves.toEqual({
      ok: true,
      value: {
        status: "superseded",
        requestedTimeMs: 1_000,
      },
    });

    expect(playback.getSnapshot()).toMatchObject({
      status: "ready",
      currentTimeMs: 2_050,
    });
  });

  test("rejects reverse rates when the backend does not advertise reverse playback", async () => {
    const { adapter } = createTestAdapter();
    const playback = createMediaPlayback(adapter);

    await playback.load({ type: "url", url: "/clip.webm" });

    expect(playback.setPlaybackRate(-1)).toEqual({
      ok: false,
      error: {
        code: "unsupported-operation",
        message: "This playback backend does not support reverse playback.",
      },
    });
    expect(adapter.getSnapshot().playbackRate).toBe(1);
  });
});
