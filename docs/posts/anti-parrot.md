# Making a persona that does not parrot: a register firewall, measured

Draft for Show HN and r/LocalLLaMA. Not published. Every number below comes from a run recorded in this repo's validation harness, with the command and the model named beside it. Nothing here quotes the author's own interview answers.

## The problem

Alter builds a digital persona of one person from an interview, their documents, and their chat exports, and runs it on a local model. The first version did the obvious thing: chunk the person's words, embed the chunks, retrieve the closest ones, and put them in the prompt. It sounded like the person for exactly as long as it was reciting them. Ask something the corpus covered and you got the corpus back, sometimes a whole sentence verbatim. Ask something it did not cover and the voice collapsed into the base model's.

That is parroting, and it is worse than it looks, because it fails the two goals at once. Retrieved text is the person's wording, so the model copies it (no generalization). Retrieved text is also the only carrier of voice, so when nothing is retrieved there is no voice (no style). Memory and voice were the same substance.

## The fix: keep memory and voice in different registers

Version two separates them structurally, not with prompt instructions.

Memory is distilled at build time into short third-person propositions in an archivist's register, typed as fact, belief, preference, decision heuristic, experience, story summary, or insight, each with a strength and topics. A lint rejects any proposition containing first person, second-person idiom, spoken fillers, exclamations, or the person's own distinctive collocations before it can be embedded (`src/persona2/registerLint.ts`). Raw text is stored but never embedded, and reaches generation only as an attributed quote when the user explicitly asks what they said.

Voice is carried separately as a measured fingerprint: rates per thousand words for the person's distinctive markers, fillers, hedges, and intensifiers against a general-English baseline, sentence length statistics, clause openers, and punctuation habits, plus a bank of eight to twelve short exemplar passages chosen for high style signal and low chance of being an answer to anything (`src/persona2/fingerprint.ts`, `exemplars.ts`).

The prompt is position-disciplined. The persona core (identity, ranked values, decision heuristics, voice guide, marker table) is the stable system prefix. Memory notes sit in the middle under a header that says they are facts compiled by an archivist, not sentences to reuse. The response contract and the exemplars sit at the end, immediately before generation, so recency pulls imitation toward voice rather than toward notes (`src/persona2/prompt.ts`). A gate decides per message whether to retrieve at all: knowledge questions get up to four propositions, explicit-recall questions get attributed quotes, small talk gets nothing.

You can see the whole assembled prompt for a synthetic persona with no setup:

```bash
git clone https://github.com/alter-persona/alter.git && cd alter && npm install
npm run demo -- --dry-run --message "What do you do with old radios?"
```

## Measuring parroting

Two measurements, both in `src/persona2/validate.ts` and `copydetect.ts`.

Copy rate. Build the set of all 8-word sequences in the person's own text (every interview transcript and writing sample, spoken and written). For each generated reply, find the longest run of consecutive words that appears verbatim in that set. A reply is flagged if the run is eight words or longer. The copy flag rate is the share of flagged replies. For the v2 arm the same check also runs against the retrieved memory notes, and a reply is flagged if either source matches. Explicit-recall replies are exempt from flagging because quoting is their job; their runs still count toward the mean.

Burrows's Delta. The standard authorship distance over function-word frequencies, computed between all generated replies and all of the person's own text. Lower is closer. The target band is calibrated from the person's own writing: split their documents into two disjoint halves, measure the Delta between the halves (the self-distance), and require generated text to land within 1.5 times that.

The battery is twenty fixed questions: sixteen knowledge questions, two explicit-recall questions, and two small-talk lines, in a mix of spoken and written modes. Both arms answer every question with the same local model. The v1 arm uses the raw-chunk voice pack. The v2 arm uses the gate, retrieval, and the position-disciplined prompt.

## Results

### 26 July 2026, first A/B

Command: `npm run persona2 -- validate`. Model: the alias `local-small:latest`, which on that date resolved to a Qwen3.5 mixture-of-experts model (36B parameters, Q8_0) served by Ollama. Persona: the author's, built from a 70-answer interview. Report: `corpus/persona2/<persona>/ab-report.md`, generated 2026-07-26T22:37Z.

| Metric | v1 (raw chunks) | v2 (propositions + fingerprint) |
| --- | --- | --- |
| Copy flag rate (replies with an 8-word verbatim run) | 25% (5 of 20) | 0% (0 of 20) |
| Mean longest verbatim run, words | 2.4 | 9.9 |
| Burrows's Delta vs own text | 0.359 | 0.304 |
| Self-distance (calibration) | 0.077 | 0.077 |
| Delta within 1.5x self-distance | no | no |

