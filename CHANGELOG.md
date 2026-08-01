# Changelog

## 0.1.0 — 2026-08-01

First public release.

- In-chat interview (4-module curriculum, voice-memo answers, Likert, skip/pause/resume, artifact invitations), with automatic base-persona build at the threshold.
- Persona synthesis: neutral-register proposition memory + measured style fingerprint + curated exemplars (the register firewall); sealed 8-question holdout with automatic post-interview benchmark and gap report.
- Improvement loop: next-turn corrections (hot notes), typed correction distillation, tiered reconciliation with human-gated identity changes, session memory (TTL + reset) vs permanent `remember this:`, coverage-gap solicitation, drift spot-checks, versioned re-synthesis with rollback.
- Enrichment: documents, writing samples, OpenAI + Claude chat exports (own words only, redaction at ingest), conversational delta reports.
- Tools: web search, page fetch, platform skills, permission-gated skill install (`ALTER_TOOL_INSTALL=allow`), on-demand voice.
- Voice: ElevenLabs clone via your own key (OGG/Opus voice notes, async, silent degrade); local voice optional with an honest parity caveat.
- Bootstrap from existing recordings; installer to passing health check; signed pack with SHA-256 checksums; personal-data and media scans that fail the build; pre-commit guard.
