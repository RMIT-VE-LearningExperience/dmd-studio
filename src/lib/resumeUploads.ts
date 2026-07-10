import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { ref as storageRef, uploadBytes, listAll, getMetadata } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import {
  getPendingTakeMetas,
  getPendingChunks,
  deleteChunk,
  deleteTakeMeta,
} from "@/lib/recordingDb";

// Prevents two overlapping resume runs for the same participant (e.g. rapid
// page navigations remounting the banner) from double-uploading chunks.
const inFlight = new Map<string, Promise<number>>();

// Finishes uploads that a previous visit left behind: pushes any chunks
// still sitting in IndexedDB, then reconstructs the completion doc from
// what's actually in Storage (chunk counts/sizes from the earlier visit
// were lost with the page).
export function resumePendingUploads(
  sessionId: string,
  uid: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const key = `${sessionId}:${uid}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = doResume(sessionId, uid, onProgress).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function doResume(
  sessionId: string,
  uid: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const metas = await getPendingTakeMetas(sessionId, uid);
  if (metas.length === 0) return 0;

  const pendingByTake = await Promise.all(metas.map((meta) => getPendingChunks(meta.recId)));
  const totalChunks = pendingByTake.reduce((sum, chunks) => sum + chunks.length, 0);
  let done = 0;
  let resumedTakes = 0;

  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    const folderPath = meta.folder ?? `recordings/${sessionId}/${uid}/take-${meta.take}`;

    for (const { index, blob } of pendingByTake[i]) {
      const path = `${folderPath}/part-${String(index).padStart(5, "0")}.${meta.extension}`;
      await uploadBytes(storageRef(storage, path), blob);
      await deleteChunk(meta.recId, index);
      done += 1;
      onProgress?.(done, totalChunks);
    }

    const folder = storageRef(storage, folderPath);
    const listing = await listAll(folder);
    // The folder also holds thumbnail.jpg — only part-* files are chunks,
    // and a folder with just a thumbnail is still an empty take.
    const parts = listing.items.filter((item) => item.name.startsWith("part-"));

    if (parts.length === 0) {
      // The take died before a single chunk made it anywhere — nothing to
      // publish, just clear the leftover marker.
      await deleteTakeMeta(meta.recId);
      continue;
    }

    const sizes = await Promise.all(parts.map((item) => getMetadata(item).then((m) => m.size)));

    await setDoc(doc(db, "sessions", sessionId, "recordings", meta.docId ?? `${uid}_take${meta.take}`), {
      uid,
      take: meta.take,
      displayName: meta.displayName,
      role: meta.role,
      kind: meta.kind ?? "camera",
      folder: folderPath,
      audioOnly: meta.audioOnly ?? false,
      chunkCount: parts.length,
      totalBytes: sizes.reduce((a, b) => a + b, 0),
      mimeType: meta.mimeType,
      extension: meta.extension,
      startedAtMs: meta.startedAtMs,
      // The precise stop time died with the previous tab — chunks are cut
      // every 5s, so chunk count gives a close-enough duration.
      durationMs: parts.length * 5000,
      uploadState: "complete",
      completedAt: serverTimestamp(),
    });

    await deleteTakeMeta(meta.recId);
    resumedTakes += 1;
  }

  if (resumedTakes > 0) {
    // The participant doc may still say "recording"/"finishing" from the
    // visit that died — let the host see the take actually made it.
    await setDoc(
      doc(db, "sessions", sessionId, "participants", uid),
      {
        upload: {
          state: "uploaded",
          take: metas[metas.length - 1].take,
          updatedAt: serverTimestamp(),
        },
      },
      { merge: true },
    ).catch(() => {});
  }

  return resumedTakes;
}

export async function hasPendingUploads(sessionId: string, uid: string): Promise<boolean> {
  const metas = await getPendingTakeMetas(sessionId, uid);
  return metas.length > 0;
}
