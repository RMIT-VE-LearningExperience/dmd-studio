"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { signInHost } from "@/lib/auth";

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [hostLink, setHostLink] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  const createSession = async () => {
    if (!user) return;
    setCreating(true);
    const sessionRef = await addDoc(collection(db, "sessions"), {
      hostUid: user.uid,
      createdAt: serverTimestamp(),
      status: "created",
    });
    const origin = window.location.origin;
    setHostLink(`${origin}/session/${sessionRef.id}`);
    setInviteLink(`${origin}/session/${sessionRef.id}?role=guest`);
    setCreating(false);
  };

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-10">
      <h1 className="text-2xl font-semibold">DMD Studio</h1>
      <p className="text-gray-600">
        Record interview-style conversations with guests, locally in-browser,
        for later playback and download.
      </p>

      {!user ? (
        <button
          onClick={signInHost}
          className="w-fit rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          Sign in with Google
        </button>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">
              Signed in as {user.displayName ?? user.email}
            </span>
            <button
              onClick={() => signOut(auth)}
              className="text-sm text-gray-500 underline"
            >
              Sign out
            </button>
          </div>

          <button
            onClick={createSession}
            disabled={creating}
            className="w-fit rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? "Creating…" : "New interview session"}
          </button>

          {hostLink && inviteLink && (
            <div className="flex flex-col gap-2 rounded-md border border-gray-200 p-4 text-sm">
              <p>
                <strong>Your host link:</strong>{" "}
                <a className="text-blue-600 underline" href={hostLink}>
                  {hostLink}
                </a>
              </p>
              <p>
                <strong>Guest invite link:</strong>{" "}
                <a className="text-blue-600 underline" href={inviteLink}>
                  {inviteLink}
                </a>
              </p>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
