import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkDir } from "../../src/corpus/sources/work";
import { globToRegex } from "../../src/corpus/sources/work/manifest";
import { CorpusError } from "../../src/corpus/types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "corpus-work-"));
}

test("glob matching: *, **, ? semantics", () => {
  assert.ok(globToRegex("*.md").test("bio.md"));
  assert.ok(!globToRegex("*.md").test("sub/bio.md"));
  assert.ok(globToRegex("specs/**/*.pdf").test("specs/2026/q1/road.pdf"));
  assert.ok(globToRegex("**/*.txt").test("a/b/c.txt"));
  assert.ok(globToRegex("**/*.txt").test("c.txt")); // ** matches zero dirs
  assert.ok(globToRegex("file?.txt").test("file1.txt"));
  assert.ok(!globToRegex("file?.txt").test("file10.txt"));
});

test("work file without a manifest entry fails the run, naming the file", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "manifest.yaml"),
    `files:\n  - path: "covered.md"\n    label: writing-sample\n    domain: ai\n    sensitivity: public\n`
  );
  fs.writeFileSync(path.join(dir, "covered.md"), "This file is covered by the manifest.");
  fs.writeFileSync(path.join(dir, "orphan.md"), "This file has no manifest entry.");

  await assert.rejects(
    () => parseWorkDir(dir),
    (e: unknown) => {
      assert.ok(e instanceof CorpusError);
      assert.match(e.message, /orphan\.md/);
      assert.match(e.message, /no manifest\.yaml entry/);
      return true;
    }
  );
});

test("missing manifest.yaml fails with guidance when files exist", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "something.md"), "text");
  await assert.rejects(
    () => parseWorkDir(dir),
    (e: unknown) => e instanceof CorpusError && /manifest\.yaml is missing/.test(e.message)
  );
});

test("invalid sensitivity value is rejected", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "manifest.yaml"),
    `files:\n  - path: "a.md"\n    label: bio\n    domain: ai\n    sensitivity: internal\n`
  );
  fs.writeFileSync(path.join(dir, "a.md"), "text");
  await assert.rejects(
    () => parseWorkDir(dir),
    (e: unknown) => e instanceof CorpusError && /sensitivity must be/.test(e.message)
  );
});

test("manifest label/domain/sensitivity flow onto items; loaders extract text", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "manifest.yaml"),
    [
      "files:",
      '  - path: "bio.md"',
      "    label: bio",
      "    domain: product-management",
      "    sensitivity: public",
      '  - path: "notes/**"',
      "    label: writing-sample",
      "    domain: ai",
      "    sensitivity: private",
      "    note: raw notes",
    ].join("\n")
  );
  fs.writeFileSync(path.join(dir, "bio.md"), "A short professional bio used on conference pages.");
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(
    path.join(dir, "notes", "ideas.txt"),
    "Rough thinking about how the persona should answer product questions."
  );
  fs.writeFileSync(
    path.join(dir, "notes", "page.html"),
    "<html><head><style>p{}</style></head><body><p>Visible text only.</p><script>var x=1;</script></body></html>"
  );

  const result = await parseWorkDir(dir);
  assert.equal(result.items.length, 3);

  const bio = result.items.find((i) => i.origin.endsWith("bio.md"))!;
  assert.equal(bio.label, "bio");
  assert.equal(bio.domain, "product-management");
  assert.equal(bio.sensitivity, "public");

  const html = result.items.find((i) => i.origin.endsWith("page.html"))!;
  assert.ok(html.text.includes("Visible text only."));
  assert.ok(!html.text.includes("var x=1"), "script content stripped");
  assert.equal(html.sensitivity, "private");
});

test("unsupported extension is skipped with reason, not fatal", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "manifest.yaml"),
    `files:\n  - path: "**"\n    label: misc\n    domain: ai\n    sensitivity: private\n`
  );
  fs.writeFileSync(path.join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await parseWorkDir(dir);
  assert.equal(result.items.length, 0);
  assert.equal(result.skippedFiles.length, 1);
  assert.match(result.skippedFiles[0].reason, /unsupported extension/);
});
