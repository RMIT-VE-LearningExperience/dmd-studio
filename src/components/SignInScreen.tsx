"use client";

import { signInHost } from "@/lib/auth";

export default function SignInScreen() {
  return (
    <main className="flex min-h-screen justify-center bg-neutral-950 px-6 py-16 text-neutral-100">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">DMD Studio</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Record interview-style conversations with guests, locally in-browser, for later
            playback and download.
          </p>
        </div>
        <button
          onClick={signInHost}
          className="w-fit rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          Sign in with Google
        </button>
      </div>
    </main>
  );
}
