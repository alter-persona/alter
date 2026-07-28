import Link from "next/link";
import { prisma } from "@/lib/db";
import NewSessionForm from "./NewSessionForm";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [sessions, totalQuestions] = await Promise.all([
    prisma.session.findMany({
      orderBy: { startedAt: "desc" },
      include: {
        responses: { select: { skipped: true, audioPath: true, likertValue: true } },
      },
    }),
    prisma.question.count(),
  ]);

  return (
    <main>
      <h1>Voice Personality Intake</h1>
      <p className="muted">
        Everything stays on this machine: audio, transcripts, and answers are
        saved locally the moment you record them.
      </p>

      <div className="card" style={{ borderColor: "var(--accent)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>🎙 Talk to your persona</b>
            <div className="muted small">
              Live voice conversation test — it listens, thinks, and answers in
              your cloned voice.
            </div>
          </div>
          <Link href="/talk">
            <button className="btn-primary">Start talking</button>
          </Link>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <div>
            <b>🔁 Improvement playground</b>
            <div className="muted small">
              Chat, correct replies, drop files as material — the persona learns
              from every conversation. Review panel included.
            </div>
          </div>
          <Link href="/playground">
            <button className="btn-primary">Open playground</button>
          </Link>
        </div>
      </div>

      {totalQuestions === 0 && (
        <div className="note">
          No questions are loaded yet. Place <code>voice-personality-intake.md</code> in
          the project root and run <code>npm run db:seed</code>.
        </div>
      )}

      <div className="card">
        <h2>Start a new session</h2>
        <NewSessionForm />
      </div>

      <div className="card">
        <h2>Resume a session</h2>
        {sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <table className="sessions">
            <thead>
              <tr>
                <th>Label</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const answered = s.responses.filter(
                  (r) => !r.skipped && (r.audioPath !== null || r.likertValue !== null)
                ).length;
                return (
                  <tr key={s.id}>
                    <td>
                      {s.label}
                      {s.isTrial && <span className="muted"> (trial)</span>}
                    </td>
                    <td>
                      {answered} / {totalQuestions}
                    </td>
                    <td>{s.status === "complete" ? "Complete" : "In progress"}</td>
                    <td className="muted">
                      {s.startedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td>
                      <Link href={`/session/${s.id}`}>
                        {s.status === "complete" ? "Review" : "Resume"}
                      </Link>
                      {" · "}
                      <a href={`/api/sessions/${s.id}/export`}>Export</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
