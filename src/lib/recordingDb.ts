import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "dmd-studio-recordings";
const CHUNKS_STORE = "chunks";
const TAKES_STORE = "takes";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE);
        }
        if (!db.objectStoreNames.contains(TAKES_STORE)) {
          db.createObjectStore(TAKES_STORE);
        }
      },
    });
  }
  return dbPromise;
}

// Chunks are keyed as `${recordingId}:${index}` so they stay ordered and can
// be swept per-recording without touching other sessions stored locally.
// A chunk is deleted as soon as it's confirmed uploaded — IndexedDB is only
// the retry buffer for chunks still in flight or that failed to upload.
export async function saveChunk(recordingId: string, index: number, blob: Blob) {
  const db = await getDb();
  await db.put(CHUNKS_STORE, blob, `${recordingId}:${index}`);
}

export async function deleteChunk(recordingId: string, index: number) {
  const db = await getDb();
  await db.delete(CHUNKS_STORE, `${recordingId}:${index}`);
}

export type ChunkEntry = { index: number; blob: Blob };

export async function getPendingChunks(recordingId: string): Promise<ChunkEntry[]> {
  const db = await getDb();
  const keys = (await db.getAllKeys(CHUNKS_STORE)) as string[];
  const ownKeys = keys
    .filter((key) => key.startsWith(`${recordingId}:`))
    .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));

  const entries: ChunkEntry[] = [];
  for (const key of ownKeys) {
    const blob = await db.get(CHUNKS_STORE, key);
    if (blob) entries.push({ index: Number(key.split(":")[1]), blob });
  }
  return entries;
}

// One record per take, written when recording starts and deleted only after
// the take's completion doc lands in Firestore. Its presence after a page
// reload means the upload never finished — the resume flow picks it up.
export type TakeMeta = {
  recId: string;
  sessionId: string;
  uid: string;
  take: number;
  extension: string;
  mimeType: string;
  displayName: string;
  role: string;
  startedAtMs: number;
  // Absent on metas written before screen recording existed — the resume
  // flow falls back to the camera-take conventions.
  kind?: string;
  folder?: string;
  docId?: string;
};

export async function saveTakeMeta(meta: TakeMeta) {
  const db = await getDb();
  await db.put(TAKES_STORE, meta, meta.recId);
}

export async function deleteTakeMeta(recId: string) {
  const db = await getDb();
  await db.delete(TAKES_STORE, recId);
}

export async function getPendingTakeMetas(sessionId: string, uid: string): Promise<TakeMeta[]> {
  const db = await getDb();
  const all = (await db.getAll(TAKES_STORE)) as TakeMeta[];
  return all
    .filter((meta) => meta.sessionId === sessionId && meta.uid === uid)
    .sort((a, b) => a.take - b.take);
}
