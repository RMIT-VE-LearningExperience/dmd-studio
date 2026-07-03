# DMD Studio

Record interview-style conversations (teacher + guest expert) with local
in-browser recording, like Riverside — the live call is low-quality WebRTC,
while each participant's browser separately captures and uploads a
high-quality local recording.

## How it works

- **Live call**: peer-to-peer WebRTC, signaled through Firestore
  (`sessions/{id}` docs + `offerCandidates`/`answerCandidates`
  subcollections). Built for host + one guest.
- **Recording**: each browser uses `MediaRecorder` to capture its own
  mic/camera, buffering chunks into `IndexedDB` so a refresh mid-call doesn't
  lose the take. On "End session" it reassembles the chunks and uploads to
  Firebase Storage at `recordings/{sessionId}/{host|guest}.webm`.
- **Auth**: host signs in with Google; guests join anonymously via the invite
  link with zero signup friction.

## Setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com).
2. Enable **Authentication** → Google sign-in provider, and Anonymous sign-in.
3. Enable **Firestore** (production mode) and **Storage**.
4. Copy `.env.local.example` to `.env.local` and fill in the values from
   Project Settings → General → Your apps → SDK setup and config.
5. (Optional but recommended) Set up a TURN server so guests behind
   restrictive NATs/firewalls can connect — STUN alone isn't reliable enough
   in practice. Cloudflare Calls TURN or Twilio Network Traversal Service both
   work; fill in `NEXT_PUBLIC_TURN_*` in `.env.local`.
6. Deploy security rules:
   ```bash
   firebase login
   firebase use --add   # select your Firebase project
   firebase deploy --only firestore:rules,storage
   ```

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with Google, and
create a session. Share the guest invite link with your interview guest —
they'll join without needing an account.

## Current scope (v1)

Recording + playback only: create a session, both sides record locally, both
upload on end, host can play back/download the raw tracks from Storage.
No editing, mixing, or transcripts yet.
