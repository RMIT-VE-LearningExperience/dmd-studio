import { collection, deleteDoc, doc, getDocs } from "firebase/firestore";
import { ref as storageRef, listAll, deleteObject } from "firebase/storage";
import { db, storage } from "@/lib/firebase";

// Deletes one take: every chunk file in its Storage folder, then its
// Firestore recording doc.
export async function deleteRecording(sessionId: string, uid: string, take: number) {
  const folder = storageRef(storage, `recordings/${sessionId}/${uid}/take-${take}`);
  const listing = await listAll(folder);
  await Promise.all(listing.items.map((item) => deleteObject(item)));
  await deleteDoc(doc(db, "sessions", sessionId, "recordings", `${uid}_take${take}`));
}

// Deletes a whole project: all recordings (files + docs), the signaling
// subcollections, then the session doc itself. ICE-candidate docs nested
// under connections are left behind — they're a few hundred bytes of
// unreachable garbage, not worth the recursive sweep client-side.
export async function deleteProject(sessionId: string) {
  const recordings = await getDocs(collection(db, "sessions", sessionId, "recordings"));
  for (const snap of recordings.docs) {
    const data = snap.data();
    const uid = (data.uid as string) ?? snap.id.split("_take")[0];
    const take = (data.take as number) ?? Number(snap.id.split("_take")[1] ?? 1);
    await deleteRecording(sessionId, uid, take);
  }

  for (const sub of ["participants", "connections"]) {
    const snap = await getDocs(collection(db, "sessions", sessionId, sub));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  }

  await deleteDoc(doc(db, "sessions", sessionId));
}
