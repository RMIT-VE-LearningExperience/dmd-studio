const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { getFirestore } = require("firebase-admin/firestore");

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
exports.composeRecording = onDocumentCreated(
  {
    document: "sessions/{sessionId}/recordings/{recId}",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    if (data.composedPath) return;

    const { sessionId, recId } = event.params;
    const uid = data.uid ?? recId.split("_take")[0];
    const take = data.take ?? Number(recId.split("_take")[1] ?? 1);
    const extension = data.extension ?? "webm";

    const bucket = getStorage().bucket(BUCKET);
    const prefix = `recordings/${sessionId}/${uid}/take-${take}/`;
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
