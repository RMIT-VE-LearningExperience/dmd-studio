import { NextResponse } from "next/server";

// Issues ICE server config to the studio client. TURN credentials must be
// minted server-side: with Cloudflare Calls they're short-lived and derived
// from a key secret that can never ship to the browser.
//
// Resolution order:
//   1. Cloudflare Calls TURN (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_KEY_API_TOKEN)
//   2. Static TURN credentials (NEXT_PUBLIC_TURN_* — legacy env config)
//   3. STUN only (works for most home networks, fails behind strict NATs)

const STUN: RTCIceServer = { urls: "stun:stun.l.google.com:19302" };
const CREDENTIAL_TTL_SECONDS = 4 * 3600;

// Cloudflare credentials are valid for hours — cache them briefly so a
// studio full of participants doesn't mint one credential per page load.
let cached: { iceServers: RTCIceServer[]; expiresAtMs: number } | null = null;

async function cloudflareIceServers(): Promise<RTCIceServer[] | null> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
  if (!keyId || !apiToken) return null;

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    console.error(`Cloudflare TURN credential mint failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = (await res.json()) as { iceServers: RTCIceServer | RTCIceServer[] };
  return Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
}

function staticIceServers(): RTCIceServer[] | null {
  const urls = process.env.NEXT_PUBLIC_TURN_URLS;
  const username = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const credential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
  if (!urls || !username || !credential) return null;
  return [{ urls: urls.split(",").map((u) => u.trim()), username, credential }];
}

export async function GET() {
  if (cached && Date.now() < cached.expiresAtMs) {
    return NextResponse.json({ iceServers: cached.iceServers });
  }

  let turnServers: RTCIceServer[] | null = null;
  try {
    turnServers = await cloudflareIceServers();
  } catch (err) {
    console.error("Cloudflare TURN request threw:", err);
  }
  turnServers = turnServers ?? staticIceServers();

  const iceServers = [STUN, ...(turnServers ?? [])];
  if (turnServers) {
    // Refresh well before the credential TTL runs out.
    cached = { iceServers, expiresAtMs: Date.now() + (CREDENTIAL_TTL_SECONDS / 4) * 1000 };
  }
  return NextResponse.json({ iceServers });
}
