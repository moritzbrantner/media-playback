import { describe, expect, test } from "vitest";

import { createMediaPlayback } from "./playback";
import type {
  MediaPlaybackAdapter,
  MediaPlaybackAdapterSeekResult,
  MediaPlaybackAdapterSnapshot,
  MediaPlaybackSource,
} from "./types";

type PendingLoad = {
  source: MediaPlaybackSource;
  signal: AbortSignal;
  resolve: () => void;
};

type PendingPlay = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingSeek = {
  request: {
    timeMs: number;
    mode: "precise" | "fast";
    signal: AbortSignal;
  };
  resolve: (result: MediaPlaybackAdapterSeekResult) => void;
};

function createTestAdapter(options: { deferLoads?: boolean; deferPlays?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const pendingLoads: PendingLoad[] = [];
  const pendingPlays: PendingPlay[] = [];
  const pendingSeeks: PendingSeek[] = [];
  let snapshot: MediaPlaybackAdapterSnapshot = {
    currentTimeMs: 0,
    durationMs: 10_000,
    paused: true,
    ended: false,
    buffering: false,
    playbackRate: 1,
  };

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const completeLoad = () => {
    snapshot = {
      ...snapshot,
      currentTimeMs: 0,
      paused: true,
      ended: false,
      buffering: false,
    };
    notify();
  };

  const adapter: MediaPlaybackAdapter = {
    capabilities: {
      preciseSeek: true,
      fastSeek: true,
      reversePlayback: false,
      presentedFrameClock: true,
    },

    async load(source: MediaPlaybackSource, signal: AbortSignal) {
      if (!options.deferLoads) {
        completeLoad();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const handleAbort = () => {
          signal.removeEventListener("abort", handleAbort);
          reject(new DOMException("Superseded", "AbortError"));
        };

        signal.addEventListener("abort", handleAbort, { once: true });
        pendingLoads.push({
          source,
          signal,
          resolve: () => {
            signal.removeEventListener("abort", handleAbort);

            if (signal.aborted) {
              reject(new DOMException("Superseded", "AbortError"));
              return;
            }

            completeLoad();
            resolve();
          },
        });
      });
    },

    async play() {
      if (!options.deferPlays) {
        snapshot = { ...snapshot, paused: false, buffering: false };
        notify();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        pendingPlays.push({
          resolve: () => {
            snapshot = { ...snapshot, paused: false, buffering: false };
            notify();
            resolve();
          },
          reject,
        });
      });
    },

    pause() {
      snapshot = { ...snapshot, paused: true, buffering: false };
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

  const setBuffering = (buffering: boolean) => {
    snapshot = { ...snapshot, buffering };
    notify();
  };

  return { adapter, pendingLoads, pendingPlays, pendingSeeks, setBuffering };
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

  test("ignores a stale play failure after a newer pause intent", async () => {
    const { adapter, pendingPlays } = createTestAdapter({ deferPlays: true });
    const playback = createMediaPlayback(adapter);

    await playback.load({ type: "url", url: "/clip.webm" });

    const play = playback.play();
    expect(pendingPlays).toHaveLength(1);

    expect(playback.pause()).toMatchObject({
      ok: true,
      value: { status: "ready" },
    });

    pendingPlays[0]?.reject(new Error("autoplay denied"));

    await expect(play).resolves.toMatchObject({
      ok: true,
      value: { status: "ready" },
    });
    expect(playback.getSnapshot().status).toBe("ready");
  });

  test("keeps the newest play command authoritative", async () => {
    const { adapter, pendingPlays } = createTestAdapter({ deferPlays: true });
    const playback = createMediaPlayback(adapter);

    await playback.load({ type: "url", url: "/clip.webm" });

    const first = playback.play();
    const second = playback.play();

    expect(pendingPlays).toHaveLength(2);

    pendingPlays[1]?.resolve();
    await expect(second).resolves.toMatchObject({
      ok: true,
      value: { status: "playing" },
    });

    pendingPlays[0]?.reject(new Error("stale play failure"));
    await expect(first).resolves.toMatchObject({
      ok: true,
      value: { status: "playing" },
    });

    expect(playback.getSnapshot().status).toBe("playing");
  });

  test("distinguishes active playback from temporary buffering", async () => {
    const { adapter, setBuffering } = createTestAdapter();
    const playback = createMediaPlayback(adapter);

    await playback.load({ type: "url", url: "/clip.webm" });
    await playback.play();

    setBuffering(true);
    expect(playback.getSnapshot()).toMatchObject({
      status: "buffering",
      currentTimeMs: 0,
    });

    setBuffering(false);
    expect(playback.getSnapshot().status).toBe("playing");

    setBuffering(true);
    expect(playback.pause()).toMatchObject({
      ok: true,
      value: { status: "ready" },
    });
  });

  test("keeps the newest load authoritative when an older load is still in flight", async () => {
    const { adapter, pendingLoads } = createTestAdapter({ deferLoads: true });
    const playback = createMediaPlayback(adapter);

    const first = playback.load({ type: "url", url: "/first.webm" });
    const second = playback.load({ type: "url", url: "/second.webm" });

    expect(pendingLoads).toHaveLength(2);
    expect(pendingLoads[0]?.signal.aborted).toBe(true);

    await expect(first).resolves.toMatchObject({
      ok: true,
      value: {
        status: "loading",
        source: { type: "url", url: "/second.webm" },
      },
    });

    pendingLoads[1]?.resolve();

    await expect(second).resolves.toMatchObject({
      ok: true,
      value: {
        status: "ready",
        source: { type: "url", url: "/second.webm" },
      },
    });
    expect(playback.getSnapshot()).toMatchObject({
      status: "ready",
      source: { type: "url", url: "/second.webm" },
    });
  });

  test("does not expose playback commands until the current load completes", async () => {
    const { adapter, pendingLoads } = createTestAdapter({ deferLoads: true });
    const playback = createMediaPlayback(adapter);
    const loading = playback.load({ type: "url", url: "/clip.webm" });

    await expect(playback.play()).resolves.toMatchObject({
      ok: false,
      error: { code: "not-loaded" },
    });
    await expect(playback.seek({ timeMs: 1_000 })).resolves.toMatchObject({
      ok: false,
      error: { code: "not-loaded" },
    });
    expect(playback.pause()).toMatchObject({
      ok: false,
      error: { code: "not-loaded" },
    });
    expect(playback.setPlaybackRate(2)).toMatchObject({
      ok: false,
      error: { code: "not-loaded" },
    });

    pendingLoads[0]?.resolve();
    await loading;

    await expect(playback.play()).resolves.toMatchObject({ ok: true });
  });

  test("aborts an in-flight load when playback is disposed", async () => {
    const { adapter, pendingLoads } = createTestAdapter({ deferLoads: true });
    const playback = createMediaPlayback(adapter);
    const loading = playback.load({ type: "url", url: "/clip.webm" });

    const signal = pendingLoads[0]?.signal;
    playback.dispose();

    expect(signal?.aborted).toBe(true);
    await expect(loading).resolves.toEqual({
      ok: false,
      error: {
        code: "disposed",
        message: "Playback has been disposed.",
      },
    });
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
