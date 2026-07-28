"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SessionFileDTO {
  id: string;
  filename: string;
  sizeBytes: number;
  label: string;
  domain: string | null;
  sensitivity: "private" | "public";
  note: string | null;
  ingestStatus: "queued" | "running" | "embedded" | "failed";
  ingestError: string | null;
  createdAt: string;
}

interface PersonaStats {
  items: number;
  chunks: number;
  voiceMinutes: number;
  voiceFloorMinutes: number;
  pendingJobs: number;
}

type PendingStatus = "queued" | "uploading" | "failed";

interface PendingUpload {
  key: string;
  file: File;
  label: string;
  domain: string;
  sensitivity: "private" | "public";
  status: PendingStatus;
  error: string | null;
}

const ACCEPT = ".md,.txt,.pdf,.docx,.html,.htm,.eml,.zip";
const LABELS = ["writing-sample", "spec", "review", "bio", "other"];

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadge(s: string): { text: string; cls: string } {
  switch (s) {
    case "queued": return { text: "queued", cls: "muted" };
    case "uploading": return { text: "uploading…", cls: "muted" };
    case "running": return { text: "processing…", cls: "warn" };
    case "embedded": return { text: "embedded ✓", cls: "ok" };
    case "failed": return { text: "failed", cls: "error" };
    default: return { text: s, cls: "muted" };
  }
}

/**
 * Batch uploader: drop or pick many files at once; each uploads and ingests
 * independently (one bad file never fails the batch). Uploading a file IS
 * adding it to the persona's memory — the background job parses, redacts,
 * chunks, embeds into the pgvector index, and updates stylometry.
 */
