export type MediaSeekMode = "precise" | "fast";

export type MediaPlaybackSource = {
  type: "url";
  url: string;
};

export type MediaPlaybackCapabilities = {
  preciseSeek: true;
  fastSeek: boolean;
  reversePlayback: boolean;
  presentedFrameClock: boolean;
};

export type MediaPlaybackErrorCode =
  | "disposed"
  | "invalid-rate"
  | "load-failed"
  | "not-loaded"
  | "play-failed"
  | "seek-failed"
  | "unsupported-operation";

export type MediaPlaybackError = {
  code: MediaPlaybackErrorCode;
  message: string;
  cause?: unknown;
};

export type MediaPlaybackResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: MediaPlaybackError;
    };

type MediaPlaybackTimedSnapshot = {
  source: MediaPlaybackSource;
  currentTimeMs: number;
  durationMs?: number;
  playbackRate: number;
  capabilities: MediaPlaybackCapabilities;
};

export type MediaPlaybackSnapshot =
  | {
      status: "idle";
      capabilities: MediaPlaybackCapabilities;
    }
  | {
      status: "loading";
      source: MediaPlaybackSource;
      capabilities: MediaPlaybackCapabilities;
    }
  | (MediaPlaybackTimedSnapshot & {
      status: "ready";
    })
  | (MediaPlaybackTimedSnapshot & {
      status: "playing";
    })
  | (MediaPlaybackTimedSnapshot & {
      status: "seeking";
      targetTimeMs: number;
      seekMode: MediaSeekMode;
    })
  | (MediaPlaybackTimedSnapshot & {
      status: "ended";
    })
  | {
      status: "error";
      source?: MediaPlaybackSource;
      capabilities: MediaPlaybackCapabilities;
      error: MediaPlaybackError;
    };

export type MediaSeekRequest = {
  timeMs: number;
  mode?: MediaSeekMode;
};

export type MediaSeekResult =
  | {
      status: "completed";
      requestedTimeMs: number;
      actualTimeMs: number;
      modeUsed: MediaSeekMode;
    }
  | {
      status: "superseded";
      requestedTimeMs: number;
    };

export type MediaPlaybackAdapterSnapshot = {
  currentTimeMs: number;
  durationMs?: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
};

export type MediaPlaybackAdapterSeekResult = {
  actualTimeMs: number;
  modeUsed: MediaSeekMode;
};

export type MediaPlaybackAdapter = {
  readonly capabilities: MediaPlaybackCapabilities;
  load: (source: MediaPlaybackSource, signal: AbortSignal) => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  seek: (
    request: Required<MediaSeekRequest> & { signal: AbortSignal },
  ) => Promise<MediaPlaybackAdapterSeekResult>;
  setPlaybackRate: (playbackRate: number) => void;
  getSnapshot: () => MediaPlaybackAdapterSnapshot;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};
