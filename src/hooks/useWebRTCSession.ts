"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getRtcConfig } from "@/lib/rtcConfig";

export type Role = "host" | "guest";
export type ConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

// 1:1 signaling only — matches the interview (host + one guest) use case.
// sessions/{id}.offer / .answer hold the SDPs; offerCandidates / answerCandidates
// subcollections carry ICE candidates for whichever side didn't create them.
export function useWebRTCSession(sessionId: string, role: Role) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const connect = useCallback(
    async (localStream: MediaStream) => {
      const pc = new RTCPeerConnection(getRtcConfig());
      pcRef.current = pc;
      setConnectionState("connecting");

      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      const remote = new MediaStream();
      setRemoteStream(remote);
      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remote.addTrack(track));
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") setConnectionState("connected");
        if (pc.connectionState === "disconnected") setConnectionState("disconnected");
        if (pc.connectionState === "failed") setConnectionState("failed");
      };

      const sessionRef = doc(db, "sessions", sessionId);
      const offerCandidates = collection(sessionRef, "offerCandidates");
      const answerCandidates = collection(sessionRef, "answerCandidates");

      if (role === "host") {
        pc.onicecandidate = (event) => {
          if (event.candidate) addDoc(offerCandidates, event.candidate.toJSON());
        };

        const offerDescription = await pc.createOffer();
        await pc.setLocalDescription(offerDescription);
        await setDoc(
          sessionRef,
          { offer: { sdp: offerDescription.sdp, type: offerDescription.type } },
          { merge: true },
        );

        const unsubSession = onSnapshot(sessionRef, (snapshot) => {
          const data = snapshot.data();
          if (!pc.currentRemoteDescription && data?.answer) {
            pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          }
        });

        const unsubCandidates = onSnapshot(answerCandidates, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
              pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
            }
          });
        });

        return () => {
          unsubSession();
          unsubCandidates();
        };
      } else {
        pc.onicecandidate = (event) => {
          if (event.candidate) addDoc(answerCandidates, event.candidate.toJSON());
        };

        const unsubOffer = onSnapshot(sessionRef, async (snapshot) => {
          const data = snapshot.data();
          if (!pc.currentRemoteDescription && data?.offer) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answerDescription = await pc.createAnswer();
            await pc.setLocalDescription(answerDescription);
            await updateDoc(sessionRef, {
              answer: { sdp: answerDescription.sdp, type: answerDescription.type },
            });
          }
        });

        const unsubCandidates = onSnapshot(offerCandidates, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
              pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
            }
          });
        });

        return () => {
          unsubOffer();
          unsubCandidates();
        };
      }
    },
    [sessionId, role],
  );

  useEffect(() => {
    return () => {
      pcRef.current?.close();
    };
  }, []);

  return { connect, remoteStream, connectionState };
}
