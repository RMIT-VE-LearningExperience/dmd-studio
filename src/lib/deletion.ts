import { collection, deleteDoc, doc, getDocs } from "firebase/firestore";
import { ref as storageRef, listAll, deleteObject, type StorageReference } from "firebase/storage";
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

async function deleteStorageTree(ref: StorageReference) {
  const listing = await listAll(ref);
  await Promise.all([
    ...listing.items.map((item) => deleteObject(item).catch(() => {})),
    ...listing.prefixes.map((prefix) => deleteStorageTree(prefix)),
  ]);
}

async function deleteCollection(path: string) {
  const snap = await getDocs(collection(db, path));
  await Promise.all(snap.docs.map((docSnap) => deleteDoc(docSnap.ref)));
}

async function deleteConnections(sessionId: string) {
  const snap = await getDocs(collection(db, "sessions", sessionId, "connections"));
  await Promise.all(
    snap.docs.map(async (connection) => {
      await Promise.all([
        deleteCollection(`sessions/${sessionId}/connections/${connection.id}/offerCandidates`),
        deleteCollection(`sessions/${sessionId}/connections/${connection.id}/answerCandidates`),
      ]);
      await deleteDoc(connection.ref);
    }),
  );
}

// Deletes a project permanently: all Storage objects first, then the session's
// known subcollections, then the session doc itself.
export async function deleteProject(sessionId: string) {
  await deleteStorageTree(storageRef(storage, `recordings/${sessionId}`));
  await Promise.all([
    deleteCollection(`sessions/${sessionId}/participants`),
    deleteConnections(sessionId),
    deleteCollection(`sessions/${sessionId}/scripts`),
    deleteCollection(`sessions/${sessionId}/chat`),
    deleteCollection(`sessions/${sessionId}/episodes`),
    deleteCollection(`sessions/${sessionId}/recordings`),
    deleteCollection(`sessions/${sessionId}/invites`),
  ]);
  await deleteDoc(doc(db, "sessions", sessionId));
}
