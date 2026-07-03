import {
  GoogleAuthProvider,
  signInAnonymously,
  signInWithPopup,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

// Teacher (host) accounts use Google sign-in so sessions persist to a real
// identity. Guests join via invite link with zero signup friction.
export async function signInHost() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signInGuest() {
  const result = await signInAnonymously(auth);
  return result.user;
}
