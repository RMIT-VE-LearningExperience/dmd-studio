"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getRtcConfig, warmIceServers } from "@/lib/rtcConfig";

export type ParticipantRole = "host" | "guest" | "producer";

export type RemotePeer = {
  uid: string;
  role: ParticipantRole;
  displayName: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  // Set while an automatic reconnect is underway (1-based attempt number),
  // and latched true once the retry budget is spent without success.
  retryAttempt?: number;
  retriesExhausted?: boolean;
  muted?: boolean;
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
  muted?: boolean;
};

type RtcDiagnostic = {
  kind: "camera" | "screen-send" | "screen-recv";
  remoteUid: string;
  remoteName?: string;
  offerer?: boolean;
  connectionState?: RTCPeerConnectionState;
  iceConnectionState?: RTCIceConnectionState;
  iceGatheringState?: RTCIceGatheringState;
  signalingState?: RTCSignalingState;
  localCandidateCount?: number;
  remoteCandidateCount?: number;
  lastStep?: string;
  lastError?: string | null;
};

// Deterministic per-pair ID so both sides agree on one signaling doc, and on
// who is the offerer (the lexicographically smaller uid) — avoids glare
// without needing a lock or negotiation round-trip.
function pairId(a: string, b: string) {
  return [a, b].sort().join("_");
}

function rtcKey(kind: RtcDiagnostic["kind"], remoteUid: string) {
  return `${kind}_${remoteUid}`;
}

function describeRtcError(err: unknown) {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 240);
  return String(err).slice(0, 240);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

// Browsers reject addIceCandidate until a remote description is set, and
// Firestore can deliver the candidate snapshot before the offer/answer doc.
// Candidates applied too early used to be dropped permanently — if the one
// that mattered (often the TURN relay candidate) arrived first, the
// connection sat at "connecting" forever. Queue them until the description
// lands, then flush.
function createCandidateGate(
  pc: RTCPeerConnection,
  onApplied: () => void,
  onError: (err: unknown) => void,
) {
  let ready = false;
  const queue: RTCIceCandidateInit[] = [];
  const apply = (candidate: RTCIceCandidateInit) => {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).then(onApplied).catch(onError);
  };
  return {
    push(candidate: RTCIceCandidateInit) {
      if (ready) apply(candidate);
      else queue.push(candidate);
    },
    open() {
      ready = true;
      while (queue.length > 0) apply(queue.shift()!);
    },
  };
}

