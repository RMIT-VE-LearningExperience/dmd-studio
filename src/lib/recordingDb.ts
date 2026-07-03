import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "dmd-studio-recordings";
const STORE_NAME = "chunks";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE_NAME);
      },
    });
  }
  return dbPromise;
}

// Chunks are keyed as `${recordingId}:${index}` so they stay ordered and can
// be swept per-recording without touching other sessions stored locally.
export async function saveChunk(recordingId: string, index: number, blob: Blob) {
  const db = await getDb();
  await db.put(STORE_NAME, blob, `${recordingId}:${index}`);
}

export async function getChunks(recordingId: string): Promise<Blob[]> {
  const db = await getDb();
  const keys = (await db.getAllKeys(STORE_NAME)) as string[];
  const ownKeys = keys
    .filter((key) => key.startsWith(`${recordingId}:`))
    .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));

  const chunks: Blob[] = [];
  for (const key of ownKeys) {
    const blob = await db.get(STORE_NAME, key);
    if (blob) chunks.push(blob);
  }
  return chunks;
}

export async function clearRecording(recordingId: string) {
  const db = await getDb();
  const keys = (await db.getAllKeys(STORE_NAME)) as string[];
  const ownKeys = keys.filter((key) => key.startsWith(`${recordingId}:`));
  await Promise.all(ownKeys.map((key) => db.delete(STORE_NAME, key)));
}
