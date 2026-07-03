"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getRtcConfig } from "@/lib/rtcConfig";

export type ParticipantRole = "host" | "guest" | "producer";

export type RemotePeer = {
  uid: string;
  role: ParticipantRole;
  displayName: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
};

type ParticipantData = {
  role: ParticipantRole;
  displayName: string;
  active?: boolean;
};

// Deterministic per-pair ID so both sides agree on one signaling doc, and on
// who is the offerer (the lexicographically smaller uid) — avoids glare
// without needing a lock or negotiation round-trip.
function pairId(a: string, b: string) {
  return [a, b].sort().join("_");
}

// Full-mesh WebRTC: every participant connects directly to every other
// participant. Reasonable up to ~4-5 people; a larger session would need an
// SFU instead, deliberately out of scope here to keep infra cost near zero.
export function useWebRTCMesh(
  sessionId: string,
  localUid: string,
  role: ParticipantRole,
) {
  const [peers, setPeers] = useState<Record<string, RemotePeer>>({});
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const unsubscribersRef = useRef<Record<string, () => void>>({});
  const localStreamRef = useRef<MediaStream | null>(null);

  const disconnectFromPeer = useCallback((remoteUid: string) => {
    peerConnectionsRef.current[remoteUid]?.close();
    delete peerConnectionsRef.current[remoteUid];
    unsubscribersRef.current[remoteUid]?.();
    delete unsubscribersRef.current[remoteUid];
    setPeers((prev) => {
      if (!(remoteUid in prev)) return prev;
      const next = { ...prev };
      delete next[remoteUid];
      return next;
    });
  }, []);

  const connectToPeer = useCallback(
    (remoteUid: string, remoteRole: ParticipantRole, remoteName: string) => {
      if (peerConnectionsRef.current[remoteUid]) return;
      const stream = localStreamRef.current;
      if (!stream) return;

      const pc = new RTCPeerConnection(getRtcConfig());
      peerConnectionsRef.current[remoteUid] = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const remoteStream = new MediaStream();
      setPeers((prev) => ({
        ...prev,
        [remoteUid]: {
          uid: remoteUid,
          role: remoteRole,
          displayName: remoteName,
          stream: remoteStream,
          connectionState: "connecting",
        },
      }));

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      };

      pc.onconnectionstatechange = () => {
        setPeers((prev) =>
          prev[remoteUid]
            ? { ...prev, [remoteUid]: { ...prev[remoteUid], connectionState: pc.connectionState } }
            : prev,
        );
      };

      const connRef = doc(db, "sessions", sessionId, "connections", pairId(localUid, remoteUid));
      const offerCandidates = collection(connRef, "offerCandidates");
      const answerCandidates = collection(connRef, "answerCandidates");
      const isOfferer = localUid < remoteUid;

      if (isOfferer) {
        pc.onicecandidate = (event) => {
          if (event.candidate) addDoc(offerCandidates, event.candidate.toJSON());
        };

        (async () => {
          const offerDescription = await pc.createOffer();
          await pc.setLocalDescription(offerDescription);
          await setDoc(
            connRef,
            { offer: { sdp: offerDescription.sdp, type: offerDescription.type } },
            { merge: true },
          );
        })();

        const unsubAnswer = onSnapshot(connRef, (snap) => {
          const data = snap.data();
          if (!pc.currentRemoteDescription && data?.answer) {
            pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          }
        });
        const unsubCandidates = onSnapshot(answerCandidates, (snap) => {
          snap.docChanges().forEach((change) => {
            if (change.type === "added") {
              pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
            }
          });
        });
        unsubscribersRef.current[remoteUid] = () => {
          unsubAnswer();
          unsubCandidates();
        };
      } else {
        pc.onicecandidate = (event) => {
          if (event.candidate) addDoc(answerCandidates, event.candidate.toJSON());
        };

        const unsubOffer = onSnapshot(connRef, async (snap) => {
          const data = snap.data();
          if (!pc.currentRemoteDescription && data?.offer) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            await setDoc(
              connRef,
              { answer: { sdp: answerDescription.sdp, type: answerDescription.type } },
              { merge: true },
            );
          }
        });
        const unsubCandidates = onSnapshot(offerCandidates, (snap) => {
          snap.docChanges().forEach((change) => {
            if (change.type === "added") {
              pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
            }
          });
        });
        unsubscribersRef.current[remoteUid] = () => {
          unsubOffer();
          unsubCandidates();
        };
      }
    },
    [sessionId, localUid],
  );

  const join = useCallback(
    // displayName arrives here (not as a hook arg) because the user can edit
    // it in the lobby right up until the moment they join.
    async (stream: MediaStream, displayName: string) => {
      localStreamRef.current = stream;

      await setDoc(doc(db, "sessions", sessionId, "participants", localUid), {
        role,
        displayName,
        joinedAt: serverTimestamp(),
        active: true,
      });

      const participantsRef = collection(db, "sessions", sessionId, "participants");
      const unsub = onSnapshot(participantsRef, (snap) => {
        snap.docChanges().forEach((change) => {
          const uid = change.doc.id;
          if (uid === localUid) return;
          const data = change.doc.data() as ParticipantData;

          if (change.type === "removed" || data.active === false) {
            disconnectFromPeer(uid);
          } else {
            connectToPeer(uid, data.role, data.displayName);
          }
        });
      });
      unsubscribersRef.current.__participants = unsub;
    },
    [sessionId, localUid, role, connectToPeer, disconnectFromPeer],
  );

  const leave = useCallback(async () => {
    await setDoc(
      doc(db, "sessions", sessionId, "participants", localUid),
      { active: false },
      { merge: true },
    );
    Object.keys(peerConnectionsRef.current).forEach(disconnectFromPeer);
    unsubscribersRef.current.__participants?.();
  }, [sessionId, localUid, disconnectFromPeer]);

  useEffect(() => {
    // Intentionally reading refs at cleanup time, not capturing them here —
    // these are plain mutable maps of live connections, not DOM nodes, so we
    // need whatever they contain at unmount, not at mount.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(unsubscribersRef.current).forEach((fn) => fn());
    };
  }, []);

  return { peers: Object.values(peers), join, leave };
}
