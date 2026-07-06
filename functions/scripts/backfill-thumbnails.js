#!/usr/bin/env node

const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { spawn } = require("node:child_process");
const { unlink } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ID = "dmd-studio";
const BUCKET = "dmd-studio-recordings";
const THUMBNAIL_WIDTH = 360;
const THUMBNAIL_HEIGHT = 640;

initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
  storageBucket: BUCKET,
});

const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);

function runFfmpeg(args, inputStream) {
  const ffmpegPath = require("ffmpeg-static");
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d));
    if (inputStream) {
      ff.stdin.on("error", () => {});
      inputStream.on("error", (err) => {
        ff.kill("SIGKILL");
        reject(err);
      });
      inputStream.pipe(ff.stdin);
    }
    ff.on("error", reject);
    ff.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function writeThumbnail(sourcePath, destinationPath, tmpName) {
  const tmpPath = path.join(os.tmpdir(), tmpName);
  const vf =
    `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT},format=yuvj420p`;
  const attempts = [
    ["-i", "pipe:0", "-ss", "2", "-frames:v", "1", "-vf", vf, "-q:v", "3", tmpPath],
    ["-i", "pipe:0", "-ss", "1", "-frames:v", "1", "-vf", vf, "-q:v", "3", tmpPath],
    ["-i", "pipe:0", "-frames:v", "1", "-vf", vf, "-q:v", "3", tmpPath],
  ];

  try {
    let lastError = null;
    for (const args of attempts) {
      try {
        await runFfmpeg(args, bucket.file(sourcePath).createReadStream());
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

function bytesToMb(bytes) {
  return bytes / 1024 / 1024;
}

async function getPrefixBytes(prefix) {
  const [files] = await bucket.getFiles({ prefix });
  let bytes = 0;
  for (const file of files) {
    const [metadata] = await file.getMetadata();
    bytes += Number(metadata.size ?? 0);
  }
  return { bytes, files: files.length };
}

async function latestSessionSummary() {
  const snap = await db.collection("sessions").orderBy("createdAt", "desc").limit(1).get();
  if (snap.empty) return null;
  const sessionDoc = snap.docs[0];
  const recSnap = await sessionDoc.ref.collection("recordings").get();
  const storage = await getPrefixBytes(`recordings/${sessionDoc.id}/`);
  const recordings = recSnap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      kind: data.kind ?? "camera",
      displayName: data.displayName ?? "Participant",
      totalBytes: Number(data.totalBytes ?? 0),
      composedPath: data.composedPath ?? null,
      audioPath: data.audioPath ?? null,
      sttPath: data.sttPath ?? null,
      transcriptStatus: data.transcriptStatus ?? null,
    };
  });
  return {
    id: sessionDoc.id,
    title: sessionDoc.data().title ?? "Untitled",
    fileCount: storage.files,
    storageBytes: storage.bytes,
    recordings,
  };
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  return 0;
}

async function recordedSessionSummaries() {
  const sessionsSnap = await db.collection("sessions").get();
  const summaries = [];

  for (const sessionDoc of sessionsSnap.docs) {
    const recSnap = await sessionDoc.ref.collection("recordings").get();
    if (recSnap.empty) continue;
    const storage = await getPrefixBytes(`recordings/${sessionDoc.id}/`);
    const recordings = recSnap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        kind: data.kind ?? "camera",
        displayName: data.displayName ?? "Participant",
        totalBytes: Number(data.totalBytes ?? 0),
        composedPath: data.composedPath ?? null,
        audioPath: data.audioPath ?? null,
        sttPath: data.sttPath ?? null,
        transcriptStatus: data.transcriptStatus ?? null,
        completedAtMs: timestampToMillis(data.completedAt),
        startedAtMs: Number(data.startedAtMs ?? 0),
      };
    });
    const latestRecordingAtMs = Math.max(...recordings.map((rec) => rec.completedAtMs || rec.startedAtMs || 0));
    summaries.push({
      id: sessionDoc.id,
      title: sessionDoc.data().title ?? "Untitled",
      fileCount: storage.files,
      storageBytes: storage.bytes,
      latestRecordingAtMs,
      recordings,
    });
  }

  return summaries
    .sort((a, b) => b.latestRecordingAtMs - a.latestRecordingAtMs)
    .slice(0, 3);
}

async function main() {
  const sessionsSnap = await db.collection("sessions").get();
  let checked = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const sessionDoc of sessionsSnap.docs) {
    const recordingsSnap = await sessionDoc.ref.collection("recordings").get();
    for (const recordingDoc of recordingsSnap.docs) {
      checked += 1;
      const rec = recordingDoc.data();
      if (!rec.composedPath || rec.kind === "screen" || rec.audioOnly) {
        skipped += 1;
        continue;
      }

      const prefix = rec.composedPath.slice(0, rec.composedPath.lastIndexOf("/") + 1);
      const thumbnailPath = `${prefix}processed-thumbnail.jpg`;
      try {
        await writeThumbnail(rec.composedPath, thumbnailPath, `${sessionDoc.id}-${recordingDoc.id}-processed-thumb.jpg`);
        await recordingDoc.ref.update({
          thumbnailPath,
          thumbnailSource: "processed",
          thumbnailUpdatedAt: FieldValue.serverTimestamp(),
        });
        updated += 1;
        console.log(`updated ${sessionDoc.id}/${recordingDoc.id} -> ${thumbnailPath}`);
      } catch (err) {
        failed += 1;
        console.error(`failed ${sessionDoc.id}/${recordingDoc.id}: ${err.message ?? err}`);
      }
    }
  }

  console.log(JSON.stringify({ checked, updated, skipped, failed }, null, 2));

  const latest = await latestSessionSummary();
  if (latest) {
    console.log("latestSession", JSON.stringify({
      ...latest,
      storageMb: Number(bytesToMb(latest.storageBytes).toFixed(2)),
      recordings: latest.recordings.map((rec) => ({
        ...rec,
        totalMb: Number(bytesToMb(rec.totalBytes).toFixed(2)),
      })),
    }, null, 2));
  }

  const recorded = await recordedSessionSummaries();
  console.log("latestRecordedSessions", JSON.stringify(recorded.map((session) => ({
    ...session,
    storageMb: Number(bytesToMb(session.storageBytes).toFixed(2)),
    recordings: session.recordings.map((rec) => ({
      ...rec,
      totalMb: Number(bytesToMb(rec.totalBytes).toFixed(2)),
    })),
  })), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
