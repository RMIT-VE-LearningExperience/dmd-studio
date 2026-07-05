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

export type RemoteScreen = {
  uid: string;
  displayName: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
};

type ParticipantData = {
  role: ParticipantRole;
  displayName: string;
  active?: boolean;
  admission?: "pending" | "admitted" | "denied";
  // Set (to a fresh random id) while this participant shares their screen —
  // viewers key their receive-side signaling doc off it, so a stop/re-share
  // never collides with stale offer/answer docs from the previous share.
  screenShareId?: string | null;
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
  const [screenPeers, setScreenPeers] = useState<Record<string, RemoteScreen>>({});
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const screenSendPcsRef = useRef<Record<string, RTCPeerConnection>>({});
  const screenRecvPcsRef = useRef<Record<string, { pc: RTCPeerConnection; shareId: string }>>({});
  const unsubscribersRef = useRef<Record<string, () => void>>({});
  const localStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const localShareIdRef = useRef<string | null>(null);

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

  const disconnectScreen = useCallback((sharerUid: string) => {
    screenRecvPcsRef.current[sharerUid]?.pc.close();
    delete screenRecvPcsRef.current[sharerUid];
    unsubscribersRef.current[`screen_recv_${sharerUid}`]?.();
    delete unsubscribersRef.current[`screen_recv_${sharerUid}`];
    setScreenPeers((prev) => {
      if (!(sharerUid in prev)) return prev;
      const next = { ...prev };
      delete next[sharerUid];
      return next;
    });
  }, []);

  // Sharer side: one send-only connection per viewer, sharer always offers.
  const shareScreenTo = useCallback(
    (viewerUid: string) => {
      const shareId = localShareIdRef.current;
      const stream = localScreenStreamRef.current;
      if (!shareId || !stream || screenSendPcsRef.current[viewerUid]) return;

      const pc = new RTCPeerConnection(getRtcConfig());
      screenSendPcsRef.current[viewerUid] = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const connRef = doc(
        db,
        "sessions",
        sessionId,
        "connections",
        `screen_${localUid}_${viewerUid}_${shareId}`,
      );
      const offerCandidates = collection(connRef, "offerCandidates");
      const answerCandidates = collection(connRef, "answerCandidates");

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
      unsubscribersRef.current[`screen_send_${viewerUid}`] = () => {
        unsubAnswer();
        unsubCandidates();
      };
    },
    [sessionId, localUid],
  );

  // Viewer side: answer the sharer's offer on the shareId-scoped doc.
  const connectToScreen = useCallback(
    (sharerUid: string, shareId: string, sharerName: string) => {
      if (screenRecvPcsRef.current[sharerUid]?.shareId === shareId) return;
      disconnectScreen(sharerUid);

      const pc = new RTCPeerConnection(getRtcConfig());
      screenRecvPcsRef.current[sharerUid] = { pc, shareId };

      const remoteStream = new MediaStream();
      setScreenPeers((prev) => ({
        ...prev,
        [sharerUid]: {
          uid: sharerUid,
          displayName: sharerName,
          stream: remoteStream,
          connectionState: "connecting",
        },
      }));

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      };
      pc.onconnectionstatechange = () => {
        setScreenPeers((prev) =>
          prev[sharerUid]
            ? { ...prev, [sharerUid]: { ...prev[sharerUid], connectionState: pc.connectionState } }
            : prev,
        );
      };

      const connRef = doc(
        db,
        "sessions",
        sessionId,
        "connections",
        `screen_${sharerUid}_${localUid}_${shareId}`,
      );
      const offerCandidates = collection(connRef, "offerCandidates");
      const answerCandidates = collection(connRef, "answerCandidates");

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
      unsubscribersRef.current[`screen_recv_${sharerUid}`] = () => {
        unsubOffer();
        unsubCandidates();
      };
    },
    [sessionId, localUid, disconnectScreen],
  );

  const closeAllScreenSends = useCallback(() => {
    Object.entries(screenSendPcsRef.current).forEach(([viewerUid, pc]) => {
      pc.close();
      unsubscribersRef.current[`screen_send_${viewerUid}`]?.();
      delete unsubscribersRef.current[`screen_send_${viewerUid}`];
    });
    screenSendPcsRef.current = {};
  }, []);

  const startScreenShare = useCallback(
    async (stream: MediaStream) => {
      localScreenStreamRef.current = stream;
      localShareIdRef.current = Math.random().toString(36).slice(2, 10);
      setLocalScreenStream(stream);
      Object.keys(peerConnectionsRef.current).forEach(shareScreenTo);
      await setDoc(
        doc(db, "sessions", sessionId, "participants", localUid),
        { screenShareId: localShareIdRef.current },
        { merge: true },
      );
    },
    [sessionId, localUid, shareScreenTo],
  );

  const stopScreenShare = useCallback(async () => {
    localShareIdRef.current = null;
    localScreenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localScreenStreamRef.current = null;
    setLocalScreenStream(null);
    closeAllScreenSends();
    await setDoc(
      doc(db, "sessions", sessionId, "participants", localUid),
      { screenShareId: null },
      { merge: true },
    );
  }, [sessionId, localUid, closeAllScreenSends]);

  const join = useCallback(
    // displayName arrives here (not as a hook arg) because the user can edit
    // it in the lobby right up until the moment they join.
    async (stream: MediaStream, displayName: string) => {
      localStreamRef.current = stream;

      // merge: the doc may already carry admission state (waiting room) and
      // upload progress — joining must not wipe them.
      await setDoc(
        doc(db, "sessions", sessionId, "participants", localUid),
        {
          role,
          displayName,
          joinedAt: serverTimestamp(),
          active: true,
        },
        { merge: true },
      );

      const participantsRef = collection(db, "sessions", sessionId, "participants");
      const unsub = onSnapshot(participantsRef, (snap) => {
        snap.docChanges().forEach((change) => {
          const uid = change.doc.id;
          if (uid === localUid) return;
          const data = change.doc.data() as ParticipantData;

          // Guests/producers must be admitted by the host before the mesh
          // will talk to them (the host's own doc carries no admission field).
          const admitted = data.role === "host" || data.admission === "admitted";
          if (change.type === "removed" || data.active === false || !admitted) {
            disconnectFromPeer(uid);
            disconnectScreen(uid);
          } else {
            connectToPeer(uid, data.role, data.displayName);
            // Follow their screen-share state, and offer them ours if we're
            // sharing when they arrive.
            if (data.screenShareId) {
              connectToScreen(uid, data.screenShareId, data.displayName);
            } else {
              disconnectScreen(uid);
            }
            if (localShareIdRef.current) shareScreenTo(uid);
          }
        });
      });
      unsubscribersRef.current.__participants = unsub;
    },
    [sessionId, localUid, role, connectToPeer, disconnectFromPeer, connectToScreen, disconnectScreen, shareScreenTo],
  );

  const leave = useCallback(async () => {
    localShareIdRef.current = null;
    localScreenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localScreenStreamRef.current = null;
    setLocalScreenStream(null);
    closeAllScreenSends();
    await setDoc(
      doc(db, "sessions", sessionId, "participants", localUid),
      { active: false, screenShareId: null },
      { merge: true },
    );
    Object.keys(peerConnectionsRef.current).forEach(disconnectFromPeer);
    Object.keys(screenRecvPcsRef.current).forEach(disconnectScreen);
    unsubscribersRef.current.__participants?.();
  }, [sessionId, localUid, disconnectFromPeer, disconnectScreen, closeAllScreenSends]);

  useEffect(() => {
    // Intentionally reading refs at cleanup time, not capturing them here —
    // these are plain mutable maps of live connections, not DOM nodes, so we
    // need whatever they contain at unmount, not at mount.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
       
      Object.values(screenSendPcsRef.current).forEach((pc) => pc.close());
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(screenRecvPcsRef.current).forEach(({ pc }) => pc.close());
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(unsubscribersRef.current).forEach((fn) => fn());
    };
  }, []);

  return {
    peers: Object.values(peers),
    screenPeers: Object.values(screenPeers),
    localScreenStream,
    join,
    leave,
    startScreenShare,
    stopScreenShare,
  };
}
