"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewSessionForm() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [isTrial, setIsTrial] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!label.trim()) {
      setError("Give the session a label first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), isTrial }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { session } = await res.json();
      router.push(`/session/${session.id}`);
    } catch (e) {
      setError(`Could not create session: ${String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div>
      <input
        type="text"
        placeholder="Session label, e.g. Trial run July 19"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && start()}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={isTrial}
          onChange={(e) => setIsTrial(e.target.checked)}
        />
        Trial session (uses the 20-item Mini-IPIP)
      </label>
      <div className="btn-row">
        <button className="btn-primary" onClick={start} disabled={busy}>
          {busy ? "Starting…" : "Start session"}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
