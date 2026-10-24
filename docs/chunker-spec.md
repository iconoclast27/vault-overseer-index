---
source:
status: pending
para:
context:
description:
Topics:
Concepts:
Meeting notes:
Permanent: false
type: note
word_count: 1
language: en
updated:
modified: 2026-10-24T18:07:56+01:00
---
---
# Vault Overseer — Chunker Spec v0.1 (rev. 2026-10-24)

> [!abstract] Purpose Defines R11: the paragraph-level, heading-chained, frontmatter-stamped chunker, its output contract against the event log, and the property tests + hostile fixtures that prove it. Produces the `bs`/`be`/`vh`/`cp` world the log records. Companion to Event Log Schema v0.2 (rev. 2026-10-24), Project Definition File, and the Log Fixture Corpus v0.1 (rev. 2026-10-24).

## Design principles

1. **The killer invariant** — byte offsets recorded in the log must always reproduce the chunk text from the note file. If the offsets can't re-derive the bytes that produced the embedding, the citation-jump feature is fiction and dedupe is fraud. Everything else is negotiable furniture.
2. **Determinism is transitive.** Same note bytes + same `cp` ⇒ same chunks ⇒ same `vh`, **on both machines, every time**. F04's cross-origin dedupe bait only works if this holds absolutely — no locale, no timezone, no `Math.random`, no iteration-order luck.
3. **The unit is the paragraph.** Character windows are the incumbents' crime (vector-search, and VC's Ollama path); we cut on document structure, then fit budgets.
4. **Heading chains travel with the chunk** — a chunk knows which `## Subsection` under which `# Heading` it lives in. This is what makes search results and citations legible without path context.
5. **Frontmatter is stamped, not skipped.** Existing metadata (tags, aliases, type) contextualizes the chunk for embedding; it is never part of the chunk body or the byte offsets.

## Input contract

The chunker consumes **raw file bytes** (UTF-8 decoded once, with BOM stripped and recorded — hostile fixture territory) and outputs a list of chunks. It never consumes Obsidian's parsed AST at chunk time; the file is the ground truth, and the file is what the offsets will later read.

