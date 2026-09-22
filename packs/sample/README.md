# Sample persona: Maren Holt

Maren Holt is invented. She is a retired lighthouse keeper from a fictional
North Atlantic island who restores valve radios, swims in the sea all year,
and distrusts anything with a subscription. Every fact, passage, and number
in this folder was written for this demo. No real person's data is here.

The folder holds exactly what a built persona pack holds, minus the vector
store:

- `persona-spec.json`: identity, ranked values, decision heuristics, and the
  measured style fingerprint (spoken and written).
- `propositions.json`: the persona's memory as third-person archivist
  propositions, typed fact, belief, preference, decision_heuristic,
  experience, story_summary, or insight. This is the register firewall in
  practice: memory never carries her own wording.
- `exemplars.json`: ten short passages in her voice, six spoken and four
  written, used only as a style reference at the end of the prompt.

Try her without installing anything but Node and a model endpoint:

```bash
npm install
npm run demo -- --message "Someone offers you a smart doorbell for free. What do you do with it?"
```

`npm run demo` talks to any OpenAI-compatible endpoint. It defaults to
`http://127.0.0.1:11434/v1` and the first model that endpoint lists; pass
`--url`, `--model`, and `--api-key` for anything else. Add `--dry-run` to
print the assembled prompt instead of calling a model.
