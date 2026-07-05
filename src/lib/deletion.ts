import { collection, deleteDoc, doc, getDocs } from "firebase/firestore";
import { ref as storageRef, listAll, deleteObject } from "firebase/storage";
import { db, storage } from "@/lib/firebase";

// Deletes one track: every file in its Storage folder, then its Firestore
// recording doc. `folder`/`docId` default to the camera-take conventions for
// docs written before screen recording existed.
export async function deleteRecording(
  sessionId: string,
  uid: string,
  take: number,
  folder?: string | null,
  docId?: string | null,
) {
  const folderRef = storageRef(storage, folder ?? `recordings/${sessionId}/${uid}/take-${take}`);
  const listing = await listAll(folderRef);
  await Promise.all(listing.items.map((item) => deleteObject(item)));
  await deleteDoc(doc(db, "sessions", sessionId, "recordings", docId ?? `${uid}_take${take}`));
}

// Deletes a whole project: all recordings (files + docs), episodes, chat,
// the signaling subcollections (including nested ICE-candidate docs), then
// the session doc itself.
export async function deleteProject(sessionId: string) {
  const recordings = await getDocs(collection(db, "sessions", sessionId, "recordings"));
  for (const snap of recordings.docs) {
    const data = snap.data();
    const uid = (data.uid as string) ?? snap.id.split("_take")[0];
    const take = (data.take as number) ?? Number(snap.id.split("_take")[1] ?? 1);
    await deleteRecording(sessionId, uid, take, (data.folder as string) ?? null, snap.id);
  }

  // Produced episodes live in their own Storage folder, outside any take.
  const episodesFolder = storageRef(storage, `recordings/${sessionId}/episodes`);
  const episodeListing = await listAll(episodesFolder);
  await Promise.all(episodeListing.items.map((item) => deleteObject(item)));

  // ICE candidates nest under each connection doc and must go first —
  // deleting the parent doc alone would strand them forever.
  const connections = await getDocs(collection(db, "sessions", sessionId, "connections"));
  for (const conn of connections.docs) {
    for (const sub of ["offerCandidates", "answerCandidates"]) {
      const candidates = await getDocs(collection(conn.ref, sub));
      await Promise.all(candidates.docs.map((d) => deleteDoc(d.ref)));
    }
  }

  for (const sub of ["participants", "connections", "episodes", "chat", "scripts"]) {
    const snap = await getDocs(collection(db, "sessions", sessionId, sub));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  }

  await deleteDoc(doc(db, "sessions", sessionId));
}
