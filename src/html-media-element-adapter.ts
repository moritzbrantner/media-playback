import type {
  MediaPlaybackAdapter,
  MediaPlaybackAdapterSeekResult,
  MediaPlaybackAdapterSnapshot,
  MediaPlaybackCapabilities,
  MediaPlaybackSource,
  MediaSeekMode,
} from "./types";

type VideoFrameMetadataLike = {
  mediaTime: number;
};

type HtmlMediaElementWithOptionalApis = HTMLMediaElement & {
  fastSeek?: (timeSeconds: number) => void;
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadataLike) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const metadataReadyState = 1;

export function createHtmlMediaElementAdapter(element: HTMLMediaElement): MediaPlaybackAdapter {
  const media = element as HtmlMediaElementWithOptionalApis;
  const listeners = new Set<() => void>();
  const capabilities: MediaPlaybackCapabilities = {
    preciseSeek: true,
    fastSeek: Boolean(getFastSeek(media)),
    reversePlayback: false,
    presentedFrameClock: typeof media.requestVideoFrameCallback === "function",
  };
  let disposed = false;
  let presentedTimeMs: number | undefined;
  let videoFrameHandle: number | undefined;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const clearPresentedTime = () => {
    presentedTimeMs = undefined;
    notify();
  };

  const notifyEvents = [
    "loadedmetadata",
    "durationchange",
    "timeupdate",
    "playing",
    "pause",
    "ended",
    "seeked",
  ] as const;

  for (const eventName of notifyEvents) {
    media.addEventListener(eventName, notify);
  }

  media.addEventListener("seeking", clearPresentedTime);
  media.addEventListener("emptied", clearPresentedTime);

  const schedulePresentedFrame = () => {
    if (
      disposed ||
      listeners.size === 0 ||
      videoFrameHandle !== undefined ||
      !media.requestVideoFrameCallback
    ) {
      return;
    }

    videoFrameHandle = media.requestVideoFrameCallback((_now, metadata) => {
      videoFrameHandle = undefined;
      presentedTimeMs = finiteMilliseconds(metadata.mediaTime * 1_000);
      notify();
      schedulePresentedFrame();
    });
  };

  return {
    capabilities,

    async load(source, signal) {
      assertActive(disposed);
      presentedTimeMs = undefined;
      media.src = getSourceUrl(source);
      media.load();

      if (media.readyState >= metadataReadyState) {
        notify();
        return;
      }

      await waitForMediaEvent(media, "loadedmetadata", signal);
      notify();
    },

    async play() {
      assertActive(disposed);
      await media.play();
      notify();
    },

    pause() {
      assertActive(disposed);
      media.pause();
      notify();
    },

    async seek(request) {
      assertActive(disposed);
      const targetTimeSeconds = clampSeekSeconds(media, request.timeMs / 1_000);
      const currentTimeSeconds = finiteSeconds(media.currentTime);

      if (Math.abs(currentTimeSeconds - targetTimeSeconds) <= 0.0005) {
        return {
          actualTimeMs: currentTimeSeconds * 1_000,
          modeUsed: resolveSeekMode(media, request.mode),
        };
      }

      presentedTimeMs = undefined;
      const seeked = waitForMediaEvent(media, "seeked", request.signal);
      const modeUsed = applySeek(media, targetTimeSeconds, request.mode);

      await seeked;
      notify();

      return {
        actualTimeMs: finiteSeconds(media.currentTime) * 1_000,
        modeUsed,
      };
    },

    setPlaybackRate(playbackRate) {
      assertActive(disposed);
      media.playbackRate = playbackRate;
      notify();
    },

    getSnapshot() {
      return getAdapterSnapshot(media, presentedTimeMs);
    },

    subscribe(listener) {
      assertActive(disposed);
      listeners.add(listener);
      schedulePresentedFrame();

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0 && videoFrameHandle !== undefined) {
          media.cancelVideoFrameCallback?.(videoFrameHandle);
          videoFrameHandle = undefined;
        }
      };
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;

      for (const eventName of notifyEvents) {
        media.removeEventListener(eventName, notify);
      }

      media.removeEventListener("seeking", clearPresentedTime);
      media.removeEventListener("emptied", clearPresentedTime);

      if (videoFrameHandle !== undefined) {
        media.cancelVideoFrameCallback?.(videoFrameHandle);
        videoFrameHandle = undefined;
      }

      listeners.clear();
    },
  };
}

function getAdapterSnapshot(
  media: HtmlMediaElementWithOptionalApis,
  presentedTimeMs: number | undefined,
): MediaPlaybackAdapterSnapshot {
  const durationMs = Number.isFinite(media.duration) ? Math.max(0, media.duration * 1_000) : undefined;

  return {
    currentTimeMs: presentedTimeMs ?? finiteSeconds(media.currentTime) * 1_000,
    ...(durationMs === undefined ? {} : { durationMs }),
    paused: media.paused,
    ended: media.ended,
    playbackRate: media.playbackRate,
  };
}

function getSourceUrl(source: MediaPlaybackSource) {
  switch (source.type) {
    case "url":
      return source.url;
  }
}

function applySeek(
  media: HtmlMediaElementWithOptionalApis,
  targetTimeSeconds: number,
  requestedMode: MediaSeekMode,
): MediaSeekMode {
  const fastSeek = getFastSeek(media);

  if (requestedMode === "fast" && fastSeek) {
    fastSeek.call(media, targetTimeSeconds);
    return "fast";
  }

  media.currentTime = targetTimeSeconds;
  return "precise";
}

function resolveSeekMode(
  media: HtmlMediaElementWithOptionalApis,
  requestedMode: MediaSeekMode,
): MediaSeekMode {
  return requestedMode === "fast" && getFastSeek(media) ? "fast" : "precise";
}

function getFastSeek(media: HTMLMediaElement) {
  const candidate = (media as unknown as { fastSeek?: unknown }).fastSeek;

  return typeof candidate === "function"
    ? (candidate as (timeSeconds: number) => void)
    : undefined;
}

function clampSeekSeconds(media: HTMLMediaElement, requestedTimeSeconds: number) {
  const nonNegativeTime = Math.max(0, finiteSeconds(requestedTimeSeconds));

  if (!Number.isFinite(media.duration)) {
    return nonNegativeTime;
  }

  return Math.min(media.duration, nonNegativeTime);
}

function finiteSeconds(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function finiteMilliseconds(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function assertActive(disposed: boolean) {
  if (disposed) {
    throw new Error("HTML media adapter has been disposed.");
  }
}

function waitForMediaEvent(
  media: HTMLMediaElement,
  successEvent: "loadedmetadata" | "seeked",
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener(successEvent, handleSuccess);
      media.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(getMediaElementError(media));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Media operation was superseded.", "AbortError"));
    };

    media.addEventListener(successEvent, handleSuccess, { once: true });
    media.addEventListener("error", handleError, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });

    if (signal.aborted) {
      handleAbort();
    }
  });
}

function getMediaElementError(media: HTMLMediaElement) {
  const code = media.error?.code;
  const message = media.error?.message;

  return new Error(
    message || (code ? `HTML media element failed with error code ${code}.` : "HTML media failed."),
  );
}
