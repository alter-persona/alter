"use client";

import { useRef, useState } from "react";
import Link from "next/link";

type Phase = "idle" | "recording" | "thinking" | "speaking";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Timings {
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}

/**
 * Voice conversation test: tap to talk, release to send. The persona listens
 * (whisper), thinks (fast local model on the v2 anti-parrot prompt), and
 * answers out loud in the professional voice clone.
 */
export default function TalkPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<{ who: "you" | "persona"; text: string }[]>([]);
  const [history, setHistory] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [timings, setTimings] = useState<Timings | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void sendTurn(new Blob(chunksRef.current, { type: "audio/webm" }));
      };
      rec.start(500);
      setPhase("recording");
    } catch (e) {
      setError(`Microphone unavailable: ${String(e)}`);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setPhase("thinking");
  }

  async function sendTurn(blob: Blob) {
    try {
      const form = new FormData();
      form.append("audio", new File([blob], "turn.webm", { type: "audio/webm" }));
      form.append("history", JSON.stringify(history));
      const res = await fetch("/api/talk", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      setTurns((t) => [...t, { who: "you", text: json.transcript }, { who: "persona", text: json.reply }]);
      setHistory((h) => [
        ...h.slice(-6),
        { role: "user", content: json.transcript },
        { role: "assistant", content: json.reply },
      ]);
      setTimings(json.timings);

      if (json.audioB64) {
        setPhase("speaking");
        const audio = new Audio(`data:${json.audioMime ?? "audio/mpeg"};base64,${json.audioB64}`);
        audio.onended = () => setPhase("idle");
        audio.onerror = () => setPhase("idle");
        await audio.play().catch(() => setPhase("idle"));
      } else {
        setPhase("idle");
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setPhase("idle");
    }
  }

  const button: Record<Phase, { label: string; action?: () => void; cls: string }> = {
    idle: { label: "● Hold a thought — tap to talk", action: startRecording, cls: "btn-record" },
    recording: { label: "■ Listening… tap to send", action: stopRecording, cls: "btn-primary" },
    thinking: { label: "…thinking…", cls: "" },
    speaking: { label: "🔊 speaking…", cls: "" },
  };
  const b = button[phase];

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Talk to the persona</h1>
        <Link href="/" className="small">Home</Link>
      </div>
      <p className="muted small">
        Tap, speak, tap again. Whisper transcribes locally, the persona answers
        on the fast local model, and you hear the reply in the professional
        voice clone. First turn is slowest (models warming).
      </p>

      <div className="card" style={{ textAlign: "center", padding: 32 }}>
        <button
          className={b.cls}
          style={{ fontSize: 18, padding: "16px 32px" }}
          onClick={b.action}
          disabled={!b.action}
        >
          {b.label}
        </button>
        {timings && (
          <div className="muted small" style={{ marginTop: 10 }}>
            last turn: hear {Math.round(timings.sttMs / 100) / 10}s · think{" "}
            {Math.round(timings.llmMs / 100) / 10}s · voice {Math.round(timings.ttsMs / 100) / 10}s
            · total {Math.round(timings.totalMs / 100) / 10}s
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        {turns.length === 0 ? (
          <p className="muted">The conversation will appear here.</p>
        ) : (
          turns.map((t, i) => (
            <p key={i} style={{ margin: "8px 0" }}>
              <b>{t.who === "you" ? "You" : "Persona"}:</b> {t.text}
            </p>
          ))
        )}
      </div>
    </main>
  );
}
