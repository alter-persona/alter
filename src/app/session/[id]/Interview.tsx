"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  isAnswered,
  type QuestionDTO,
  type ResponseDTO,
  type SessionDTO,
} from "@/lib/types";

const LIKERT_LABELS: [number, string][] = [
  [1, "Very inaccurate"],
  [2, "Moderately inaccurate"],
  [3, "Neither accurate nor inaccurate"],
  [4, "Moderately accurate"],
  [5, "Very accurate"],
];

const MIN_VOICE_SECONDS = 20;

// ---------------------------------------------------------------------------

export default function Interview({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [questions, setQuestions] = useState<QuestionDTO[]>([]);
  const [responses, setResponses] = useState<Map<string, ResponseDTO>>(new Map());
  const [idx, setIdx] = useState<number | null>(null); // null = loading; questions.length = summary
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    async (initial: boolean) => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSession(data.session);
        setQuestions(data.questions);
        const map = new Map<string, ResponseDTO>(
          (data.responses as ResponseDTO[]).map((r) => [r.questionId, r])
        );
        setResponses(map);
        if (initial) {
          const qs = data.questions as QuestionDTO[];
          const first = qs.findIndex((q) => !isAnswered(map.get(q.id)));
          setIdx(first === -1 ? qs.length : first);
        }
      } catch (e) {
        setLoadError(String(e));
      }
    },
    [sessionId]
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Poll while any transcription is pending so transcripts appear when ready.
  const anyPending = useMemo(
    () => [...responses.values()].some((r) => r.transcriptStatus === "pending"),
    [responses]
  );
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => void load(false), 4000);
    return () => clearInterval(t);
  }, [anyPending, load]);

  const updateResponse = useCallback((r: ResponseDTO) => {
    setResponses((prev) => {
      const next = new Map(prev);
      next.set(r.questionId, r);
      return next;
    });
  }, []);

  if (loadError) {
    return (
      <main>
        <p className="error">Failed to load session: {loadError}</p>
        <Link href="/">Back to home</Link>
      </main>
    );
  }
  if (!session || idx === null) return <main className="muted">Loading…</main>;
  if (questions.length === 0) {
    return (
      <main>
        <div className="note">
          No questions loaded. Run <code>npm run db:seed</code> with{" "}
          <code>voice-personality-intake.md</code> in the project root.
        </div>
        <Link href="/">Back to home</Link>
      </main>
    );
  }

  const answeredCount = questions.filter((q) => isAnswered(responses.get(q.id))).length;
  const atSummary = idx >= questions.length;
  const question = atSummary ? null : questions[idx];
  const response = question ? responses.get(question.id) : undefined;

  async function skip() {
    if (!question) return;
    const res = await fetch("/api/responses", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, questionId: question.id, skipped: true }),
    });
    if (res.ok) {
      const { response } = await res.json();
      updateResponse(response);
    }
    setIdx((i) => (i === null ? i : Math.min(i + 1, questions.length)));
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 20 }}>
          {session.label}
          {session.isTrial && <span className="muted"> (trial)</span>}
        </h1>
        <Link href="/" className="small">
          Home
        </Link>
      </div>

      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${(answeredCount / questions.length) * 100}%` }}
        />
      </div>
      <div className="muted small">
        {answeredCount} of {questions.length} answered
        {atSummary ? "" : ` · question ${idx + 1} of ${questions.length}`}
      </div>

      <IndexGrid
        questions={questions}
        responses={responses}
        currentIdx={atSummary ? -1 : idx}
        onJump={setIdx}
      />

      {atSummary || !question ? (
        <Summary
          session={session}
          questions={questions}
          responses={responses}
          onJump={setIdx}
          onCompleted={(s) => setSession(s)}
        />
      ) : (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="section-label">{question.section}</div>
          {question.isValidation && (
            <div className="note">
              Validation set: these final answers are held out and will not shape the
              build — answer naturally.
            </div>
          )}
          <div className="prompt">
            {question.type === "likert" ? (
              <>
                <span className="muted small" style={{ display: "block", fontWeight: 400 }}>
                  How accurately does this statement describe you?
                </span>
                “{question.promptText}”
              </>
            ) : (
              question.promptText
            )}
          </div>

          {question.type === "voice" ? (
            <VoiceQuestion
              key={question.id}
              sessionId={sessionId}
              question={question}
              response={response}
              onSaved={(r) => {
                updateResponse(r);
                setIdx((i) => (i === null ? i : Math.min(i + 1, questions.length)));
              }}
              onResponseUpdated={updateResponse}
            />
          ) : (
            <LikertQuestion
              key={question.id}
              sessionId={sessionId}
              question={question}
              response={response}
              onSaved={(r, advance) => {
                updateResponse(r);
                if (advance)
                  setIdx((i) => (i === null ? i : Math.min(i + 1, questions.length)));
              }}
            />
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "20px 0 14px" }} />
          <div className="btn-row">
            <button onClick={() => setIdx((i) => Math.max((i ?? 1) - 1, 0))} disabled={idx === 0}>
              ← Back
            </button>
            <button onClick={() => setIdx((i) => Math.min((i ?? 0) + 1, questions.length))}>
              Next →
            </button>
            <button onClick={skip}>Skip for now</button>
            <span style={{ flex: 1 }} />
            <button onClick={() => setIdx(questions.length)}>Overview</button>
          </div>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function IndexGrid({
  questions,
  responses,
  currentIdx,
  onJump,
}: {
  questions: QuestionDTO[];
  responses: Map<string, ResponseDTO>;
  currentIdx: number;
  onJump: (i: number) => void;
}) {
  return (
    <div className="index-grid">
      {questions.map((q, i) => {
        const r = responses.get(q.id);
        const cls = [
          "index-cell",
          isAnswered(r) ? "answered" : r?.skipped ? "skipped" : "",
          i === currentIdx ? "current" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={q.id}
            className={cls}
            title={`${q.section}${r?.skipped ? " (skipped)" : ""}`}
            onClick={() => onJump(i)}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LikertQuestion({
  sessionId,
  question,
  response,
  onSaved,
}: {
  sessionId: string;
  question: QuestionDTO;
  response: ResponseDTO | undefined;
  onSaved: (r: ResponseDTO, advance: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(value: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/responses", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, questionId: question.id, likertValue: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { response } = await res.json();
      // Brief highlight, then advance.
      onSaved(response, false);
      setTimeout(() => onSaved(response, true), 250);
    } catch (e) {
      setError(`Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="likert-row">
      {LIKERT_LABELS.map(([value, label]) => (
        <button
          key={value}
          className={`likert-btn ${response?.likertValue === value ? "selected" : ""}`}
          disabled={busy}
          onClick={() => choose(value)}
        >
          {label}
        </button>
      ))}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------