Line endings: the chunker normalizes **nothing**. `bs`/`be` are offsets into the file _as stored_. CRLF vaults produce CRLF-straddling offsets; the reader reproduces them faithfully. (Consequence flagged for the log: `vh` covers the exact prefixed string sent to the embedder — so CRLF vs LF yields different `vh`s, correctly, because the embedder sees different text. Cross-machine line-ending flip by an editor is a real content change and gets re-embedded. That's honest, not wasteful.)

## Chunk assembly

**Step 1 — Frontmatter partition.** Split YAML delimiters from body. Extract a compact `fm_context` object: selected keys only — `type`, `tags`, `aliases`, `description` — serialized in canonical form (sorted keys, single line). Unknown keys ignored, not fatal.

**Step 2 — Paragraph segmentation.** Body split on blank-line runs (≥2 consecutive newlines define a paragraph boundary). Tables and fenced code blocks are atomic paragraphs — never split mid-table, mid-fence. A fence's content is one paragraph no matter how long; oversized handling in Step 4.

**Step 3 — Heading chain attach.** Track `H1→…→H-current` while walking. Each paragraph carries its chain. Chains reset on frontmatter boundary only (document-level), not per-section.

**Step 4 — Budget fitting.** Target ~512 tokens, hard ceiling ~768 (approximation: 4 bytes/token heuristic for Latin, refined for CJK at 2 bytes/token — Latin-1... no; honestly, at v1 we use a byte budget of 2048/3072 respectively as proxy, which for `nomic-embed-text`'s 8192 context is comfortably conservative; token-exact fitting is a `cp` bump later if measurement says so). Behaviors:

- Small adjacent paragraphs under target **merge** into one chunk (up to target)
- A single paragraph over the hard ceiling splits at sentence boundaries; a sentence over the ceiling splits at word boundaries; a word over the ceiling... fixture tells us what honest behavior is (truncate-with-log vs. carve-with-remainder — parked decision below)
- Chunks do **not** span heading boundaries: a new `##` closes the current chunk even under target. Heading chains would blur otherwise.

**Step 5 — Offset capture.** Each chunk records `bs`/`be` — first byte of its first paragraph to last byte of its last, **inclusive-exclusive** (`[bs, be)`, the convention every sane byte-range API uses; stated here because it's the kind of unstated assumption that kills off-by-one for a decade).

**Step 6 — vh computation.** `vh = sha256(prefix || chain || fm_context || chunk_text)` — the _exact_ string built for the embedder, in the exact serialization the embed path uses. This means the chunker and embedder share one `renderEmbedInput(chunk)` function; two implementations would be two drift opportunities (VC's lesson generalized).

**Prefix:** `search_document:` per R3 and the Project Definition's locked prefix decision. Query-side gets `search_query:` — same render function, different flag. Title/context prefixing (VC's counter-design) is _additive_: chain and fm_context already carry the context; the R3 argument is thereby satisfied as both, at one mechanism.

## Output contract (into the log)

Per chunk: `{ path, ord, bs, be, vh, cp }` — metadata only, per the ratified ruling. The chunker owns `cp`; the log never interprets it. `cp` bumps on any behavioral change to Steps 1–6, including approximation-constant changes.

> [!note] Revision 2026-10-24 — implementation status (undocumented until now)
> **Deployed production chunker: `chunkNote` at cp: 2** — file `src/chunker/chunker.ts`; C-suite (C01–C06) and property harness (P1–P6, 2000-doc seeded corpus) both green in the 2026-10-24 baseline. **A second chunker-shaped implementation exists: `src/chunker/stub.ts` at cp: 0** — a deliberately dumb deterministic splitter ("dead code walking," by its own header) used by the F03 fixture world for chunk arithmetic and by the current heal scan for re-derivation. It is not a placeholder for the production chunker; it is a fixture-grade oracle. **Registered debt** (Corpus F03, 2026-10-24): production heal must migrate from the stub to `chunkNote` before mixed-`cp` shards exist. The stub retires with that migration. A spec reader should know there are two implementations and which one is truth.

## Properties (fast, every commit)

**P1 — Offsets reproduce text.** ∀ chunks: `renderChunk(note_bytes, bs, be) === chunk_text` for a generated corpus of thousands of randomized documents (seeded generator: random headings, paragraphs, tables, code fences, CJK runs, emoji, 0-byte files, BOM cases, lone-newline tails, degenerate frontmatter).

**P2 — Partition.** Chunks are ordered, non-overlapping, and jointly cover the entire body (offsets sorted; `be[i] == bs[i+1] _within_ a chunk's internal paragraph merges; gaps only where the assembler legitimately declines whitespace runs). Stated crisply: every body byte is claimed by exactly one chunk or by no-chunk-under-a-declared-rule, and the rule list is enumerated in the implementation docs.

**P3 — Determinism.** Same bytes + same `cp` ⇒ identical chunk list, bit-for-bit, run-to-run and machine-to-machine (this test runs twice with different env seeds; also the property F04 silently relies on).

**P4 — Atomicity.** No chunk straddles a fence delimiter, a table row block, or a heading line. Property tested by generator documents containing pathological adjacencies (heading immediately followed by EOF, fence never closed, etc.).

**P5 — Chain correctness.** Random walks over generated heading trees assert every chunk's chain equals the DOM-walk ground truth computed independently (naive re-parser in the test, not the production parser — two implementations agreeing is the test).

**P6 — Idempotent vh.** Rendering twice yields the same `vh`; rendering with reordered-but-equivalent frontmatter keys is _deliberately different_ `vh` only if serialization changes bytes — i.e., test that `serialize(fm_context)` itself is canonical: sorted keys, stable separators.

## Fixtures (slow suite, with the log harness)

**C01 — Over-ceiling monolith.** 50KB single paragraph, no sentence boundaries in the middle (ransom-note garbage Latin). Assert: splits at declared boundaries, every emitted chunk ≤ ceiling, log records the carve, no crash.

**C02 — Closed-then-unclosed fence.** ` ``` ` opened, closed, opened, never closed, EOF. Chunker must treat trailing unclosed fence content as one atomic paragraph (fixture defines the rule; rule must exist).

**C03 — BOM + CRLF + leading-headings edge.** U+FEFF, CRLF throughout, `#` heading at byte 3. P1 must survive; `bs`/`be` math with BOM present must be byte-accounted, not decoded-string-index math (the classic trap: JS string indices ≠ UTF-8 byte offsets; offsets computed on the decoded string and applied to the file will be off by every non-ASCII char before them).

**C04 — Heading with no content.** Seven consecutive headings, no paragraphs between. Zero-length chunks must never be emitted; ord sequence stays dense.

**C05 — Frontmatter degeneracies.** Missing colons, duplicate keys, tabs, `---` inside a YAML value, empty frontmatter (`---\n---`). Parsing degrades to "no fm_context," never throws.

**C06 — Renamed-not-modified.** Same bytes at a new path: identical `vh`s (already F05's premise — this is the cheap fast-loop canary for it).

> [!note] Revision 2026-10-24 — C06 cross-reference
> F05's premise is now certified fact: F05a shipped 2026-10-24 (rename wiring, gate semantics — 26 checks green), and the spine carries `note.renamed` at Tier 1. C06 remains the fast-loop canary for `vh` path-independence. C05 additionally pins the five ratified fm degeneracy variants (superseding the spec's blanket criterion, per the csuite receipt).

## Parked decisions

1. **Over-ceiling single word** — truncate-with-`log.integrity` vs. carve-anyway. My lean: carve-anyway (never lose text), but it's a real judgment call about embedding quality.
   > [!note] Revision 2026-10-24 — likely settled de facto, confirm before folding
   > The spec's own invariants constrain the answer: C01's pass criteria demand every emitted chunk ≤ ceiling, and P1/P2 jointly demand that all body bytes are claimed or declined under an enumerated rule. Truncate-with-loss satisfies both only if the loss is a *declared* no-chunk rule; otherwise the only legal behavior is carve-anyway. The property corpus (2000 docs, seeded, green) plausibly generates over-ceiling words, which would make carve-anyway the tested truth already. **Confirm before folding into the spec body:** check what `chunkNote` actually does with an over-ceiling single word — one code check (`rg -n "carve|ceiling" src/chunker/chunker.ts` and read the terminal-split branch) settles it. Fold the ruling at that touch; don't re-litigate at the next `cp` bump.

2. **Token-exact budgeting** — v1 uses byte proxy per above; measure first, bump `cp` later.
3. **List-item clustering** — markdown lists as one paragraph (current: yes, blank-line-separated). Obsidian callouts (`> [!note]` blocks) treated as atomic — defaulted to atomic; revisit if fixtures show pathological lengths.

---

_Footer: v0.1, 2026-10-20; revised 2026-10-24. The revision adds implementation-status documentation only — the production chunker's deployed `cp` and the stub's existence and role, the C05 ratification note, C06's F05a cross-reference, and the near-settlement of parked decision #1 pending one code check. No design principle, contract, property, or fixture requirement was altered. Companion references updated to the 2026-10-24 revisions of the Schema and Fixture Corpus._