export default function FilesPanel({ sessionId }: { sessionId: string }) {
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [files, setFiles] = useState<SessionFileDTO[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [stats, setStats] = useState<PersonaStats | null>(null);
  const [domains, setDomains] = useState<string[]>(["general"]);
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploadingAll, setUploadingAll] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/sessions/${sessionId}/files`, { cache: "no-store" });
    if (res.ok) setFiles((await res.json()).files);
  }, [sessionId]);

  const loadPersona = useCallback(async () => {
    const res = await fetch(`/api/personas`, { cache: "no-store" });
    if (!res.ok) return;
    const { personas } = await res.json();
    // The session's persona: resolved server-side on upload; for stats use the
    // session detail. Fetch it via the session payload.
    const sres = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" });
    if (!sres.ok) return;
    const pid = (await sres.json()).session?.personaId ?? personas[0]?.id ?? null;
    setPersonaId(pid);
    if (pid) {
      const [st, dm] = await Promise.all([
        fetch(`/api/personas/${pid}/stats`, { cache: "no-store" }),
        fetch(`/api/personas/${pid}/domains`, { cache: "no-store" }),
      ]);
      if (st.ok) setStats(await st.json());
      if (dm.ok) setDomains((await dm.json()).domains);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    void loadPersona();
  }, [load, loadPersona]);

  // Poll while anything is in flight.
  const anyActive =
    files.some((f) => f.ingestStatus === "queued" || f.ingestStatus === "running") ||
    (stats?.pendingJobs ?? 0) > 0;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => {
      void load();
      void loadPersona();
    }, 3000);
    return () => clearInterval(t);
  }, [anyActive, load, loadPersona]);

  function addFiles(list: FileList | File[]) {
    const rows: PendingUpload[] = [];
    for (const file of Array.from(list)) {
      rows.push({
        key: `p${keyCounter.current++}`,
        file,
        label: "other",
        domain: "general",
        sensitivity: "private",
        status: "queued",
        error: null,
      });
    }
    setPending((prev) => [...prev, ...rows]);
  }

  function updatePending(key: string, patch: Partial<PendingUpload>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  async function uploadOne(p: PendingUpload): Promise<boolean> {
    updatePending(p.key, { status: "uploading", error: null });
    try {
      const form = new FormData();
      form.append("file", p.file);
      form.append("label", p.label);
      form.append("domain", p.domain);
      form.append("sensitivity", p.sensitivity);
      const res = await fetch(`/api/sessions/${sessionId}/files`, { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPending((prev) => prev.filter((x) => x.key !== p.key));
      return true;
    } catch (e) {
      updatePending(p.key, {
        status: "failed",
        error: String(e instanceof Error ? e.message : e),
      });
      return false;
    }
  }

  async function uploadAll() {
    setUploadingAll(true);
    // Sequential so one large file doesn't starve the rest; each file's
    // failure is isolated.
    for (const p of pending.filter((x) => x.status !== "uploading")) {
      await uploadOne(p);
    }
    setUploadingAll(false);
    await load();
    await loadPersona();
  }

  async function retryFile(id: string) {
    await fetch(`/api/files/${id}/retry`, { method: "POST" });
    await load();
  }

  async function removeFile(id: string, filename: string) {
    if (!confirm(`Remove ${filename}?`)) return;
    await fetch(`/api/files/${id}`, { method: "DELETE" });
    await load();
  }

  async function buildSkill() {
    if (!personaId) return;
    setBuilding(true);
    setBuildMsg(null);
    try {
      const res = await fetch(`/api/personas/${personaId}/skill-build`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setBuildMsg(`Pack v${json.version} built → ${json.dir}`);
    } catch (e) {
      setBuildMsg(`Build refused: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBuilding(false);
    }
  }

  const floorMet = stats ? stats.voiceMinutes >= stats.voiceFloorMinutes : false;

  return (
    <section className="card" style={{ marginTop: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>
          Persona memory{" "}
          {stats && (
            <span className="muted small">
              {stats.items} items · {stats.chunks} chunks ·{" "}
              <span className={floorMet ? "ok" : "warn"}>
                {stats.voiceMinutes.toFixed(1)}/{stats.voiceFloorMinutes} voice min
              </span>
              {stats.pendingJobs > 0 && ` · ${stats.pendingJobs} job(s) running`}
            </span>
          )}
        </h2>
        <button onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</button>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8,
              padding: "26px 16px",
              textAlign: "center",
              cursor: "pointer",
              background: dragOver ? "#eef4fd" : "transparent",
              marginBottom: 14,
            }}
          >
            <b>Drop files here</b> or click to choose — you can select many at once.
            <div className="muted small">
              {ACCEPT} · zip = AI chat export · uploading adds them to this persona's memory
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {pending.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <table className="sessions">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Label</th>
                    <th>Domain</th>
                    <th>Sensitivity</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((p) => {
                    const b = statusBadge(p.status);
                    return (
                      <tr key={p.key}>
                        <td>
                          {p.file.name} <span className="muted small">({fmtSize(p.file.size)})</span>
                        </td>
                        <td>
                          <select
                            value={p.label}
                            onChange={(e) => updatePending(p.key, { label: e.target.value })}
                          >
                            {LABELS.map((l) => (
                              <option key={l} value={l}>{l}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={p.domain}
                            list="domain-suggestions"
                            style={{ width: 130 }}
                            onChange={(e) => updatePending(p.key, { domain: e.target.value })}
                          />
                        </td>
                        <td>
                          <select
                            value={p.sensitivity}
                            onChange={(e) =>
                              updatePending(p.key, {
                                sensitivity: e.target.value as "private" | "public",
                              })
                            }
                          >
                            <option value="private">private</option>
                            <option value="public">public</option>
                          </select>
                        </td>
                        <td>
                          <span className={b.cls}>{b.text}</span>
                          {p.error && <div className="error small">{p.error}</div>}
                        </td>
                        <td>
                          {p.status === "failed" && (
                            <button onClick={() => uploadOne(p)}>Retry</button>
                          )}{" "}
                          <button
                            onClick={() =>
                              setPending((prev) => prev.filter((x) => x.key !== p.key))
                            }
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <datalist id="domain-suggestions">
                {domains.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn-primary" onClick={uploadAll} disabled={uploadingAll}>
                  {uploadingAll ? "Uploading…" : `Upload ${pending.length} file(s)`}
                </button>
              </div>
            </div>
          )}

          {files.length > 0 && (
            <table className="sessions" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>Ingested file</th>
                  <th>Label</th>
                  <th>Domain</th>
                  <th>Sensitivity</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const b = statusBadge(f.ingestStatus);
                  return (
                    <tr key={f.id}>
                      <td>
                        {f.filename} <span className="muted small">({fmtSize(f.sizeBytes)})</span>
                      </td>
                      <td>{f.label}</td>
                      <td>{f.domain ?? "—"}</td>
                      <td>{f.sensitivity}</td>
                      <td>
                        <span className={b.cls}>{b.text}</span>
                        {f.ingestError && <div className="error small">{f.ingestError}</div>}
                      </td>
                      <td>
                        {f.ingestStatus === "failed" && (
                          <button onClick={() => retryFile(f.id)}>Retry</button>
                        )}{" "}
                        <button onClick={() => removeFile(f.id, f.filename)}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="btn-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <button className="btn-primary" onClick={buildSkill} disabled={building || !personaId}>
              {building ? "Building…" : "Build Skill pack"}
            </button>
            {buildMsg && (
              <span className={buildMsg.startsWith("Build refused") ? "error small" : "ok small"}>
                {buildMsg}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
