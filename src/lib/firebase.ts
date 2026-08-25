import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Every consumer of these exports is a client component that only touches
// them from event handlers / useEffect, but Next.js still evaluates the
// module during server-side prerendering — guard init so a placeholder or
// missing config doesn't crash the build.
const app: FirebaseApp | undefined =
  typeof window !== "undefined"
    ? getApps().length
      ? getApp()
      : initializeApp(firebaseConfig)
    : undefined;

export const auth = app ? getAuth(app) : (undefined as unknown as Auth);
export const db = app ? getFirestore(app) : (undefined as unknown as Firestore);
export const storage = app ? getStorage(app) : (undefined as unknown as FirebaseStorage);

// The SDK abandons an operation that outlives these ceilings (defaults: 2 min
// for downloads/lists/deletes, 10 min for uploads) with
// "storage/retry-limit-exceeded" — even when it's progressing fine. Large
// takes on ordinary connections routinely exceed both, so give them room.
if (app) {
  storage.maxOperationRetryTime = 30 * 60 * 1000;
  storage.maxUploadRetryTime = 30 * 60 * 1000;
}
export default app;