// Best-effort teardown of one signaling doc and its ICE-candidate
// subcollections. Both ends attempt it on leave; whoever runs second finds
// nothing left, which is fine.
async function deleteConnectionDoc(sessionId: string, connId: string) {
  const connRef = doc(db, "sessions", sessionId, "connections", connId);
  for (const sub of ["offerCandidates", "answerCandidates"]) {
    const snap = await getDocs(collection(connRef, sub));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
  }
  await deleteDoc(connRef).catch(() => {});
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
  const rtcDiagnosticsRef = useRef<Record<string, RtcDiagnostic>>({});
  // Every signaling doc this client participated in, swept on leave so the
  // connections subcollection doesn't accumulate dead offer/answer docs.
  const signalingDocsRef = useRef<Set<string>>(new Set());
  // Reconnect machinery: last-known role/name per peer (to rebuild a
  // connection without waiting for another participants snapshot), retry
  // budgets, and pending watchdog/reconnect timers.
  const participantsMetaRef = useRef<Record<string, { role: ParticipantRole; displayName: string; muted?: boolean }>>({});
  const retryCountsRef = useRef<Record<string, number>>({});
  const watchdogsRef = useRef<Record<string, number>>({});
  const reconnectTimersRef = useRef<Record<string, number>>({});
  const reconnectRef = useRef<(remoteUid: string, budgeted: boolean) => void>(() => {});

  const disconnectFromPeer = useCallback((remoteUid: string) => {
    window.clearTimeout(watchdogsRef.current[remoteUid]);
    delete watchdogsRef.current[remoteUid];
    window.clearTimeout(reconnectTimersRef.current[remoteUid]);
    delete reconnectTimersRef.current[remoteUid];
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
    (remoteUid: string, remoteRole: ParticipantRole, remoteName: string, remoteMuted = false) => {
      if (peerConnectionsRef.current[remoteUid]) return;
      const stream = localStreamRef.current;
      if (!stream) return;

      const rtcConfig = getRtcConfig();
      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionsRef.current[remoteUid] = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      const diagnosticKey = rtcKey("camera", remoteUid);
      let localCandidateCount = 0;
      let remoteCandidateCount = 0;
      const writeDiagnostic = (patch: Partial<RtcDiagnostic>) => {
        const next: RtcDiagnostic = {
          ...rtcDiagnosticsRef.current[diagnosticKey],
          ...patch,
          kind: "camera",
          remoteUid,
          remoteName,
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          signalingState: pc.signalingState,
          localCandidateCount,
          remoteCandidateCount,
        };
        rtcDiagnosticsRef.current[diagnosticKey] = next;
        void setDoc(
          doc(db, "sessions", sessionId, "participants", localUid),
          { rtc: { [diagnosticKey]: withoutUndefined({ ...next, updatedAt: serverTimestamp() }) } },
          { merge: true },
        ).catch(() => {});
      };

      const remoteStream = new MediaStream();
      setPeers((prev) => ({
        ...prev,
        [remoteUid]: {
          uid: remoteUid,
          role: remoteRole,
          displayName: remoteName,
          stream: remoteStream,
          connectionState: "connecting",
          muted: remoteMuted,
          // Survives the placeholder → real-connection swap during a retry.
          retryAttempt: prev[remoteUid]?.retryAttempt,
        },
      }));

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
        writeDiagnostic({ lastStep: "remote-track" });
      };

      signalingDocsRef.current.add(pairId(localUid, remoteUid));
      const connRef = doc(db, "sessions", sessionId, "connections", pairId(localUid, remoteUid));
      const offerCandidates = collection(connRef, "offerCandidates");
      const answerCandidates = collection(connRef, "answerCandidates");
      const isOfferer = localUid < remoteUid;

      pc.onconnectionstatechange = () => {
        setPeers((prev) =>
          prev[remoteUid]
            ? {
                ...prev,
                [remoteUid]: {
                  ...prev[remoteUid],
                  connectionState: pc.connectionState,
                  ...(pc.connectionState === "connected"
                    ? { retryAttempt: undefined, retriesExhausted: undefined }
                    : {}),
                },
              }
            : prev,
        );
        writeDiagnostic({ lastStep: `connection-${pc.connectionState}` });
        if (pc.connectionState === "connected") {
          window.clearTimeout(watchdogsRef.current[remoteUid]);
          delete watchdogsRef.current[remoteUid];
          retryCountsRef.current[remoteUid] = 0;
        } else if (pc.connectionState === "failed" && isOfferer) {
          // The offerer drives recovery; the answerer follows the fresh
          // offer it produces (see the re-offer branch below).
          writeDiagnostic({ lastStep: "failed-retrying" });
          reconnectRef.current(remoteUid, true);
        }
      };
      pc.oniceconnectionstatechange = () => {
        writeDiagnostic({ lastStep: `ice-${pc.iceConnectionState}` });
      };
      pc.onicegatheringstatechange = () => {
        writeDiagnostic({ lastStep: `gathering-${pc.iceGatheringState}` });
      };

      // A connection that hasn't succeeded within this window is wedged
      // (e.g. its decisive candidate was lost) — tear it down and renegotiate
      // rather than showing "Connecting…" forever.
      if (isOfferer) {
        window.clearTimeout(watchdogsRef.current[remoteUid]);
        watchdogsRef.current[remoteUid] = window.setTimeout(() => {
          if (pc.connectionState !== "connected") {
            writeDiagnostic({ lastStep: "watchdog-retrying" });
            reconnectRef.current(remoteUid, true);
          }
        }, 20_000);
      }

      writeDiagnostic({
        offerer: isOfferer,
        lastStep: "created",
        lastError: null,
      });

      if (isOfferer) {
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            localCandidateCount += 1;
            void addDoc(offerCandidates, event.candidate.toJSON()).catch((err) => {
              writeDiagnostic({ lastStep: "write-offer-candidate-failed", lastError: describeRtcError(err) });
            });
          } else {
            writeDiagnostic({ lastStep: "offer-candidates-complete" });
          }
        };

        (async () => {
          // This doc ID is deterministic (sorted uid pair) and gets reused
          // across every leave/rejoin — a leftover `answer` from a previous
          // session would otherwise look like the answer to this brand-new
          // offer, and the real answer that arrives later gets ignored
          // (currentRemoteDescription is already set). Clearing it here
          // makes correctness independent of whether leave()'s best-effort,
          // un-awaited cleanup has finished yet.
          await deleteConnectionDoc(sessionId, pairId(localUid, remoteUid));
          const offerDescription = await pc.createOffer();
          await pc.setLocalDescription(offerDescription);
          await setDoc(
            connRef,
            { offer: { sdp: offerDescription.sdp, type: offerDescription.type } },
            { merge: true },
          );
          writeDiagnostic({ lastStep: "offer-written" });
        })().catch((err) => {
          writeDiagnostic({ lastStep: "offer-failed", lastError: describeRtcError(err) });
        });

        const candidateGate = createCandidateGate(
          pc,
          () => writeDiagnostic({ lastStep: "answer-candidate-applied" }),
          (err) => writeDiagnostic({ lastStep: "answer-candidate-failed", lastError: describeRtcError(err) }),
        );
        const unsubAnswer = onSnapshot(connRef, (snap) => {
          const data = snap.data();
          if (!pc.currentRemoteDescription && data?.answer) {
            pc.setRemoteDescription(new RTCSessionDescription(data.answer))
              .then(() => {
                writeDiagnostic({ lastStep: "answer-applied" });
                candidateGate.open();
              })
              .catch((err) => {
                writeDiagnostic({ lastStep: "answer-failed", lastError: describeRtcError(err) });
              });
          }
        });
        const unsubCandidates = onSnapshot(answerCandidates, (snap) => {
          snap.docChanges().forEach((change) => {
            if (change.type === "added") {
              remoteCandidateCount += 1;
              candidateGate.push(change.doc.data() as RTCIceCandidateInit);
            }
          });
        });
        unsubscribersRef.current[remoteUid] = () => {
          unsubAnswer();
          unsubCandidates();
        };
      } else {
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            localCandidateCount += 1;
            void addDoc(answerCandidates, event.candidate.toJSON()).catch((err) => {
              writeDiagnostic({ lastStep: "write-answer-candidate-failed", lastError: describeRtcError(err) });
            });
          } else {
            writeDiagnostic({ lastStep: "answer-candidates-complete" });
          }
        };

        const candidateGate = createCandidateGate(
          pc,
          () => writeDiagnostic({ lastStep: "offer-candidate-applied" }),
          (err) => writeDiagnostic({ lastStep: "offer-candidate-failed", lastError: describeRtcError(err) }),
        );
        let appliedOfferSdp: string | null = null;
        const unsubOffer = onSnapshot(connRef, async (snap) => {
          const data = snap.data();
          if (!data?.offer) return;
          if (data.offer.sdp === appliedOfferSdp) return;
          if (appliedOfferSdp !== null) {
            // A different offer on an already-negotiated connection means the
            // offerer gave up and restarted — rebuild our side to match.
            writeDiagnostic({ lastStep: "re-offer-rebuilding" });
            reconnectRef.current(remoteUid, false);
            return;
          }
          appliedOfferSdp = data.offer.sdp;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            candidateGate.open();
            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            await setDoc(
              connRef,
              { answer: { sdp: answerDescription.sdp, type: answerDescription.type } },
              { merge: true },
            );
            writeDiagnostic({ lastStep: "answer-written" });
          } catch (err) {
            writeDiagnostic({ lastStep: "answer-failed", lastError: describeRtcError(err) });
          }
        });
        const unsubCandidates = onSnapshot(offerCandidates, (snap) => {
          snap.docChanges().forEach((change) => {
            if (change.type === "added") {
              remoteCandidateCount += 1;
              candidateGate.push(change.doc.data() as RTCIceCandidateInit);
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

  // Tears a wedged/failed connection down and negotiates a fresh one (the
  // offerer path wipes the signaling doc first, so this is always a clean
  // restart). Budgeted callers (watchdog, failed state) stop after 3
  // attempts; unbudgeted ones (answerer following a re-offer) always run.
  const reconnectPeer = useCallback(
    (remoteUid: string, budgeted: boolean) => {
      const meta = participantsMetaRef.current[remoteUid];
      if (!meta) return;
      let attempt = retryCountsRef.current[remoteUid] ?? 0;
      if (budgeted) {
        if (attempt >= 3) {
          // Budget spent — leave a clearly-failed tile rather than thrash.
          setPeers((prev) =>
            prev[remoteUid]
              ? { ...prev, [remoteUid]: { ...prev[remoteUid], retriesExhausted: true } }
              : prev,
          );
          return;
        }
        attempt += 1;
        retryCountsRef.current[remoteUid] = attempt;
      }
      // The original credentials may have expired or never loaded — refresh
      // them so the rebuilt connection doesn't silently run STUN-only.
      void warmIceServers();
      disconnectFromPeer(remoteUid);
      // Keep a placeholder tile up during the rebuild so the peer doesn't
      // blink out of the grid, and so the UI can say which attempt this is.
      setPeers((prev) => ({
        ...prev,
        [remoteUid]: {
          uid: remoteUid,
          role: meta.role,
          displayName: meta.displayName,
          stream: null,
          connectionState: "connecting",
          muted: !!meta.muted,
          retryAttempt: attempt > 0 ? attempt : undefined,
        },
      }));
      reconnectTimersRef.current[remoteUid] = window.setTimeout(() => {
        delete reconnectTimersRef.current[remoteUid];
        connectToPeer(remoteUid, meta.role, meta.displayName, !!meta.muted);
      }, 400);
    },
    [connectToPeer, disconnectFromPeer],
  );
  useEffect(() => {
    reconnectRef.current = reconnectPeer;
  }, [reconnectPeer]);

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

      signalingDocsRef.current.add(`screen_${localUid}_${viewerUid}_${shareId}`);
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
      const candidateGate = createCandidateGate(pc, () => {}, () => {});
      const unsubAnswer = onSnapshot(connRef, (snap) => {
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.answer) {
          pc.setRemoteDescription(new RTCSessionDescription(data.answer))
            .then(() => candidateGate.open())
            .catch(() => {});
        }
      });
      const unsubCandidates = onSnapshot(answerCandidates, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            candidateGate.push(change.doc.data() as RTCIceCandidateInit);
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

      signalingDocsRef.current.add(`screen_${sharerUid}_${localUid}_${shareId}`);
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
      const candidateGate = createCandidateGate(pc, () => {}, () => {});
      const unsubOffer = onSnapshot(connRef, async (snap) => {
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.offer) {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            candidateGate.open();
            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            await setDoc(
              connRef,
              { answer: { sdp: answerDescription.sdp, type: answerDescription.type } },
              { merge: true },
            );
          } catch {
            // A failed screen negotiation isn't worth crashing the room over;
            // re-sharing creates a fresh shareId-scoped doc anyway.
          }
        }
      });
      const unsubCandidates = onSnapshot(offerCandidates, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            candidateGate.push(change.doc.data() as RTCIceCandidateInit);
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

  const replaceLocalStream = useCallback(async (stream: MediaStream) => {
    localStreamRef.current = stream;
    const tracks = stream.getTracks();
    await Promise.all(
      Object.values(peerConnectionsRef.current).flatMap((pc) =>
        pc.getSenders().map((sender) => {
          const nextTrack = tracks.find((track) => track.kind === sender.track?.kind);
          return nextTrack ? sender.replaceTrack(nextTrack) : Promise.resolve();
        }),
      ),
    );
  }, []);

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
          // Kept fresh for the reconnect path, which rebuilds a connection
          // without waiting for another participants snapshot.
          participantsMetaRef.current[uid] = { role: data.role, displayName: data.displayName, muted: !!data.muted };

          // Guests/producers must be admitted by the host before the mesh
          // will talk to them (the host's own doc carries no admission field).
          const admitted = data.role === "host" || data.admission === "admitted";
          if (change.type === "removed" || data.active === false || !admitted) {
            disconnectFromPeer(uid);
            disconnectScreen(uid);
          } else {
            // connectToPeer/connectToScreen no-op once a connection already
            // exists (keyed on uid / shareId) — so a metadata-only change
            // like a host/producer rename needs its own path, or the peer's
            // tile would keep showing the old name until they reconnect.
            if (peerConnectionsRef.current[uid]) {
              setPeers((prev) =>
                prev[uid]
                  ? {
                      ...prev,
                      [uid]: {
                        ...prev[uid],
                        displayName: data.displayName,
                        role: data.role,
                        muted: !!data.muted,
                      },
                    }
                  : prev,
              );
            } else {
              connectToPeer(uid, data.role, data.displayName, !!data.muted);
            }
            // Follow their screen-share state, and offer them ours if we're
            // sharing when they arrive.
            if (data.screenShareId) {
              if (screenRecvPcsRef.current[uid]?.shareId === data.screenShareId) {
                setScreenPeers((prev) =>
                  prev[uid] ? { ...prev, [uid]: { ...prev[uid], displayName: data.displayName } } : prev,
                );
              } else {
                connectToScreen(uid, data.screenShareId, data.displayName);
              }
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

    // Best-effort, not awaited: dead signaling docs are garbage, not state —
    // leaving must not block on cleaning them up.
    const staleDocs = [...signalingDocsRef.current];
    signalingDocsRef.current.clear();
    void Promise.all(staleDocs.map((id) => deleteConnectionDoc(sessionId, id))).catch(() => {});
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(watchdogsRef.current).forEach((id) => window.clearTimeout(id));
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(reconnectTimersRef.current).forEach((id) => window.clearTimeout(id));
    };
  }, []);

  return {
    peers: Object.values(peers),
    screenPeers: Object.values(screenPeers),
    localScreenStream,
    join,
    leave,
    replaceLocalStream,
    startScreenShare,
    stopScreenShare,
  };
}
