import type {
  MediaPlaybackAdapter,
  MediaPlaybackError,
  MediaPlaybackErrorCode,
  MediaPlaybackResult,
  MediaPlaybackSnapshot,
  MediaPlaybackSource,
  MediaSeekRequest,
  MediaSeekResult,
} from "./types";

export type MediaPlayback = {
  readonly capabilities: MediaPlaybackAdapter["capabilities"];
  getSnapshot: () => MediaPlaybackSnapshot;
  subscribe: (listener: (snapshot: MediaPlaybackSnapshot) => void) => () => void;
  load: (source: MediaPlaybackSource) => Promise<MediaPlaybackResult<MediaPlaybackSnapshot>>;
  play: () => Promise<MediaPlaybackResult<MediaPlaybackSnapshot>>;
  pause: () => MediaPlaybackResult<MediaPlaybackSnapshot>;
  seek: (request: MediaSeekRequest) => Promise<MediaPlaybackResult<MediaSeekResult>>;
  setPlaybackRate: (playbackRate: number) => MediaPlaybackResult<MediaPlaybackSnapshot>;
  dispose: () => void;
};

export function createMediaPlayback(adapter: MediaPlaybackAdapter): MediaPlayback {
  const listeners = new Set<(snapshot: MediaPlaybackSnapshot) => void>();
  let disposed = false;
  let source: MediaPlaybackSource | undefined;
  let seekGeneration = 0;
  let activeSeekAbort: AbortController | undefined;
  let snapshot: MediaPlaybackSnapshot = {
    status: "idle",
    capabilities: adapter.capabilities,
  };

  const emit = () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const timedFields = () => {
    if (!source) {
      throw new Error("Playback source is required for timed state.");
    }

    const adapterSnapshot = adapter.getSnapshot();

    return {
      source,
      currentTimeMs: adapterSnapshot.currentTimeMs,
      ...(adapterSnapshot.durationMs === undefined
        ? {}
        : { durationMs: adapterSnapshot.durationMs }),
      playbackRate: adapterSnapshot.playbackRate,
      capabilities: adapter.capabilities,
    };
  };

  const timedSnapshot = (status: "ready" | "playing" | "ended"): MediaPlaybackSnapshot => ({
    status,
    ...timedFields(),
  });

  const refreshFromAdapter = () => {
    if (disposed || !source || snapshot.status === "loading" || snapshot.status === "error") {
      return;
    }

    const adapterSnapshot = adapter.getSnapshot();

    if (snapshot.status === "seeking") {
      snapshot = {
        status: "seeking",
        ...timedFields(),
        targetTimeMs: snapshot.targetTimeMs,
        seekMode: snapshot.seekMode,
      };
      emit();
      return;
    }

    snapshot = timedSnapshot(
      adapterSnapshot.ended ? "ended" : adapterSnapshot.paused ? "ready" : "playing",
    );
    emit();
  };

  const unsubscribeAdapter = adapter.subscribe(refreshFromAdapter);

  const fail = <T>(code: MediaPlaybackErrorCode, error: unknown): MediaPlaybackResult<T> => {
    const playbackError = toPlaybackError(code, error);

    snapshot = {
      status: "error",
      ...(source ? { source } : {}),
      capabilities: adapter.capabilities,
      error: playbackError,
    };
    emit();

    return { ok: false, error: playbackError };
  };

  const unavailable = <T>(
    code: "disposed" | "not-loaded",
    message: string,
  ): MediaPlaybackResult<T> => ({
    ok: false,
    error: { code, message },
  });

  return {
    capabilities: adapter.capabilities,

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);

      return () => {
        listeners.delete(listener);
      };
    },

    async load(nextSource) {
      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      activeSeekAbort?.abort();
      seekGeneration += 1;
      source = nextSource;
      snapshot = {
        status: "loading",
        source,
        capabilities: adapter.capabilities,
      };
      emit();

      const loadAbort = new AbortController();

      try {
        await adapter.load(source, loadAbort.signal);
      } catch (error) {
        return fail("load-failed", error);
      }

      snapshot = timedSnapshot("ready");
      emit();
      return { ok: true, value: snapshot };
    },

    async play() {
      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      if (!source) {
        return unavailable("not-loaded", "Load a media source before starting playback.");
      }

      try {
        await adapter.play();
      } catch (error) {
        return fail("play-failed", error);
      }

      snapshot = timedSnapshot(adapter.getSnapshot().ended ? "ended" : "playing");
      emit();
      return { ok: true, value: snapshot };
    },

    pause() {
      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      if (!source) {
        return unavailable("not-loaded", "Load a media source before pausing playback.");
      }

      adapter.pause();
      snapshot = timedSnapshot(adapter.getSnapshot().ended ? "ended" : "ready");
      emit();
      return { ok: true, value: snapshot };
    },

    async seek(request) {
      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      if (!source) {
        return unavailable("not-loaded", "Load a media source before seeking.");
      }

      if (!Number.isFinite(request.timeMs)) {
        return {
          ok: false,
          error: {
            code: "seek-failed",
            message: "Seek time must be a finite number.",
          },
        };
      }

      const requestedTimeMs = Math.max(0, request.timeMs);
      const mode = request.mode ?? "precise";
      const generation = ++seekGeneration;

      activeSeekAbort?.abort();
      const seekAbort = new AbortController();
      activeSeekAbort = seekAbort;

      const adapterSnapshot = adapter.getSnapshot();
      snapshot = {
        status: "seeking",
        source,
        currentTimeMs: adapterSnapshot.currentTimeMs,
        ...(adapterSnapshot.durationMs === undefined
          ? {}
          : { durationMs: adapterSnapshot.durationMs }),
        playbackRate: adapterSnapshot.playbackRate,
        capabilities: adapter.capabilities,
        targetTimeMs: requestedTimeMs,
        seekMode: mode,
      };
      emit();

      try {
        const result = await adapter.seek({
          timeMs: requestedTimeMs,
          mode,
          signal: seekAbort.signal,
        });

        if (generation !== seekGeneration) {
          return {
            ok: true,
            value: {
              status: "superseded",
              requestedTimeMs,
            },
          };
        }

        activeSeekAbort = undefined;
        const nextAdapterSnapshot = adapter.getSnapshot();
        snapshot = timedSnapshot(
          nextAdapterSnapshot.ended ? "ended" : nextAdapterSnapshot.paused ? "ready" : "playing",
        );
        emit();

        return {
          ok: true,
          value: {
            status: "completed",
            requestedTimeMs,
            actualTimeMs: result.actualTimeMs,
            modeUsed: result.modeUsed,
          },
        };
      } catch (error) {
        if (generation !== seekGeneration || isAbortError(error)) {
          return {
            ok: true,
            value: {
              status: "superseded",
              requestedTimeMs,
            },
          };
        }

        activeSeekAbort = undefined;
        return fail("seek-failed", error);
      }
    },

    setPlaybackRate(playbackRate) {
      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      if (!source) {
        return unavailable("not-loaded", "Load a media source before changing playback rate.");
      }

      if (!Number.isFinite(playbackRate) || playbackRate === 0) {
        return {
          ok: false,
          error: {
            code: "invalid-rate",
            message: "Playback rate must be a finite non-zero number.",
          },
        };
      }

      if (playbackRate < 0 && !adapter.capabilities.reversePlayback) {
        return {
          ok: false,
          error: {
            code: "unsupported-operation",
            message: "This playback backend does not support reverse playback.",
          },
        };
      }

      try {
        adapter.setPlaybackRate(playbackRate);
      } catch (error) {
        return fail("invalid-rate", error);
      }

      const adapterSnapshot = adapter.getSnapshot();
      snapshot = timedSnapshot(
        adapterSnapshot.ended ? "ended" : adapterSnapshot.paused ? "ready" : "playing",
      );
      emit();
      return { ok: true, value: snapshot };
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      seekGeneration += 1;
      activeSeekAbort?.abort();
      unsubscribeAdapter();
      adapter.dispose();
      listeners.clear();
    },
  };
}

function toPlaybackError(code: MediaPlaybackErrorCode, error: unknown): MediaPlaybackError {
  if (error instanceof Error && error.message) {
    return {
      code,
      message: error.message,
      cause: error,
    };
  }

  return {
    code,
    message: `Media playback command failed: ${code}.`,
    cause: error,
  };
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
