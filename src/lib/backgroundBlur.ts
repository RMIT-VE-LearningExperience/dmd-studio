"use client";

import type { ImageSegmenter } from "@mediapipe/tasks-vision";

// Person-segmented background blur. The camera frame is segmented every
// frame (MediaPipe selfie model, self-hosted under /public/mediapipe), the
// background drawn blurred, the person composited back sharp, and the
// resulting canvas captured as a real MediaStream — so the blur is what
// peers receive AND what gets recorded, not a cosmetic CSS filter.
//
// Compositing 4K at 30fps isn't feasible in a browser tab, so processed
// output is capped at 720p — the UI says so where blur is offered.

const MAX_OUT_WIDTH = 1280;
const OUT_FPS = 30;
const BLUR_PX = 16;

export type BlurPipeline = {
  // Processed video + the source's (untouched) audio tracks.
  stream: MediaStream;
  // Stop processing but leave the source camera running — used when blur is
  // toggled off in the lobby and the raw stream takes over again.
  disposeKeepSource: () => void;
};

// One segmenter for the app's lifetime — model + wasm load once, and VIDEO
// mode requires monotonically increasing timestamps on a single instance.
let segmenterPromise: Promise<ImageSegmenter> | null = null;

async function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const options = {
        runningMode: "VIDEO" as const,
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      };
      try {
        return await ImageSegmenter.createFromOptions(fileset, {
          ...options,
          baseOptions: { modelAssetPath: "/mediapipe/selfie_segmenter.tflite", delegate: "GPU" },
        });
      } catch {
        // No usable WebGL — the CPU delegate is slower but works everywhere.
        return await ImageSegmenter.createFromOptions(fileset, {
          ...options,
          baseOptions: { modelAssetPath: "/mediapipe/selfie_segmenter.tflite", delegate: "CPU" },
        });
      }
    })().catch((err) => {
      segmenterPromise = null; // allow a retry on the next attempt
      throw err;
    });
  }
  return segmenterPromise;
}

export async function createBlurredStream(source: MediaStream): Promise<BlurPipeline> {
  const sourceTrack = source.getVideoTracks()[0];
  if (!sourceTrack) throw new Error("No camera track to blur.");

  const segmenter = await getSegmenter();

  const settings = sourceTrack.getSettings();
  const srcW = settings.width ?? 1280;
  const srcH = settings.height ?? 720;
  const scale = Math.min(1, MAX_OUT_WIDTH / srcW);
  // Even dimensions keep downstream encoders happy.
  const outW = Math.round((srcW * scale) / 2) * 2;
  const outH = Math.round((srcH * scale) / 2) * 2;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([sourceTrack]);
  await video.play();

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext("2d")!;

  const person = document.createElement("canvas");
  person.width = outW;
  person.height = outH;
  const personCtx = person.getContext("2d")!;

  // The confidence mask lands here at model resolution; canvas scaling then
  // smooths it up to output size for free.
  const mask = document.createElement("canvas");
  const maskCtx = mask.getContext("2d")!;
  let maskImage: ImageData | null = null;

  let stopped = false;
  let rafId = 0;

  const renderFrame = () => {
    if (stopped) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const result = segmenter.segmentForVideo(video, performance.now());
      const confidence = result.confidenceMasks?.[0];
      if (confidence) {
        const mw = confidence.width;
        const mh = confidence.height;
        if (mask.width !== mw || mask.height !== mh || !maskImage) {
          mask.width = mw;
          mask.height = mh;
          maskImage = maskCtx.createImageData(mw, mh);
        }
        const values = confidence.getAsFloat32Array();
        const pixels = maskImage.data;
        for (let i = 0; i < values.length; i++) {
          pixels[i * 4 + 3] = values[i] * 255;
        }
        maskCtx.putImageData(maskImage, 0, 0);
        confidence.close();

        // Person cutout: sharp frame masked by segmentation alpha.
        personCtx.globalCompositeOperation = "source-over";
        personCtx.drawImage(video, 0, 0, outW, outH);
        personCtx.globalCompositeOperation = "destination-in";
        personCtx.drawImage(mask, 0, 0, outW, outH);

        // Blurred background, drawn slightly oversized to hide edge halos,
        // then the person on top.
        outCtx.filter = `blur(${BLUR_PX}px)`;
        const grow = 1.06;
        outCtx.drawImage(
          video,
          (outW - outW * grow) / 2,
          (outH - outH * grow) / 2,
          outW * grow,
          outH * grow,
        );
        outCtx.filter = "none";
        outCtx.drawImage(person, 0, 0);
      }
      result.close?.();
    }
    rafId = requestAnimationFrame(renderFrame);
  };
  rafId = requestAnimationFrame(renderFrame);

  const captured = out.captureStream(OUT_FPS);
  const processedTrack = captured.getVideoTracks()[0];

  const stopProcessing = () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    video.srcObject = null;
  };

  // The room tears a call down by stopping the tracks of the stream it was
  // handed — patch the processed track so that also shuts the pipeline and
  // the real camera down (otherwise the camera light stays on forever).
  const originalStop = processedTrack.stop.bind(processedTrack);
  processedTrack.stop = () => {
    stopProcessing();
    source.getTracks().forEach((t) => t.stop());
    originalStop();
  };

  // Camera unplugged / permission revoked — fold the pipeline with it.
  sourceTrack.addEventListener("ended", () => {
    stopProcessing();
    originalStop();
  });

  return {
    stream: new MediaStream([processedTrack, ...source.getAudioTracks()]),
    disposeKeepSource: () => {
      stopProcessing();
      originalStop();
    },
  };
}
