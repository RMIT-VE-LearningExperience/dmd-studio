// Session-level settings the host controls. Capture fields apply when a
// participant acquires their devices in the lobby; autoAdmit is enforced by
// the join flow and security rules.
export type CaptureSettings = {
  // Height cap for the camera (2160 = source/4K, 1080, 720). Absent = source.
  maxHeight?: number | null;
  audioOnly?: boolean;
  autoAdmit?: boolean;
};

// PAL region: ask cameras for 25fps so the conformed 25fps exports keep
// (nearly) every captured frame instead of dropping one in six from 30.
export const TARGET_FPS = 25;

// `ideal` constraints never throw — the browser just returns the closest
// resolution the camera actually supports, so asking for 4K here safely
// degrades to whatever the device can do (720p webcam, etc).
export async function getBestUserMedia(
  videoDeviceId?: string,
  audioDeviceId?: string,
  settings?: CaptureSettings,
): Promise<MediaStream> {
  const audio = {
    ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 2,
  };

  try {
    if (settings?.audioOnly) {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    // 1080p default: high quality without 4K's upload/storage weight — the
    // host/producer can raise it to 4K (or drop to 720p) per session.
    const maxHeight = settings?.maxHeight ?? 1080;
    return await navigator.mediaDevices.getUserMedia({
      video: {
        ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
        width: { ideal: Math.round((maxHeight * 16) / 9) },
        height: { ideal: maxHeight },
        // Without this, some cameras/drivers report a swapped portrait mode
        // (e.g. 1080x1920) as the "closest" match to the width/height ideals
        // above — forcing 16:9 keeps the picked mode landscape.
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: TARGET_FPS },
      },
      audio,
    });
  } catch (err) {
    // Permission errors must surface to the user; only constraint problems
    // (an `exact` deviceId that vanished, a rejected constraint combo) should
    // fall back to unconstrained access.
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      throw err;
    }
    return navigator.mediaDevices.getUserMedia({
      video: !settings?.audioOnly,
      audio: true,
    });
  }
}

export type MediaDeviceChoice = {
  deviceId: string;
  label: string;
};

export type MediaDeviceLists = {
  cameras: MediaDeviceChoice[];
  microphones: MediaDeviceChoice[];
  speakers: MediaDeviceChoice[];
};

// Only meaningful after getUserMedia has been granted once — before that,
// browsers return devices with empty labels.
export async function listMediaDevices(): Promise<MediaDeviceLists> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const toChoice = (d: MediaDeviceInfo, fallback: string): MediaDeviceChoice => ({
    deviceId: d.deviceId,
    label: d.label || fallback,
  });
  return {
    cameras: devices.filter((d) => d.kind === "videoinput").map((d, i) => toChoice(d, `Camera ${i + 1}`)),
    microphones: devices.filter((d) => d.kind === "audioinput").map((d, i) => toChoice(d, `Microphone ${i + 1}`)),
    speakers: devices.filter((d) => d.kind === "audiooutput").map((d, i) => toChoice(d, `Speaker ${i + 1}`)),
  };
}

export function friendlyMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera and microphone access was blocked. Click the camera icon in your browser's address bar to allow access, then try again.";
      case "NotFoundError":
        return "No camera or microphone was found. Plug one in (or enable it) and try again.";
      case "NotReadableError":
        return "Your camera or microphone is already in use by another app. Close it (Zoom, Teams, etc.) and try again.";
      case "OverconstrainedError":
        return "The selected camera or microphone is no longer available. Pick a different device.";
    }
  }
  return err instanceof Error ? err.message : "Could not access your camera or microphone.";
}

function resolutionTierLabel(width: number, height: number): string | null {
  const pixels = width * height;
  if (pixels >= 3840 * 2160 * 0.9) return "4K";
  if (pixels >= 2560 * 1440 * 0.9) return "1440p";
  if (pixels >= 1920 * 1080 * 0.9) return "1080p";
  if (pixels >= 1280 * 720 * 0.9) return "720p";
  return null;
}

export function getVideoResolutionLabel(stream: MediaStream): string {
  const track = stream.getVideoTracks()[0];
  if (!track) return "No camera";
  const { width, height, frameRate } = track.getSettings();
  if (!width || !height) return "Unknown resolution";
  const tier = resolutionTierLabel(width, height);
  const fps = frameRate ? ` · ${Math.round(frameRate)}fps` : "";
  return `${width}×${height}${tier ? ` (${tier})` : ""}${fps}`;
}

export type RecorderOptions = {
  mimeType: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond: number;
  extension: string;
};

const AUDIO_MIME_CANDIDATES = [
  { mimeType: "audio/mp4", extension: "m4a" }, // Safari
  { mimeType: "audio/webm;codecs=opus", extension: "webm" },
  { mimeType: "audio/webm", extension: "webm" },
];

// For audio-only sessions: no video track, so no video bitrate to pick.
export function pickAudioRecorderOptions(): RecorderOptions {
  const match =
    AUDIO_MIME_CANDIDATES.find(
      (c) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType),
    ) ?? { mimeType: "audio/webm", extension: "webm" };
  return { ...match, audioBitsPerSecond: 192_000 };
}

const MIME_CANDIDATES = [
  { mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

// Scales the encode bitrate ceiling with resolution so 4K actually gets
// recorded at meaningfully higher quality than a 720p webcam, rather than
// MediaRecorder's low default bitrate flattening everything to mush.
export function pickRecorderOptions(videoWidth: number, videoHeight: number): RecorderOptions {
  const match =
    MIME_CANDIDATES.find(
      (c) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType),
    ) ?? { mimeType: "video/webm", extension: "webm" };

  const pixels = videoWidth * videoHeight;
  const videoBitsPerSecond =
    pixels >= 3840 * 2160 * 0.9
      ? 40_000_000
      : pixels >= 2560 * 1440 * 0.9
        ? 16_000_000
        : pixels >= 1920 * 1080 * 0.9
          ? 8_000_000
          : pixels >= 1280 * 720 * 0.9
            ? 5_000_000
            : 2_500_000;

  return { ...match, videoBitsPerSecond, audioBitsPerSecond: 192_000 };
}

// Mixes several audio tracks (the teacher's mic + the shared tab's audio)
// into one track, so a tutorial's screen recording carries the voice
// instead of leaving editors to sync two files. A disabled (muted) source
// simply contributes silence.
export function mixAudioTracks(tracks: MediaStreamTrack[]): {
  track: MediaStreamTrack;
  close: () => void;
} {
  const ctx = new AudioContext();
  const destination = ctx.createMediaStreamDestination();
  const sources = tracks
    .filter((t) => t.kind === "audio" && t.readyState === "live")
    .map((t) => {
      const source = ctx.createMediaStreamSource(new MediaStream([t]));
      source.connect(destination);
      return source;
    });
  void ctx.resume().catch(() => {});
  return {
    track: destination.stream.getAudioTracks()[0],
    close: () => {
      sources.forEach((s) => s.disconnect());
      void ctx.close().catch(() => {});
    },
  };
}
