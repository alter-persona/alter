"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Pair {
  idx: number;
  register: string;
  a: string;
  b: string;
}

/**
 * Blind A/B listening test: two renders of the same sentence, randomized
 * order. Pick which sounds more like the real person. Neither the page nor
 * the listener knows which side is which — blinding resolves server-side.
 */
export default function VoiceAbPage() {
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [listener, setListener] = useState("");
  const [i, setI] = useState(0);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    fetch("/api/voice-ab")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setPairs(j.pairs);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function pick(choice: "A" | "B" | "cannot_tell") {
    const pair = pairs[i];
    await fetch("/api/voice-ab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listener, sentenceIdx: pair.idx, pick: choice }),
    });
    setDone((d) => d + 1);
    setI((x) => x + 1);
  }

  if (error) {
    return (
      <main>
        <h1>Voice A/B</h1>
        <p className="warn">{error}</p>
        <Link href="/">Home</Link>
      </main>
    );
  }

  const finished = started && i >= pairs.length;

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Which sounds more like him?</h1>
        <Link href="/" className="small">Home</Link>
      </div>

      {!started ? (
        <div className="card">
          <p>
            You&apos;ll hear {pairs.length} pairs of clips — the same sentence spoken
            twice. Pick whichever sounds more like the real person. There&apos;s no
            trick: one is a hosted voice clone, one is a locally trained one, in
            random order each pair.
          </p>
          <div className="btn-row">
            <input
              type="text"
              placeholder="Your name"
              value={listener}
              onChange={(e) => setListener(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button className="btn-primary" disabled={!listener.trim() || pairs.length === 0} onClick={() => setStarted(true)}>
              Start
            </button>
          </div>
        </div>
      ) : finished ? (
        <div className="card">
          <h2>Done — thank you</h2>
          <p>{done} judgments recorded for {listener}.</p>
        </div>
      ) : (
        <div className="card">
          <p className="muted small">
            Pair {i + 1} of {pairs.length} · {pairs[i].register}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            {(["a", "b"] as const).map((side) => (
              <div key={side} style={{ textAlign: "center" }}>
                <b>{side.toUpperCase()}</b>
                <audio controls src={`/api/voice-ab?audio=${encodeURIComponent(pairs[i][side])}`} style={{ width: "100%" }} />
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => pick("A")}>A sounds more like him</button>
            <button className="btn-primary" onClick={() => pick("B")}>B sounds more like him</button>
            <button onClick={() => pick("cannot_tell")}>Cannot tell</button>
          </div>
        </div>
      )}
    </main>
  );
}
