const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { spawn } = require("node:child_process");
const { unlink } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

initializeApp();

const BUCKET = "dmd-studio-recordings";
// GCS compose accepts at most 32 source objects per call; longer recordings
// are composed in batches, then the batches composed again.
const COMPOSE_LIMIT = 32;

// MediaRecorder chunks are byte-slices of one continuous file, so composing
// them in order (a server-side metadata operation — no data is downloaded)
// reproduces the original recording exactly. The browser then streams the
// single composed file instead of stitching dozens of chunks client-side,
// which was slow and hit storage/retry-limit-exceeded on big takes.
exports.composeRecording = onDocumentWritten(
  {
    document: "sessions/{sessionId}/recordings/{recId}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const snap = event.data?.after;
    if (!snap || !snap.exists) return;
    const data = snap.data();
    if (data.composedPath) return;
    // Docs now exist from the moment a take starts (uploadState "recording"
    // → "uploading" → "complete"); only compose once the uploader — or the
    // host finalizing a dead participant's track — says it's complete.
    // Docs from older clients have no uploadState and arrive complete.
    if ((data.uploadState ?? "complete") !== "complete") return;

    const { sessionId, recId } = event.params;
    const uid = data.uid ?? recId.split("_take")[0];
    const take = data.take ?? Number(recId.split("_take")[1] ?? 1);
    const extension = data.extension ?? "webm";

    const bucket = getStorage().bucket(BUCKET);
    // Screen tracks (and any future variants) carry their own folder.
    const prefix = data.folder ? `${data.folder}/` : `recordings/${sessionId}/${uid}/take-${take}/`;
    const [files] = await bucket.getFiles({ prefix });
    const parts = files
      .filter((f) => f.name.split("/").pop().startsWith("part-"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (parts.length === 0) {
      console.log(`No parts found for ${prefix}, skipping compose.`);
      return;
    }

    const finalName = `${prefix}full.${extension}`;
    let sources = parts;
    let level = 0;
    while (sources.length > COMPOSE_LIMIT) {
      const next = [];
      for (let i = 0; i < sources.length; i += COMPOSE_LIMIT) {
        const batch = sources.slice(i, i + COMPOSE_LIMIT);
        const tmpName = `${prefix}tmp-compose-${level}-${i / COMPOSE_LIMIT}`;
        await bucket.combine(batch, tmpName);
        next.push(bucket.file(tmpName));
      }
      sources = next;
      level += 1;
    }
    await bucket.combine(sources, finalName);
    await bucket.file(finalName).setMetadata({ contentType: data.mimeType || "video/webm" });

    // The composed file supersedes the parts and intermediates — delete them
    // so each take is stored once, not twice.
    const [remaining] = await bucket.getFiles({ prefix });
    await Promise.all(
      remaining
        .filter((f) => {
          const name = f.name.split("/").pop();
          return name.startsWith("part-") || name.startsWith("tmp-compose-");
        })
        .map((f) => f.delete().catch(() => {})),
    );

    await getFirestore()
      .doc(`sessions/${sessionId}/recordings/${recId}`)
      .update({ composedPath: finalName });
    console.log(`Composed ${parts.length} parts into ${finalName}`);
  },
);

// Runs ffmpeg over the composed take, streaming the input straight from GCS
// (MediaRecorder output — WebM or fragmented MP4 — is pipe-friendly, and not
// buffering the input keeps memory needs at "size of the WAV", not "size of
// the video"). Produces two artifacts in one pass:
//   audio.wav  — 48 kHz stereo PCM, the per-track audio podcasters download
//   stt.flac   — 16 kHz mono, the compact input Speech-to-Text wants
function runFfmpegArgs(args, inputStream) {
  const ffmpegPath = require("ffmpeg-static");
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d));
    if (inputStream) {
      // ffmpeg may close stdin once it has what it needs — EPIPE here is normal.
      ff.stdin.on("error", () => {});
      inputStream.on("error", (err) => {
        ff.kill("SIGKILL");
        reject(err);
      });
      inputStream.pipe(ff.stdin);
    }
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

function runFfmpeg(inputStream, wavPath, flacPath) {
  return runFfmpegArgs(
    [
      "-i", "pipe:0",
      "-vn", "-acodec", "pcm_s16le", "-ar", "48000", wavPath,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", flacPath,
    ],
    inputStream,
  );
}

async function writeProcessedThumbnail(bucket, sourcePath, destinationPath, tmpName) {
  const tmpPath = path.join(os.tmpdir(), tmpName);
  const vf = "scale=360:640:force_original_aspect_ratio=increase,crop=360:640,format=yuvj420p";
  const attempts = [
    ["-i", "pipe:0", "-ss", "2", "-frames:v", "1", "-vf", vf, "-q:v", "3", tmpPath],
    ["-i", "pipe:0", "-ss", "1", "-frames:v", "1", "-vf", vf, "-q:v", "3", tmpPath],
    ["-i", "pipe:0", "-frames:v", "1", "-vf", vf, "-q:v", "3", tmpPath],
  ];

  try {
    let lastError = null;
    for (const args of attempts) {
      try {
        await runFfmpegArgs(args, bucket.file(sourcePath).createReadStream());
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;

    await bucket.upload(tmpPath, {
      destination: destinationPath,
      metadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=300",
      },
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

exports.extractThumbnail = onDocumentUpdated(
  {
    document: "sessions/{sessionId}/recordings/{recId}",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after?.composedPath) return;
    if (after.kind === "screen" || after.audioOnly) return;
    if (after.thumbnailSource === "processed") return;

    const { sessionId, recId } = event.params;
    const bucket = getStorage().bucket(BUCKET);
    const prefix = after.composedPath.slice(0, after.composedPath.lastIndexOf("/") + 1);
    const thumbnailPath = `${prefix}processed-thumbnail.jpg`;

    try {
      await writeProcessedThumbnail(bucket, after.composedPath, thumbnailPath, `${sessionId}-${recId}-thumb.jpg`);
      await getFirestore().doc(`sessions/${sessionId}/recordings/${recId}`).update({
        thumbnailPath,
        thumbnailSource: "processed",
        thumbnailUpdatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`Extracted processed thumbnail for ${sessionId}/${recId}: ${thumbnailPath}`);
    } catch (err) {
      console.error(`Thumbnail extraction failed for ${sessionId}/${recId}:`, err);
      await getFirestore().doc(`sessions/${sessionId}/recordings/${recId}`).update({
        thumbnailError: String(err.message ?? err),
      });
    }
  },
);

function ffprobeDuration(filePath) {
  const ffprobePath = require("ffprobe-static").path;
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const dur = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(dur)) resolve(dur);
      else reject(new Error(`ffprobe failed (${code}): ${err.slice(-300)}`));
    });
  });
}

exports.extractAudio = onDocumentUpdated(
  {
    document: "sessions/{sessionId}/recordings/{recId}",
    region: "us-central1",
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;
    // Fires on every recording-doc update — only act on the one transition
    // that matters: compose finished, audio not yet extracted.
    if (!after.composedPath || after.audioPath) return;
    // Screen recordings are video-only: nothing to extract or transcribe.
    if (after.kind === "screen") return;

    const { sessionId, recId } = event.params;
    const bucket = getStorage().bucket(BUCKET);
    const prefix = after.composedPath.slice(0, after.composedPath.lastIndexOf("/") + 1);
    const wavName = `${prefix}audio.wav`;
    const flacName = `${prefix}stt.flac`;

    const wavTmp = path.join(os.tmpdir(), `${recId}-audio.wav`);
    const flacTmp = path.join(os.tmpdir(), `${recId}-stt.flac`);

    try {
      await runFfmpeg(bucket.file(after.composedPath).createReadStream(), wavTmp, flacTmp);
      await bucket.upload(wavTmp, { destination: wavName, metadata: { contentType: "audio/wav" } });
      await bucket.upload(flacTmp, { destination: flacName, metadata: { contentType: "audio/flac" } });
      await getFirestore().doc(`sessions/${sessionId}/recordings/${recId}`).update({
        audioPath: wavName,
        sttPath: flacName,
        transcriptStatus: "pending",
      });
      console.log(`Extracted audio for ${recId}: ${wavName}`);
    } catch (err) {
      console.error(`Audio extraction failed for ${recId}:`, err);
      await getFirestore().doc(`sessions/${sessionId}/recordings/${recId}`).update({
        // Mark audioPath so this doesn't retrigger forever; surface the failure.
        audioPath: null,
        transcriptStatus: "error",
        transcriptError: "Audio extraction failed",
      });
    } finally {
      await Promise.all([unlink(wavTmp).catch(() => {}), unlink(flacTmp).catch(() => {})]);
    }
  },
);

// Firestore docs cap at 1 MiB — a transcript would need ~20 h of speech to
// get near that, but truncate defensively rather than fail the write.
const TRANSCRIPT_CHAR_LIMIT = 800_000;

exports.transcribeRecording = onDocumentUpdated(
  {
    document: "sessions/{sessionId}/recordings/{recId}",
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return;
    // Only the pending transition (written by extractAudio) starts a job.
    if (after.transcriptStatus !== "pending" || before?.transcriptStatus === "pending") return;
    if (!after.sttPath) return;

    const { sessionId, recId } = event.params;
    const docRef = getFirestore().doc(`sessions/${sessionId}/recordings/${recId}`);

    try {
      const { SpeechClient } = require("@google-cloud/speech").v2;
      const client = new SpeechClient();
      const projectId = process.env.GCLOUD_PROJECT;
      const uri = `gs://${BUCKET}/${after.sttPath}`;

      const [operation] = await client.batchRecognize({
        recognizer: `projects/${projectId}/locations/global/recognizers/_`,
        config: {
          autoDecodingConfig: {},
          languageCodes: ["en-AU"],
          model: "long",
          features: { enableAutomaticPunctuation: true },
        },
        files: [{ uri }],
        recognitionOutputConfig: { inlineResponseConfig: {} },
      });
      const [response] = await operation.promise();

      const fileResult = response.results?.[uri];
      if (fileResult?.error?.message) throw new Error(fileResult.error.message);
      let transcript = (fileResult?.transcript?.results ?? [])
        .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
      if (transcript.length > TRANSCRIPT_CHAR_LIMIT) {
        transcript = `${transcript.slice(0, TRANSCRIPT_CHAR_LIMIT)}\n… [truncated]`;
      }

      await docRef.update({ transcript, transcriptStatus: "done" });
      console.log(`Transcribed ${recId}: ${transcript.length} chars`);
    } catch (err) {
      console.error(`Transcription failed for ${recId}:`, err);
      await docRef.update({
        transcriptStatus: "error",
        transcriptError: err.message ?? "Transcription failed",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Produced episode: combine every participant's track for one take into a
// single side-by-side MP4 with mixed audio, aligned by each recorder's
// wall-clock start time. Host-triggered via an `episodes/take-{n}` doc.
// ---------------------------------------------------------------------------

const CANVAS_W = 1280;
const CANVAS_H = 720;
const TILE_W = 632;
const TILE_H = 356;

// Even pixel coordinates on a 1280x720 canvas (yuv420p needs even offsets).
function tileLayout(n) {
  const xL = 4;
  const xR = 644;
  const yT = 2;
  const yB = 362;
  switch (n) {
    case 1:
      return [{ x: 0, y: 0 }];
    case 2:
      return [{ x: xL, y: 182 }, { x: xR, y: 182 }];
    case 3:
      return [{ x: xL, y: yT }, { x: xR, y: yT }, { x: 324, y: yB }];
    default:
      return [{ x: xL, y: yT }, { x: xR, y: yT }, { x: xL, y: yB }, { x: xR, y: yB }];
  }
}

exports.produceEpisode = onDocumentCreated(
  {
    document: "sessions/{sessionId}/episodes/{episodeId}",
    region: "us-central1",
    memory: "4GiB",
    cpu: 4,
    concurrency: 1,
    timeoutSeconds: 540,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    if (data.status !== "pending") return;

    const { sessionId, episodeId } = event.params;
    const take = data.take;
    const docRef = snap.ref;
    const bucket = getStorage().bucket(BUCKET);
    const tmpFiles = [];

    try {
      await docRef.update({ status: "processing" });

      const recsSnap = await getFirestore().collection(`sessions/${sessionId}/recordings`).get();
      const tracks = recsSnap.docs
        .map((d) => d.data())
        .filter((r) => r.take === take && r.composedPath);
      if (tracks.length === 0) throw new Error("No composed tracks found for this take");
      if (tracks.length > 4) throw new Error("Episodes support at most 4 tracks");

      // Host first, then guests alphabetically, screen tracks last —
      // stable tile order.
      const sortKey = (t) =>
        `${t.kind === "screen" ? "1" : "0"}_${t.role === "host" ? "0" : "1"}_${t.displayName || ""}`;
      tracks.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

      // Align tracks on the earliest recorder start; tracks without a
      // startedAtMs (pre-sync recordings) start at zero.
      const starts = tracks.map((t) => t.startedAtMs ?? null);
      const t0 = Math.min(...starts.filter((s) => s !== null).concat([Infinity]));
      const offsets = starts.map((s) => (s === null || t0 === Infinity ? 0 : (s - t0) / 1000));

      const n = tracks.length;
      const tw = n === 1 ? CANVAS_W : TILE_W;
      const th = n === 1 ? CANVAS_H : TILE_H;

      // Pass 1 — normalize each track into an aligned tile: fixed size/fps,
      // black lead-in + silence covering its start offset. Input streams
      // straight from GCS so memory stays at "tiles + episode", not "videos".
      const tilePaths = [];
      for (let i = 0; i < n; i++) {
        const tilePath = path.join(os.tmpdir(), `${episodeId}-tile-${i}.mp4`);
        tmpFiles.push(tilePath);
        tilePaths.push(tilePath);
        const off = offsets[i];
        const af = (off > 0 ? `adelay=${Math.round(off * 1000)}:all=1,` : "") + "aresample=48000";
        const encodeArgs = [
          "-c:v", "libx264", "-preset", "superfast", "-crf", "21",
          "-c:a", "aac", "-b:a", "192k",
          tilePath,
        ];

        let args;
        if (tracks[i].audioOnly) {
          // Audio-only takes get a plain dark tile as their video.
          args = [
            "-f", "lavfi", "-i", `color=c=0x27272a:s=${tw}x${th}:r=30`,
            "-i", "pipe:0",
            "-shortest",
            "-map", "0:v", "-map", "1:a",
            "-af", af,
            "-vf", "format=yuv420p",
            ...encodeArgs,
          ];
        } else {
          const vf =
            `fps=30,scale=${tw}:${th}:force_original_aspect_ratio=decrease,` +
            `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p` +
            (off > 0 ? `,tpad=start_duration=${off.toFixed(3)}:start_mode=add:color=black` : "");
          // Screen tracks are video-only — give them silent audio so the
          // final amix sees a uniform set of inputs.
          const audioArgs =
            tracks[i].kind === "screen"
              ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-map", "0:v", "-map", "1:a"]
              : ["-af", af];
          args = ["-i", "pipe:0", ...audioArgs, "-vf", vf, ...encodeArgs];
        }

        await runFfmpegArgs(args, bucket.file(tracks[i].composedPath).createReadStream());
      }

      const durations = await Promise.all(tilePaths.map(ffprobeDuration));
      const total = Math.max(...durations);

      const outPath = path.join(os.tmpdir(), `${episodeId}-episode.mp4`);
      tmpFiles.push(outPath);

      if (n === 1) {
        // A single tile already is the episode — just add faststart.
        await runFfmpegArgs(["-i", tilePaths[0], "-c", "copy", "-movflags", "+faststart", outPath]);
      } else {
        // Pass 2 — overlay the tiles onto a black canvas and mix audio.
        const layout = tileLayout(n);
        let filter = `color=black:s=${CANVAS_W}x${CANVAS_H}:d=${total.toFixed(3)}[base]`;
        let prev = "base";
        for (let i = 0; i < n; i++) {
          const out = i === n - 1 ? "vout" : `v${i}`;
          filter += `;[${prev}][${i}:v]overlay=${layout[i].x}:${layout[i].y}[${out}]`;
          prev = out;
        }
        filter += `;${tilePaths.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${n}:duration=longest:normalize=0[aout]`;

        await runFfmpegArgs([
          ...tilePaths.flatMap((p) => ["-i", p]),
          "-filter_complex", filter,
          "-map", "[vout]", "-map", "[aout]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          outPath,
        ]);
      }

      const destination = `recordings/${sessionId}/episodes/${episodeId}.mp4`;
      await bucket.upload(outPath, { destination, metadata: { contentType: "video/mp4" } });

      await docRef.update({
        status: "done",
        path: destination,
        durationSec: Math.round(total),
        trackCount: n,
      });
      console.log(`Produced episode ${episodeId} for ${sessionId}: ${n} tracks, ${total.toFixed(1)}s`);
    } catch (err) {
      console.error(`Episode production failed for ${sessionId}/${episodeId}:`, err);
      await docRef.update({ status: "error", error: String(err.message ?? err) });
    } finally {
      await Promise.all(tmpFiles.map((f) => unlink(f).catch(() => {})));
    }
  },
);
