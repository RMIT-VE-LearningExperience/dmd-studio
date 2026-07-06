const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// ICE servers come from /api/turn (which mints short-lived TURN credentials
// server-side). Peer connections are created synchronously deep in the mesh,
// so the fetch happens ahead of time — warmIceServers() is called from the
// lobby — and getRtcConfig() hands out whatever is cached by then.
let cachedIceServers: RTCIceServer[] | null = null;
let warmPromise: Promise<void> | null = null;

export function warmIceServers(): Promise<void> {
  if (!warmPromise) {
    warmPromise = fetch("/api/turn")
      .then(async (res) => {
        if (!res.ok) throw new Error(`turn endpoint ${res.status}`);
        const data = (await res.json()) as { iceServers?: RTCIceServer[] };
        if (data.iceServers?.length) cachedIceServers = data.iceServers;
      })
      .catch(() => {
        // STUN-only fallback; allow a retry on the next warm call.
        warmPromise = null;
      });
  }
  return warmPromise;
}

export function getRtcConfig(): RTCConfiguration {
  return { iceServers: cachedIceServers ?? STUN_ONLY };
}
