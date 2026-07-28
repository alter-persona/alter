"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Improvement-loop playground: chat with the persona, correct any reply,
 * drop files as material, and review the loop's state (approvals,
 * clarification cards, reconciliation log, hot notes, scoreboard).
 * Natural language works everywhere; the affordances are accelerators.
 */

interface Msg {
  role: "user" | "assistant";
  content: string;
  eventId?: string;
  kind?: "chat" | "ack";
  correcting?: boolean;
}

interface Review {
  approvals: { id: string; kind: string; text: string }[];
  clarificationCards: { theme: string; cases: { id: string; question: string | null; oldText: string; newText: string; tier: string }[] }[];
  reconLog: { id: string; resolution: string | null; tier: string; oldText: string; newText: string; status: string }[];
  hotNotes: { id: string; note: string; pendingCaseId: string | null }[];
  scoreboard: { id: string; kind: string; metrics: Record<string, unknown>; runAt: string }[];
  resynthesis: {
    newChunksSinceResynth: number;
    correctionsSinceResynth: number;
    chunkThreshold: number;
    correctionThreshold: number;
    due: boolean;
    blockedByOpenCoreCase: boolean;
  };
}

const box: React.CSSProperties = { border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12, background: "#fff" };

export default function Playground() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [conversationId] = useState(() => `pg-${Date.now().toString(36)}`);
  const [correction, setCorrection] = useState<{ idx: number; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadReview = useCallback(async () => {
    const r = await fetch("/api/loop/review");
    if (r.ok) setReview(await r.json());
  }, []);

  useEffect(() => {
    void loadReview();
    const t = setInterval(loadReview, 15000);
    return () => clearInterval(t);
  }, [loadReview]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  async function send(message: string, opts: { replyToEventId?: string; intentHint?: string } = {}) {
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: message }]);
    try {
      const history = msgs.filter((m) => m.kind !== "ack").map((m) => ({ role: m.role, content: m.content }));
      const r = await fetch("/api/loop/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId, history, ...opts }),
      });
      const j = await r.json();
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: j.reply ?? j.error ?? "(no reply)", eventId: j.personaEventId, kind: j.kind },
      ]);
      void loadReview();
    } finally {
      setBusy(false);
    }
  }

  async function submitCorrection() {
    if (!correction) return;
    const target = msgs[correction.idx];
    setCorrection(null);
    await send(correction.text, { replyToEventId: target.eventId, intentHint: "correction" });
  }

  async function dropFiles(files: FileList) {
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("kind", "file");
      fd.append("channel", "playground");
      fd.append("conversationId", conversationId);
      fd.append("intentHint", "material");
      const r = await fetch("/api/loop/ingest", { method: "POST", body: fd });
      const j = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: j.ack ?? j.error ?? "received", kind: "ack" }]);
    }
    void loadReview();
  }

  async function reviewAction(body: Record<string, string>) {
    await fetch("/api/loop/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    void loadReview();
  }

  return (
    <main
      style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 20, maxWidth: 1200, margin: "0 auto", padding: 20 }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void dropFiles(e.dataTransfer.files);
      }}
    >
      {/* ── Chat column ── */}
      <section>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Persona playground</h1>
        <p style={{ color: "#666", fontSize: 13, marginBottom: 12 }}>
          Chat normally. Say “no, actually…” to correct, drop a file anywhere to add material, or use the ✎ affordance on any reply.
        </p>
        {dragOver && (
          <div style={{ ...box, borderStyle: "dashed", borderColor: "#4a90d9", textAlign: "center", color: "#4a90d9" }}>
            Drop to add as material
          </div>
        )}
        <div style={{ minHeight: 300, maxHeight: "60vh", overflowY: "auto", marginBottom: 12 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ marginBottom: 10, textAlign: m.role === "user" ? "right" : "left" }}>
              <div
                style={{
                  display: "inline-block",
                  maxWidth: "85%",
                  padding: "8px 12px",
                  borderRadius: 10,
                  whiteSpace: "pre-wrap",
                  background: m.role === "user" ? "#2b6cb0" : m.kind === "ack" ? "#f0f7ee" : "#f1f1f1",
                  color: m.role === "user" ? "#fff" : "#222",
                  fontStyle: m.kind === "ack" ? "italic" : undefined,
                  fontSize: 14,
                }}
              >
                {m.content}
              </div>
              {m.role === "assistant" && m.kind === "chat" && (
                <button
                  onClick={() => setCorrection({ idx: i, text: "" })}
                  title="Correct this reply"
                  style={{ marginLeft: 6, border: "none", background: "none", cursor: "pointer", color: "#999" }}
                >
                  ✎ correct
                </button>
              )}
              {correction?.idx === i && (
                <div style={{ marginTop: 6 }}>
                  <textarea
                    autoFocus
                    value={correction.text}
                    onChange={(e) => setCorrection({ idx: i, text: e.target.value })}
                    placeholder="How would you have said it / what's actually true?"
                    style={{ width: "100%", minHeight: 60, padding: 8, fontSize: 14 }}
                  />
                  <button onClick={submitCorrection} disabled={!correction.text.trim()}>
                    Send correction
                  </button>{" "}
                  <button onClick={() => setCorrection(null)}>Cancel</button>
                </div>
              )}
            </div>
          ))}
          {busy && <div style={{ color: "#999", fontSize: 13 }}>thinking…</div>}
          <div ref={bottomRef} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || busy) return;
            const v = input;
            setInput("");
            void send(v);
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message the persona…"
            style={{ flex: 1, padding: 10, fontSize: 15, border: "1px solid #ccc", borderRadius: 8 }}
          />
          <button type="submit" disabled={busy || !input.trim()} style={{ padding: "10px 18px" }}>
            Send
          </button>
          <label style={{ padding: "10px 12px", border: "1px dashed #aaa", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
            + file
            <input type="file" multiple hidden onChange={(e) => e.target.files && void dropFiles(e.target.files)} />
          </label>
        </form>
      </section>

      {/* ── Review panel ── */}
      <aside style={{ fontSize: 13 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Review panel</h2>

        {review?.resynthesis && (
          <div style={{ ...box, background: review.resynthesis.due ? "#fff8e6" : "#fff" }}>
            <strong>Re-synthesis</strong>
            <div>
              {review.resynthesis.newChunksSinceResynth}/{review.resynthesis.chunkThreshold} new chunks ·{" "}
              {review.resynthesis.correctionsSinceResynth}/{review.resynthesis.correctionThreshold} corrections
            </div>
            {review.resynthesis.due && !review.resynthesis.blockedByOpenCoreCase && (
              <div style={{ color: "#b7791f" }}>Due — run `npm run loop -- resynth`</div>
            )}
            {review.resynthesis.blockedByOpenCoreCase && (
              <div style={{ color: "#c53030" }}>Blocked: resolve the open core-identity clarification first.</div>
            )}
          </div>
        )}

        {(review?.hotNotes?.length ?? 0) > 0 && (
          <div style={box}>
            <strong>Hot notes (active)</strong>
            {review!.hotNotes.map((n) => (
              <div key={n.id} style={{ marginTop: 4 }}>
                • {n.note} {n.pendingCaseId && <em style={{ color: "#b7791f" }}>(reconciliation open)</em>}
              </div>
            ))}
          </div>
        )}

        {(review?.approvals?.length ?? 0) > 0 && (
          <div style={box}>
            <strong>Awaiting your approval</strong>
            {review!.approvals.map((a) => (
              <div key={a.id} style={{ marginTop: 6 }}>
                <div>
                  [{a.kind}] {a.text}
                </div>
                <button onClick={() => void reviewAction({ action: "approve", approvalId: a.id })}>Approve</button>{" "}
                <button onClick={() => void reviewAction({ action: "reject", approvalId: a.id })}>Reject</button>
              </div>
            ))}
          </div>
        )}

        {(review?.clarificationCards?.length ?? 0) > 0 && (
          <div style={box}>
            <strong>Clarification cards</strong>
            {review!.clarificationCards.map((card) => (
              <div key={card.theme} style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid #eee" }}>
                <em>{card.theme}</em>
                {card.cases.map((c) => (
                  <div key={c.id} style={{ marginTop: 4 }}>
                    <div>{c.question ?? `"${c.oldText}" vs "${c.newText}"`}</div>
                    <textarea
                      value={answers[c.id] ?? ""}
                      onChange={(e) => setAnswers((s) => ({ ...s, [c.id]: e.target.value }))}
                      placeholder="Your answer (scope it however is true)"
                      style={{ width: "100%", minHeight: 40, marginTop: 4, fontSize: 13 }}
                    />
                    <button
                      disabled={!answers[c.id]?.trim()}
                      onClick={() => void reviewAction({ action: "answer_card", caseId: c.id, answer: answers[c.id] })}
                    >
                      Resolve
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <div style={box}>
          <strong>Reconciliation log</strong>
          {(review?.reconLog ?? []).slice(0, 10).map((c) => (
            <div key={c.id} style={{ marginTop: 6, paddingTop: 4, borderTop: "1px solid #f3f3f3" }}>
              <span style={{ color: "#2b6cb0" }}>{c.resolution}</span> ({c.tier}, {c.status})
              <div style={{ color: "#777" }}>old: {c.oldText.slice(0, 90)}</div>
              <div style={{ color: "#777" }}>new: {c.newText.slice(0, 90)}</div>
            </div>
          ))}
          {(review?.reconLog?.length ?? 0) === 0 && <div style={{ color: "#999" }}>none yet</div>}
        </div>

        <div style={box}>
          <strong>Scoreboard</strong>
          {(review?.scoreboard ?? []).slice(0, 6).map((s) => (
            <div key={s.id} style={{ marginTop: 4 }}>
              {new Date(s.runAt).toISOString().slice(0, 10)} [{s.kind}] {JSON.stringify(s.metrics).slice(0, 120)}
            </div>
          ))}
          {(review?.scoreboard?.length ?? 0) === 0 && <div style={{ color: "#999" }}>no runs yet</div>}
        </div>
      </aside>
    </main>
  );
}
