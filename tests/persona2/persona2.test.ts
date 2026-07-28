import { test } from "node:test";
import assert from "node:assert/strict";
import { lintProposition } from "../../src/persona2/registerLint";
import { checkCopy, ngramSet, COPY_FLAG_NGRAM } from "../../src/persona2/copydetect";
import { routeIntent } from "../../src/persona2/gate";
import { selectExemplars, type ExemplarCandidate } from "../../src/persona2/exemplars";
import { computeModeFingerprint } from "../../src/persona2/fingerprint";
import { ratePer1k, tokenize } from "../../src/persona2/lexicon";

// 1. Register lint: propositions containing the subject's first-person
//    phrasing or distinctive collocations MUST fail.
test("register lint rejects first-person phrasing and distinctive collocations", () => {
  assert.equal(
    lintProposition("I always take the privacy hit over convenience.").ok,
    false,
    "first person must fail"
  );
  assert.equal(lintProposition("Sam, you know, prefers privacy.").ok, false, "second-person idiom must fail");
  assert.equal(lintProposition("Sam is, um, privacy-focused.").ok, false, "filler must fail");
  assert.equal(
    lintProposition("Sam takes blue sky thinking seriously.", ["blue sky thinking"]).ok,
    false,
    "distinctive collocation must fail"
  );
  const good = lintProposition(
    "Sam prioritizes privacy over convenience and accepts usability costs for it.",
    ["blue sky thinking"]
  );
  assert.equal(good.ok, true, `clean archivist register must pass: ${good.reasons.join(", ")}`);
});

// 2. 8-gram copy detector against a known-plagiarized reply.
test("copy detector flags 8-gram plagiarism and passes fresh composition", () => {
  const source =
    "honestly I would always take the privacy hit over the convenience because that is just how I think about these tradeoffs in my own life";
  const ngrams = ngramSet([source], COPY_FLAG_NGRAM);

  const plagiarized =
    "Well, honestly I would always take the privacy hit over the convenience, that's me.";
  const c1 = checkCopy(plagiarized, ngrams);
  assert.equal(c1.flagged, true, "verbatim 8+ word run must flag");
  assert.ok(c1.longestRun >= 8);

  const fresh =
    "Privacy wins for me every time, even when it costs some ease of use — that trade sits fine with my priorities.";
  assert.equal(checkCopy(fresh, ngrams).flagged, false, "fresh composition must not flag");
});

// 3. Gate routing for the three intents.
test("retrieval gate routes knowledge, explicit recall, and smalltalk", () => {
  assert.equal(routeIntent("How do you decide when to quit something?"), "knowledge");
  assert.equal(routeIntent("What's your take on remote work?"), "knowledge");
  assert.equal(routeIntent("What exactly did I say about my first computer?"), "explicit_recall");
  assert.equal(routeIntent("What did you say in your interview about respect?"), "explicit_recall");
  assert.equal(routeIntent("quote me what I wrote about Denver"), "explicit_recall");
  assert.equal(routeIntent("hey, how's it going?"), "smalltalk");
  assert.equal(routeIntent("thanks, that makes sense"), "smalltalk");
  assert.equal(routeIntent("nice"), "smalltalk");
});

// 4. Exemplar bank rejects on-topic passages (likelyAsked above threshold).
test("exemplar selection rejects on-topic passages and balances the bank", () => {
  const mk = (i: number, likelyAsked: number, style = 8, mode: "spoken" | "written" = i % 2 ? "spoken" : "written"): ExemplarCandidate => ({
    text: `passage number ${i} with enough words to stand in for a real exemplar candidate in this test`,
    mode,
    origin: `o${i}`,
    styleSignal: style,
    topic: `topic-${i}`,
    likelyAsked,
  });
  const candidates = [
    mk(1, 9), // on-topic: biography — must be rejected
    mk(2, 8), // on-topic: work opinions — must be rejected
    ...Array.from({ length: 14 }, (_, i) => mk(10 + i, 2)),
  ];
  const bank = selectExemplars(candidates);
  assert.ok(bank.length >= 8 && bank.length <= 12, `bank size ${bank.length}`);
  assert.ok(!bank.some((e) => e.text.includes("passage number 1 ")), "likelyAsked=9 rejected");
  assert.ok(!bank.some((e) => e.text.includes("passage number 2 ")), "likelyAsked=8 rejected");
  const spoken = bank.filter((e) => e.mode === "spoken").length;
  assert.ok(Math.abs(spoken - (bank.length - spoken)) <= 4, "modes roughly balanced");
});

// 5. Spoken-mode marker rates within tolerance (the calibration checker).
test("spoken fingerprint measures filler rates; ±30% tolerance check works", () => {
  // Synthetic spoken text with a known filler rate: "um" appears 5 times in 250 words = 20/1k.
  const words: string[] = [];
  for (let i = 0; i < 245; i++) words.push(`word${i % 40} and the of to a in that it is`.split(" ")[i % 10]);
  for (let i = 0; i < 5; i++) words.splice(i * 40, 0, "um");
  const text = words.join(" ") + ".";
  const fp = computeModeFingerprint("spoken", text, 0, []);
  const um = fp.fillerRates.find((f) => f.term === "um");
  assert.ok(um, "um measured");
  assert.ok(Math.abs(um!.per1k - 20) < 2, `um rate ~20/1k, got ${um!.per1k}`);

  // Generated text at 24/1k (within +30% of 20) passes; at 40/1k (caricature) fails.
  const genOk = Array.from({ length: 250 }, (_, i) => (i % 42 === 0 ? "um" : "word")).join(" ");
  const genBad = Array.from({ length: 250 }, (_, i) => (i % 10 === 0 ? "um" : "word")).join(" ");
  const rateOk = ratePer1k(tokenize(genOk), "um");
  const rateBad = ratePer1k(tokenize(genBad), "um");
  const within = (rate: number, target: number) => rate >= target * 0.7 && rate <= target * 1.3;
  assert.equal(within(rateOk, um!.per1k), true, `ok rate ${rateOk} within band`);
  assert.equal(within(rateBad, um!.per1k), false, `caricature rate ${rateBad} outside band`);
});