type RecorderPhase = "idle" | "recording" | "recorded" | "saving";

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * MediaRecorder blobs lack a duration header, so the <audio> element reports
 * duration=Infinity and the timeline can't track. Seeking far past the end
 * forces the browser to compute the real duration, then we rewind.
 */
function fixInfiniteDuration(e: React.SyntheticEvent<HTMLAudioElement>) {
  const el = e.currentTarget;
  if (el.duration === Infinity || Number.isNaN(el.duration)) {
    const rewind = () => {
      el.removeEventListener("timeupdate", rewind);
      el.currentTime = 0;
    };
    el.addEventListener("timeupdate", rewind);
    el.currentTime = 1e7;
  }
}

function VoiceQuestion({
  sessionId,
  question,
  response,
  onSaved,
  onResponseUpdated,
}: {
  sessionId: string;
  question: QuestionDTO;
  response: ResponseDTO | undefined;
  onSaved: (r: ResponseDTO) => void;
  onResponseUpdated: (r: ResponseDTO) => void;
}) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<{ blob: Blob; url: string; durationSec: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerecording, setRerecording] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount / question change.
      if (timerRef.current) clearInterval(timerRef.current);
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (preview) URL.revokeObjectURL(preview.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          // Raw voice: this audio later trains a voice clone, so avoid
          // browser-side processing that colors the signal.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : undefined
      );
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const durationSec = (Date.now() - startRef.current) / 1000;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (preview) URL.revokeObjectURL(preview.url);
        setPreview({ blob, url: URL.createObjectURL(blob), durationSec });
        setPhase("recorded");
      };
      startRef.current = Date.now();
      setElapsed(0);
      timerRef.current = setInterval(
        () => setElapsed((Date.now() - startRef.current) / 1000),
        250
      );
      rec.start(1000); // gather data every second so a crash loses little
      setPhase("recording");
    } catch (e) {
      setError(`Microphone unavailable: ${String(e)}`);
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stop();
  }

  function discardPreview() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setPhase("idle");
  }

  async function save() {
    if (!preview) return;
    setPhase("saving");
    setError(null);
    try {
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("questionId", question.id);
      form.append("durationSec", preview.durationSec.toFixed(1));
      const ext = preview.blob.type.includes("mp4") ? "m4a" : "webm";
      form.append("file", new File([preview.blob], `answer.${ext}`, { type: preview.blob.type }));
      const res = await fetch("/api/responses/audio", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { response } = await res.json();
      URL.revokeObjectURL(preview.url);
      setPreview(null);
      setRerecording(false);
      setPhase("idle");
      onSaved(response);
    } catch (e) {
      setError(`Save failed: ${String(e)} — your recording is still here, try again.`);
      setPhase("recorded");
    }
  }

  const hasSaved = Boolean(response?.audioPath) && !rerecording;
  const short = preview !== null && preview.durationSec < MIN_VOICE_SECONDS;

  return (
    <div>
      <p className="muted small">
        Quiet room, one voice, no music — this same audio will later train your voice
        clone. Aim for 1–3 minutes.
      </p>

      {hasSaved && response ? (
        <div>
          <p className="ok small">
            Saved answer ({fmtTime(response.audioDurationSec ?? 0)})
          </p>
          <audio
            controls
            preload="metadata"
            onLoadedMetadata={fixInfiniteDuration}
            src={`/api/responses/${response.id}/audio?v=${encodeURIComponent(response.updatedAt)}`}
          />
          <div className="btn-row">
            <button onClick={() => setRerecording(true)}>Re-record</button>
          </div>
          <TranscriptPanel response={response} onUpdated={onResponseUpdated} />
        </div>
      ) : (
        <div>
          {phase === "idle" && (
            <div className="btn-row">
              <button className="btn-record" onClick={startRecording}>
                ● Record
              </button>
              {rerecording && response && (
                <button onClick={() => setRerecording(false)}>
                  Keep existing answer
                </button>
              )}
            </div>
          )}

          {phase === "recording" && (
            <div>
              <div className="timer">
                <span className="rec-dot" />
                {fmtTime(elapsed)}
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn-primary" onClick={stopRecording}>
                  ■ Stop
                </button>
              </div>
            </div>
          )}

          {(phase === "recorded" || phase === "saving") && preview && (
            <div>
              <p className="small">
                Take: {fmtTime(preview.durationSec)}
                {short && (
                  <span className="warn">
                    {" "}
                    — under {MIN_VOICE_SECONDS}s; short answers are fine, but more
                    speech gives the clone more to work with.
                  </span>
                )}
              </p>
              <audio controls onLoadedMetadata={fixInfiniteDuration} src={preview.url} />
              <div className="btn-row">
                <button
                  className="btn-primary"
                  onClick={save}
                  disabled={phase === "saving"}
                >
                  {phase === "saving" ? "Saving…" : "Save answer"}
                </button>
                <button onClick={discardPreview} disabled={phase === "saving"}>
                  Discard & re-record
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TranscriptPanel({
  response,
  onUpdated,
}: {
  response: ResponseDTO;
  onUpdated: (r: ResponseDTO) => void;
}) {
  const [text, setText] = useState(response.transcript ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync in background-produced transcripts unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setText(response.transcript ?? "");
  }, [response.transcript, dirty]);

  async function saveEdit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/responses/${response.id}/transcript`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { response: updated } = await res.json();
      setDirty(false);
      onUpdated(updated);
    } catch (e) {
      setError(`Could not save edit: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/responses/${response.id}/retry`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { response: updated } = await res.json();
      onUpdated(updated);
    } catch (e) {
      setError(`Retry failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="section-label">Transcript</div>
      {response.transcriptStatus === "pending" && (
        <p className="muted small">Transcribing in the background… it will appear here.</p>
      )}
      {response.transcriptStatus === "failed" && (
        <p className="error">
          Transcription failed.{" "}
          <button onClick={retry} disabled={busy}>
            Retry
          </button>
        </p>
      )}
      {(response.transcriptStatus === "done" || response.transcript) && (
        <div>
          <textarea
            className="transcript"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn-primary" onClick={saveEdit} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save correction"}
            </button>
            <span className="muted small">
              {response.transcriptEditedByUser
                ? "Edited by you — treated as ground truth."
                : response.transcriptSource
                  ? `Engine: ${response.transcriptSource}`
                  : ""}
            </span>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Summary({
  session,
  questions,
  responses,
  onJump,
  onCompleted,
}: {
  session: SessionDTO;
  questions: QuestionDTO[];
  responses: Map<string, ResponseDTO>;
  onJump: (i: number) => void;
  onCompleted: (s: SessionDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answered = questions.filter((q) => isAnswered(responses.get(q.id)));
  const remaining = questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => !isAnswered(responses.get(q.id)));
  const voiceSecs = [...responses.values()].reduce(
    (sum, r) => sum + (r.audioPath ? r.audioDurationSec ?? 0 : 0),
    0
  );
  const voiceMin = voiceSecs / 60;
  const pendingTx = [...responses.values()].filter(
    (r) => r.transcriptStatus === "pending"
  ).length;

  async function completeSession() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${session.id}/complete`, { method: "POST" });
      if (res.ok) {
        const { session: updated } = await res.json();
        onCompleted(updated);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2>{session.status === "complete" ? "Session complete" : "Session overview"}</h2>
      <p>
        {answered.length} of {questions.length} answered.{" "}
        <span className={voiceMin >= 30 ? "ok" : "warn"}>
          {voiceMin.toFixed(1)} minutes of voice audio recorded
        </span>{" "}
        <span className="muted small">
          (30 min is the floor for professional voice cloning; 1–2 hours is ideal).
        </span>
      </p>
      {pendingTx > 0 && (
        <p className="muted small">{pendingTx} transcription(s) still running in the background.</p>
      )}

      {remaining.length > 0 && (
        <div>
          <p className="warn">Remaining ({remaining.length}):</p>
          <div className="index-grid">
            {remaining.map(({ q, i }) => (
              <button
                key={q.id}
                className={`index-cell ${responses.get(q.id)?.skipped ? "skipped" : ""}`}
                title={q.section}
                onClick={() => onJump(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 18 }}>
        {session.status !== "complete" && (
          <button className="btn-primary" onClick={completeSession} disabled={busy}>
            Mark session complete
          </button>
        )}
        <a href={`/api/sessions/${session.id}/export`}>
          <button>Download export (zip)</button>
        </a>
        <Link href="/">
          <button>Home</button>
        </Link>
      </div>
    </div>
  );
}