Two honest notes on that table. The v2 mean run of 9.9 words is higher than v1's because the two explicit-recall replies quoted the archive at length, as designed, and those runs count in the mean while being exempt from the flag. Strip the two recall items and the v2 mean falls to the same order as v1's. And neither arm reached the Delta band: both were roughly four times the self-distance. The register firewall stopped the copying; it did not by itself make the function-word profile match the person.

### 22 September 2026, re-run on the current persona

Command: `npm run persona2 -- validate`, wall time 1,279 seconds. Model: GLM-5.3-Flash (MLX build, mixed 4/8-bit) served by a local OpenAI-compatible server that also answers the Ollama native route and ignores the alias name in the config, so both arms ran on it. Persona: the author's, rebuilt on 28 July from the same interview and grown to 154 propositions by the improvement loop. The v1 arm uses the raw-chunk pack built in July from that interview. Report: `corpus/persona2/<persona>/ab-report.md`, generated 2026-09-22T20:35Z.

| Metric | v1 (raw chunks) | v2 (propositions + fingerprint) |
| --- | --- | --- |
| Copy flag rate (replies with an 8-word verbatim run) | 75% (15 of 20) | 10% (2 of 20) |
| Mean longest verbatim run, all 20 replies, words | 10.3 | 6.5 |
| Mean longest verbatim run, 18 non-recall replies, words | 8.9 | 1.0 |
| Longest run in the two explicit-recall replies, words | 0 and 47 | 67 and 44 |
| Burrows's Delta vs own text | 0.257 | 0.326 |
| Self-distance (calibration) | 0.229 | 0.229 |
| Delta within 1.5x self-distance (0.344) | yes | yes |

Reading it plainly. The stronger model parrots raw chunks more, not less: v1 went from 25 percent flagged in July to 75 percent in September, and outside the recall questions its average longest verbatim run is nine words, which is over the flag line on average. v2 held at one word outside recall, and quoted at length inside recall, which is what the recall route is for. v2 still missed the 5 percent target on this run: two of twenty replies carried an 8-word run. Both arms landed inside the Delta band this time, and v1 is closer than v2, which is a reminder that Burrows's Delta rewards copying the person's function words as readily as it rewards sounding like them. Delta is a sanity check on drift, not a parroting detector. The self-distance moved from 0.077 to 0.229 between runs because the persona's own-text set is larger and more varied now; the band is recalibrated each run, so the two dates are not on the same scale.

The July and September rows are also not a like-for-like comparison of the encoding, because the model changed between them. The comparison that holds on both dates is the one inside each row: same model, same questions, same person, raw chunks versus the register firewall.

### Substance, not just style: the sealed benchmark

Copy rate says whether the persona recites. It says nothing about whether it answers the way the person would. For that, eight interview questions are sealed: their answers never enter the corpus, the vector store, or synthesis (a hash check enforces it, `src/understudy/sealedCheck.ts`). After the persona is built it answers those eight cold, and a judge model decides whether each answer takes the same substantive position as the person's real one, ignoring wording.

Command: `npm run alter -- evaluate sealed`. Persona generation: the runtime tool loop on GLM-5.3-Flash. Judge: the same model, with the instruction to judge substance only. Output: `eval/sealed-report.md`.

| Date | Agreement |
| --- | --- |
| 1 August 2026 | 0 of 6 judged |
| 22 September 2026 | 4 of 8 judged |

The August number is not comparable to September's. That run had a bug, fixed on 22 September (`src/understudy/evaluate.ts`): the evaluator took the most recent transcript for each sealed question from any persona in the database, and this machine had a test persona whose sealed answers were newer than the author's. At least part of the 0 of 6 was the persona being judged against someone else's answers. The September figure is the first clean measurement, and 4 of 8 is the honest state of substance fidelity: half the time the persona lands the same position, half the time it does not.

## What I take from it

- Separating register is what stops the copying, and it holds up under a stronger model. Same model, same questions, same person: raw chunks were flagged on 15 of 20 replies, the firewall on 2 of 20. It is structural: the lint runs before embedding and the exemplars live in the pack, never in the index. No prompt instruction did this.
- Copy rate and voice distance measure different things. Delta rewards copying; the firewall costs a little Delta while removing the copying. Report both, and do not let either stand in for the other.
- Substance fidelity is measurable only with sealed questions, and the measurement is only as good as the evaluator. Filtering by persona changed the number more than any model change did. 4 of 8 is where it stands.
- The demo persona in the repo is synthetic. All of the numbers above are from the author's own persona, which does not ship.

## Reproduce it

```bash
npm run persona2 -- validate        # copy rate, Delta, marker calibration, v1 vs v2
npm run alter -- evaluate sealed    # sealed benchmark and blind sheet
npm run demo -- --dry-run --message "…"   # the assembled prompt for the sample persona
```

The harness code is `src/persona2/validate.ts`, `copydetect.ts`, `delta.ts`, and `src/understudy/evaluate.ts`. Apache-2.0.
