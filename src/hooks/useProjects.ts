"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  addDoc,
  collection,
  getCountFromServer,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  Timestamp,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type Project = {
  id: string;
  title: string;
  createdAt: Timestamp | null;
  scheduledAt: Timestamp | null;
  recordingCount: number;
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
      const withCounts = await Promise.all(
        snap.docs.map(async (docSnap) => {
          const data = docSnap.data();
          const countSnap = await getCountFromServer(
            collection(db, "sessions", docSnap.id, "recordings"),
          );
          return {
            id: docSnap.id,
            title: (data.title as string) || "Untitled",
            createdAt: (data.createdAt as Timestamp) ?? null,
            scheduledAt: (data.scheduledAt as Timestamp) ?? null,
            recordingCount: countSnap.data().count,
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
      setProjects(withCounts);
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
