# Changelog

## 0.2.0 — 2026-09-25

- Try it in five minutes: `npm run demo` answers as a synthetic sample persona (packs/sample/) on any OpenAI-compatible endpoint, with no database, whisper, or interview. The pack ships the sample.
- Bring your own tools: `ALTER_TOOLS_EXTENSION` names a module outside the repo that adds tools and prompt text to the persona; the built-in palette stays generic.
- Tool loop hardening: an empty model reply is reported instead of silence; the last-round prose nudge no longer leaks into replies.
- Persona core is pronoun-neutral.
- Sealed benchmark judges the persona's own sealed answers (previously any persona's), and takes generate, judge, and output-dir hooks.
- README describes the in-chat product: install lines per host (Hermes tap plus install, owner-qualified ClawHub slug, coding agents), any-model story, pack installer first, browser page as an appendix.
- Tests: 61 across five suites, adding the tool loop, extension point, send_voice_note, Ollama think-mode branch, archived-turn exclusion, interview flow, sealed benchmark, and the sample pack's register lint.
- RELEASE.md with a verification command per step; pre-commit hook enforces the owner's personal-data patterns.

## 0.1.0 — 2026-08-01

First public release.

- In-chat interview (4-module curriculum, voice-memo answers, Likert, skip/pause/resume, artifact invitations), with automatic base-persona build at the threshold.
- Persona synthesis: neutral-register proposition memory + measured style fingerprint + curated exemplars (the register firewall); sealed 8-question holdout with automatic post-interview benchmark and gap report.
- Improvement loop: next-turn corrections (hot notes), typed correction distillation, tiered reconciliation with human-gated identity changes, session memory (TTL + reset) vs permanent `remember this:`, coverage-gap solicitation, drift spot-checks, versioned re-synthesis with rollback.
- Enrichment: documents, writing samples, OpenAI + Claude chat exports (own words only, redaction at ingest), conversational delta reports.
- Tools: web search, page fetch, platform skills, permission-gated skill install (`ALTER_TOOL_INSTALL=allow`), on-demand voice.
- Voice: ElevenLabs clone via your own key (OGG/Opus voice notes, async, silent degrade); local voice optional with an honest parity caveat.
- Bootstrap from existing recordings; installer to passing health check; signed pack with SHA-256 checksums; personal-data and media scans that fail the build; pre-commit guard.
