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
  let loaded = false;
  let source: MediaPlaybackSource | undefined;
  let sourceGeneration = 0;
  let transportGeneration = 0;
  let transportIntent: "paused" | "playing" = "paused";
  let seekGeneration = 0;
  let activeLoadAbort: AbortController | undefined;
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

  const timedSnapshot = (
    status: "ready" | "playing" | "buffering" | "ended",
  ): MediaPlaybackSnapshot => ({
    status,
    ...timedFields(),
  });

  const timedStatus = (
    adapterSnapshot: ReturnType<MediaPlaybackAdapter["getSnapshot"]>,
  ): "ready" | "playing" | "buffering" | "ended" =>
    adapterSnapshot.ended
      ? "ended"
      : transportIntent === "paused" || adapterSnapshot.paused
        ? "ready"
        : adapterSnapshot.buffering
          ? "buffering"
          : "playing";

  const refreshFromAdapter = () => {
    if (disposed || !loaded || !source || snapshot.status === "error") {
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

    snapshot = timedSnapshot(timedStatus(adapterSnapshot));
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

  const requireLoaded = <T>(message: string): MediaPlaybackResult<T> | undefined => {
    if (disposed) {
      return unavailable("disposed", "Playback has been disposed.");
    }

    if (!loaded || !source) {
      return unavailable("not-loaded", message);
    }

    return undefined;
  };

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

      const generation = ++sourceGeneration;
      transportGeneration += 1;
      transportIntent = "paused";
      loaded = false;

      activeLoadAbort?.abort();
      activeSeekAbort?.abort();
      activeSeekAbort = undefined;
      seekGeneration += 1;

      const loadAbort = new AbortController();
      activeLoadAbort = loadAbort;
      source = nextSource;
      snapshot = {
        status: "loading",
        source,
        capabilities: adapter.capabilities,
      };
      emit();

      try {
        await adapter.load(nextSource, loadAbort.signal);
      } catch (error) {
        if (disposed) {
          return unavailable("disposed", "Playback has been disposed.");
        }

        if (generation !== sourceGeneration || loadAbort.signal.aborted) {
          return { ok: true, value: snapshot };
        }

        if (activeLoadAbort === loadAbort) {
          activeLoadAbort = undefined;
        }

        return fail("load-failed", error);
      }

      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      if (generation !== sourceGeneration) {
        return { ok: true, value: snapshot };
      }

      if (activeLoadAbort === loadAbort) {
        activeLoadAbort = undefined;
      }

      loaded = true;
      snapshot = timedSnapshot("ready");
      emit();
      return { ok: true, value: snapshot };
    },

    async play() {
      const unavailableResult = requireLoaded<MediaPlaybackSnapshot>(
        "Load a media source before starting playback.",
      );
      if (unavailableResult) {
        return unavailableResult;
      }

      const sourceAtStart = sourceGeneration;
      const generation = ++transportGeneration;
      transportIntent = "playing";

      try {
        await adapter.play();
      } catch (error) {
        if (disposed) {
          return unavailable("disposed", "Playback has been disposed.");
        }

        if (
          sourceAtStart !== sourceGeneration ||
          generation !== transportGeneration ||
          !loaded
        ) {
          return { ok: true, value: snapshot };
        }

        transportIntent = "paused";
        return fail("play-failed", error);
      }

      if (disposed) {
        return unavailable("disposed", "Playback has been disposed.");
      }

      if (sourceAtStart !== sourceGeneration || !loaded) {
        return { ok: true, value: snapshot };
      }

      if (generation !== transportGeneration) {
        if (transportIntent === "paused") {
          adapter.pause();
          snapshot = timedSnapshot(timedStatus(adapter.getSnapshot()));
          emit();
        }

        return { ok: true, value: snapshot };
      }

      snapshot = timedSnapshot(timedStatus(adapter.getSnapshot()));
      emit();
      return { ok: true, value: snapshot };
    },

    pause() {
      const unavailableResult = requireLoaded<MediaPlaybackSnapshot>(
        "Load a media source before pausing playback.",
      );
      if (unavailableResult) {
        return unavailableResult;
      }

      transportGeneration += 1;
      transportIntent = "paused";
      adapter.pause();
      snapshot = timedSnapshot(timedStatus(adapter.getSnapshot()));
      emit();
      return { ok: true, value: snapshot };
    },

    async seek(request) {
      const unavailableResult = requireLoaded<MediaSeekResult>(
        "Load a media source before seeking.",
      );
      if (unavailableResult) {
        return unavailableResult;
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

      snapshot = {
        status: "seeking",
        ...timedFields(),
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
        snapshot = timedSnapshot(timedStatus(nextAdapterSnapshot));
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
      const unavailableResult = requireLoaded<MediaPlaybackSnapshot>(
        "Load a media source before changing playback rate.",
      );
      if (unavailableResult) {
        return unavailableResult;
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
      snapshot = timedSnapshot(timedStatus(adapterSnapshot));
      emit();
      return { ok: true, value: snapshot };
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      loaded = false;
      sourceGeneration += 1;
      transportGeneration += 1;
      transportIntent = "paused";
      seekGeneration += 1;
      activeLoadAbort?.abort();
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
