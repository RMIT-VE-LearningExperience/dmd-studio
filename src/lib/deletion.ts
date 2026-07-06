import { deleteDoc, doc, Timestamp, updateDoc } from "firebase/firestore";
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

// Deleting a project from the dashboard is a soft delete: hide it immediately
// and retain its data for 30 days so it can be recovered manually if needed.
export async function deleteProject(sessionId: string) {
  const archivedAt = new Date();
  const archivedUntil = new Date(archivedAt);
  archivedUntil.setDate(archivedUntil.getDate() + 30);

  await updateDoc(doc(db, "sessions", sessionId), {
    archivedAt: Timestamp.fromDate(archivedAt),
    archivedUntil: Timestamp.fromDate(archivedUntil),
    deleteAfter: Timestamp.fromDate(archivedUntil),
    status: "archived",
  });
}
