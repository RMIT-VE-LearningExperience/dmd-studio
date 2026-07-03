export function getRtcConfig(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];

  const turnUrls = process.env.NEXT_PUBLIC_TURN_URLS;
  const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

  if (turnUrls && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls.split(",").map((url) => url.trim()),
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return { iceServers };
}
