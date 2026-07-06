"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  Timestamp,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef } from "firebase/storage";
import { auth, db, storage } from "@/lib/firebase";

export type ProjectPreview = {
  id: string;
  displayName: string;
  thumbnailUrl: string;
};

export type Project = {
  id: string;
  title: string;
  createdAt: Timestamp | null;
  scheduledAt: Timestamp | null;
  recordingCount: number;
  previews: ProjectPreview[];
  live: boolean;
};

// Auth + the signed-in host's project list, shared by Home, Calendar and
// Projects pages.
export function useProjects() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthLoading(false);
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "sessions"),
      where("hostUid", "==", user.uid),
      orderBy("createdAt", "desc"),
    );
    return onSnapshot(q, async (snap) => {
      const withCounts: Array<Project | null> = await Promise.all(
        snap.docs.map(async (docSnap) => {
          const data = docSnap.data();
          if (data.archivedAt instanceof Timestamp) return null;
          const recordingsSnap = await getDocs(collection(db, "sessions", docSnap.id, "recordings"));
          const previewCandidates = recordingsSnap.docs
            .map((recordingSnap) => {
              const recording = recordingSnap.data();
              return {
                id: recordingSnap.id,
                displayName: (recording.displayName as string) || "Participant",
                kind: (recording.kind as string) || "camera",
                thumbnailPath: (recording.thumbnailPath as string) || "",
                completedAt: recording.completedAt instanceof Timestamp ? recording.completedAt.toMillis() : 0,
                startedAtMs: (recording.startedAtMs as number) || 0,
              };
            })
            .filter((recording) => recording.kind === "camera" && recording.thumbnailPath)
            .sort((a, b) => (b.completedAt || b.startedAtMs) - (a.completedAt || a.startedAtMs))
            .slice(0, 3);
          const previews = (
            await Promise.all(
              previewCandidates.map(async (recording) => {
                try {
                  return {
                    id: recording.id,
                    displayName: recording.displayName,
                    thumbnailUrl: await getDownloadURL(storageRef(storage, recording.thumbnailPath)),
                  };
                } catch {
                  return null;
                }
              }),
            )
          ).filter((preview): preview is ProjectPreview => preview !== null);
          return {
            id: docSnap.id,
            title: (data.title as string) || "Untitled",
            createdAt: (data.createdAt as Timestamp) ?? null,
            scheduledAt: (data.scheduledAt as Timestamp) ?? null,
            recordingCount: recordingsSnap.docs.length,
            previews,
            // The heartbeat refreshes lastLiveAt every minute while the host
            // is in the studio — a stale timestamp means the tab died
            // without a clean Leave, so don't show a stuck LIVE badge.
            live:
              data.status === "live" &&
              data.lastLiveAt instanceof Timestamp &&
              Date.now() - data.lastLiveAt.toMillis() < 3 * 60_000,
          };
        }),
      );
      setProjects(withCounts.filter((project): project is Project => project !== null));
    });
  }, [user]);

  return { user, authLoading, projects };
}

export async function createProject(user: User, title = "Untitled", scheduledAt?: Date) {
  const ref = await addDoc(collection(db, "sessions"), {
    hostUid: user.uid,
    title,
    createdAt: serverTimestamp(),
    ...(scheduledAt ? { scheduledAt: Timestamp.fromDate(scheduledAt) } : {}),
    status: "created",
  });
  return ref.id;
}
