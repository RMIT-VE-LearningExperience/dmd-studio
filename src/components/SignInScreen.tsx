"use client";

import { useState } from "react";
import { FirebaseError } from "firebase/app";
import { signInHost } from "@/lib/auth";

function getSignInErrorMessage(error: unknown) {
  if (error instanceof FirebaseError) {
    if (error.code === "auth/unauthorized-domain") {
      return "This app domain is not authorized for Google sign-in.";
    }
    if (error.code === "auth/popup-closed-by-user") {
      return "The Google sign-in window was closed before sign-in finished.";
    }
    if (error.code === "auth/popup-blocked") {
      return "Your browser blocked the Google sign-in window.";
    }
  }

  return "Google sign-in failed. Please try again.";
}

export default function SignInScreen() {
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSignIn = async () => {
    setSigningIn(true);
    setErrorMessage(null);

    try {
      await signInHost();
    } catch (error) {
      setErrorMessage(getSignInErrorMessage(error));
    } finally {
      setSigningIn(false);
    }
  };

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
          onClick={handleSignIn}
          disabled={signingIn}
          className="w-fit rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {signingIn ? "Opening Google..." : "Sign in with Google"}
        </button>
        {errorMessage && (
          <p role="alert" className="max-w-md text-sm text-red-300">
            {errorMessage}
          </p>
        )}
      </div>
    </main>
  );
}
