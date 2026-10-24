---
source:
status: complete, evergreen
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
modified: 2026-10-20T14:08:11+01:00

---

# Lessons from the Incumbents — Comparison Doc v2

### Plugin autopsies informing Vault Overseer — finalized 2026-10-19

> [!abstract] Purpose
> Record of what three existing Obsidian plugins actually do, what they get wrong, and which Vault Overseer requirements they confirm, revise, or newly justify. Companion to the project definition note. Everything tagged by evidence strength — no inference presented as fact. **Supersedes Handoff Note 261019 and its addendum.**

## Evidence key

| Tag     | Meaning                                                |
| ------- | ------------------------------------------------------ |
| **[R]** | Read directly — file contents or repo source inspected |
| **[U]** | Reported by Dan — user-confirmed behaviour             |
| **[I]** | Inference — plausible, not yet verified                |
| **[?]** | Open question — needs code or experiment               |

---

## 1. Smart Second Brain (S2B)

Files inspected **[R]**: `manifest.json`, `data.json`, `startup-timings.json`, `pending-changes.json`

**What it is:** Ollama-backed chat/assistant over the vault, with an index of sorts and a broad tool surface.

**Findings**

- **Scattered model configuration** — model settings live in multiple places; changing "the model" is not one operation. **[R]**
- **Volatile runtime state in synced `data.json`** — routine operation causes settings churn that syncs. **[R]**
- **Inefficient batching** — batch size 2. Embedding throughput left on the floor. **[R]**
- **`pending-changes.json` in the plugin folder** — primitive event log. Precedent #1 for non-standard files under `.obsidian/plugins/`. **[R]**
- **Unconstrained toolset → hallucinated tools.** Models invent calls such as `execute_javascript`. Give a model a menu and it will order off-menu. **[R]**

**Relevance:** the cautionary tale for harness design. Its `pending-changes.json` is the accidental ancestor of our event log — proof the idea is natural, and proof nobody finished it.

---

## 2. vector-search

Files inspected **[R]**: `main.js`, `data.json`. `vectors.json` too large to upload (~1,279 chunks × 768 float64s, pretty-printed, tens of MB).

**What it is:** Semantic search over the vault. Ollama client, brute-force cosine scan.

**Findings — the anti-pattern seminar**

- **No task prefixes, anywhere.** Raw `{model, prompt}` posted to `/api/embeddings`. Semantic search running below model spec. **[R]**
- **Character-sliced chunking** — `chunkSize: 400`, `overlap: 50`, cuts mid-sentence and mid-word, no heading chain, no frontmatter awareness. **[R]**
- **Write amplification** — `JSON.stringify(all, null, 2)` of the entire store on every file modification. **[R]**
- **Rename = full re-embed.** Path remapping would suffice. **[R]**
- **Runtime state in `data.json`** (`lastIndexTime` / `lastIndexCount`) — settings churn on every edit. **[R]**
- **Silent degradation** — failed embedding → console log, chunk skipped; interrupted rebuild → permanent holes. No event log, counts, or checksums. **[R]**
- **No model fingerprint.** Swap models, mix vector spaces silently. **[R]**
- **`vectors.json` in the plugin folder** — precedent #2. **[R]**

**What it gets right (steal these)**

- Line-range recording for citation jumps; rename/delete event handling; Ollama health check with cached verdict invalidated on settings change; cancelable indexing preserving the prior index; "Use selection" button (seed of a related-notes UX); sensible defaults (threshold 0.5, top 10, 2s debounce).

---

## 3. Vault Curate — autopsy complete

**Sources this session [R]:** cloned repo `notoriouslab/vault-curate` @ `140548b` (v1.13.0), 16,982 lines of TypeScript across `src/`. Direct file reads: `chunker.ts`, `chunkPolicy.ts`, `schema.ts`, regions of `SQLiteStore.ts`, `description-generator.ts`, directory listings of all `src/` subsystems, plus README/CHANGELOG from the GitHub pages. This section replaces the handoff note's "unknowns" list — all four open questions are now answered.

### 3a. Architecture (verified)

- **Storage:** sql.js 1.14.1 (SQLite-to-WASM). Vectors hand-packed as BLOBs via `vecCodec`; normalized at read boundary. Schema v3: `notes` (path PK, mtime, title, description, tier, body_vec, desc_vec, indexed_at), `chunks` (note_path, chunk_index, content, vec, UNIQUE constraint), `meta` KV, `synonyms`. `index.sqlite` in the plugin folder — precedent #3 stands. **[R]**
- **Hybrid retrieval:** BM25 implemented in hand-written TypeScript because sql.js 1.14.1 ships without FTS5, fused with semantic search; weight tuning in `meta`. Description embeddings blend into note-level ranking vectors at alpha 0.5 (offline alpha-scan pick). **[R]**
- **Workers:** embedding and k-NN run off the main thread (`embeddingWorker.ts`, `knnWorker.ts`) — this retroactively explains the p-queue/concurrency/retry harness seen in the bundle fragment. **[R]**
- **Persistence:** debounced — flushes at 100 mutations or 30s idle, with revision tracking and a dispose-race-safe farewell write. Whole-DB export on flush, but bounded frequency. **[R]**
- **Migrations:** forward-only, idempotent, with downgrade guard and unknown-version normalization; orphan-chunk sweep self-heals the DB on every open. **[R]**
- **Heavy CJK investment:** traditional↔simplified conversion table (51KB `t2sTable.ts`), dedicated tokenizer, denoiser stripping template/bar-chart symbols from embedding input. **[R]**

### 3b. The four open questions — answered

- **Curation harness** — not recipe-constrained, not freewheeling-tools: a **single fixed prompt contract** requesting `{description, tags}` as JSON. Per-note, opt-in (command, file menu, or Discover sidebar); the v0.3.x scan-whole-vault pipeline was explicitly demoted in Phase 6. Denoised head-1200 + tail-800 sampling of the body (template-heavy notes put personal content at the end — head-only sampling made the LLM describe the template). Anti-title-echo retry. Tags merged additively, case-insensitively; refuses to overwrite structurally unusual tag values. Sets `title` only if missing. **[R]**
- **Prefix handling** — **deliberately none.** No `search_document:`/`search_query:` anywhere in 17k lines. Instead, each chunk is prefixed with the **note title** so BM25 and embedding both inherit title context from one mechanism. Legitimate counter-design, but retrieval quality then depends on descriptive note titling — an "Untitled" note poisons its own chunks in both lanes **[I]**. For Vault Overseer: task prefixes and title context are not mutually exclusive; we can do both.
- **Write path** — immediate write via `processFrontMatter()`, **no diff/preview gate** **[R]**. Debounced SQLite persistence means no per-edit write amplification — the earlier "vectors.json reborn in binary" inference **[I]** is refuted, though whole-DB export per flush still rewrites the full file at bounded intervals.
- **Chunking** — dual-path, stamped in the index via `chunk_policy`: token-budgeted chunks cut by the model's own tokenizer for the built-in WASM provider; configurable character-window splitting for Ollama/OpenAI-compatible providers **[R]**. For our Ollama stack, the incumbent still character-slices — R11 contrast stands, but honestly labeled: token-aware chunking exists in-tree for their built-in model only. Policy changes trigger a resumable, interruptible re-embed tracked with bounded retries (3 attempts).
- **Embedding endpoint (post-v2 verification)** — the Ollama provider posts to **`/api/embed` with `input: texts[]`** — the modern batched endpoint, not vector-search's deprecated single-prompt `/api/embeddings`. Batch size is decided one layer up (indexer/worker), so optimal batch sizing remains unverified **[I]**. Dimension is discovered at warmup by probing with a single embed of `"_"` (Ollama exposes no model metadata) — the same trick our R4 fingerprint will need. 90-second timeout with loud errors; Authorization header supported for reverse proxies. **[R]**
### 3c. Resolved mysteries and logged corrections

- **`ort-wasm-simd-threaded.wasm` mystery: RESOLVED.** It is the built-in embedding provider (`WasmEmbeddingProvider.ts`, model downloaded from Hugging Face or a custom mirror, ~110MB, tuned for Chinese/CJK). The earlier hard-Ollama picture was incomplete: Vault Curate ships **three embedding paths** — built-in WASM, Ollama, OpenAI-compatible. Our `data.json` shows Ollama selected locally, so the ort wasm is dormant, not dead weight. **[R]**
- **Correction:** earlier characterization of AI curation as "unadvertised, silent maintenance" — overturned. It is documented in the README's settings table (defaults off, `qwen3:1.7b`) and opt-in per note. What survives, with stronger evidence: the write is **ungated** — no diff preview before frontmatter mutation. **[R]**
- **`selfWrites` confirmed:** after each AI write, `recordSelfWrite(path, Date.now())` logs the file into a ledger living in synced `data.json` — preventing the plugin's own mtime bumps from re-heating notes in Hot/Cold tiering, while simultaneously perpetrating R8's settings churn. Direct edit behaviour fused into the settings file. **[R]**

---

## 4. Cross-cutting findings — updated

1. **Non-standard files in plugin folders are endemic.** `pending-changes.json` → `vectors.json` → `index.sqlite`. Three for three. Unchanged.
2. **None of the three survive a machine switch — mechanism now verified.** Obsidian Sync ferries only the canonical quartet (`manifest.json`, `main.js`, `styles.css`, `data.json`) from plugin folders; all other plugin-folder files are **structurally excluded** — silently, no error, no log entry, no retry. Confirmed four ways: toggle-semantics explanation [U], two clean full-detection passes with `vectors.json` invisible [R-log], and correctly-placed probe files ignored across forced-sync triggers [U]. Laptop's `vectors.json` is 28.0 MiB / 29,360,128 bytes and is a per-machine island. Bonus capture: `smart-second-brain/data.json` merge-conflicted, merged, and re-uploaded **twice in one minute** — R8's churn mechanism caught live [R-log].
3. **Task prefixes absent everywhere** — but with nuance now: vector-search neglects them; Vault Curate **chose** title-prefixing instead. Two of three by neglect, one of three by counter-design. R3 stands, but the comparison doc must argue *why* task prefixes beat title-only prefixing (or why we adopt both).
4. **Write amplification** — vector-search guilty, Vault Curate mitigated (debounced whole-file export). Not universal; still nobody writes incrementally.
5. **Nobody fingerprints their vectors.** Still true in all three — Vault Curate stamps chunk *policy* but not embedding-model provenance. R4 stands on all three.
6. **Failure logging** — revise: Vault Curate self-heals (orphan sweep, resumable upgrades, bounded retries, desc_vec backfill) but exposes no user-readable ledger, counts, or checksums. Two of three silent, one partially resilient.

---

## 5. Requirement updates

## 5. Requirement updates

| #   | Requirement                                                      | Status                                           | Rationale                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Index data in visible `_vault-index/`                            | **Amended 2026-10-19**                           | Split by durability: durable spine (`events.jsonl`, recipes) in visible vault; rebuildable derived caches (vectors, BM25, kNN) in plugin folder, which Obsidian Sync structurally excludes — no reliance on exclusion settings |
| R2  | `events.jsonl` synced source of truth; vectors local derivatives | **Confirmed**                                    | No incumbent survives a machine switch                                                                                                                                                                                         |
| R3  | `search_document:` / `search_query:` prefixes in code            | **Confirmed — nuanced**                          | Absent by neglect ×2, by counter-design ×1; must document superiority over title-prefixing                                                                                                                                     |
| R4  | Model fingerprint beside every vector                            | **Confirmed**                                    | Even the strongest incumbent omits it — VC's `modelId` is a namespace label, not a vector-space fingerprint                                                                                                                    |
| R5  | Append-only event log, counts, checksums, no silent skips        | **Confirmed — softened claim**                   | VC self-heals but has no user-visible ledger                                                                                                                                                                                   |
| R6  | Path remap on rename; never re-embed unchanged content           | **Confirmed**                                    | vector-search re-embeds on rename; VC rename behavior unexamined **[?]**                                                                                                                                                       |
| R7  | Batched embedding via `/api/embed`                               | **Confirmed — incumbent compliant, sizing open** | Vault Curate already uses `/api/embed` with array input [R]; our edge is batch-size tuning and fingerprint-aware dispatch [I]                                                                                                  |
| R8  | No volatile runtime state in `data.json`                         | **Confirmed ×3 — witnessed live**                | selfWrites ledger verified in source; S2B data.json merged and re-uploaded twice in one minute on the sync log [R-log]                                                                                                         |
| R9  | Skill recipes with enforced contracts, not broad tool menus      | **Confirmed**                                    | VC's fixed prompt sits between our two poles                                                                                                                                                                                   |
| R10 | Diff view before any LLM edit                                    | **Confirmed — headline differentiator**          | VC writes via processFrontMatter immediately, verified in source                                                                                                                                                               |
| R11 | Paragraph-level, heading-chained, frontmatter-stamped chunker    | **Confirmed — nuance**                           | Char-windows persist for Ollama/OpenAI paths; token chunking is built-in-model only                                                                                                                                            |
| R12 | Paste file regions, not whole bundles                            | **Promoted to doctrine**                         | Solved this session via repo clone — always check for source before dissecting bundles                                                                                                                                         |

---

## 6. Open questions

- **Resolved this session:** Latitude `vectors.json` check (28.0 MiB; per-machine island; exclusion structural, see §4.2). R7 (`/api/embed` verified, see §3b). ort-wasm mystery (§3c). Mobile-sync `[?]` sharpened: Vault Curate's `index.sqlite` cannot ride Obsidian Sync on our infrastructure — their "phones search desktop index" story requires manual file transport or a plugin-folder-wholesale sync.
- **`main.ts` region where `recordSelfWrite` persists** — exact write path into `data.json` **[I: mechanism inferred from ledger design; not yet read]**. Still open.
- **Write-class ruling for v1 skills** — unconditional diff gate vs. low-risk auto-apply carve-outs. Pending Dan's decision; see Tool & Skill Strategy note.

---

## 7. Next actions

1. Bank this doc; the handoff note and its addendum are fully absorbed — retire them.
2. Run the Latitude experiment when convenient.
3. One optional final paste (`OllamaEmbeddingProvider.ts`) to close R7, then the autopsy phase is **3 of 3, fully surveyed**.
4. Move to design phase of Vault Overseer against the R1–R12 table.

---

_Autopsy phase complete. The incumbent bar is higher than the anti-pattern seminar suggested — Vault Curate is a serious, measured, self-healing system. Our differentiators that survive honest scrutiny: the diff gate (R10), template contracts (R9→R10 spectrum), event-log spine (R2/R5), model fingerprinting (R4), and sync-free machine switching. Everything else must compete on merit._

---

Two honesty notes before you file this. First, the `qwen3.5:4b` curation model from your original user report is still tagged [U] — the repo README's default is `qwen3:1.7b`, and your local `data.json` governs what actually runs, so I left your report intact rather than overwrite it with the README default. Second, section 6's third item is flagged as inference — the `recordSelfWrite` call site is verified, but I never read the code that writes the ledger to disk, so don't let me present that mechanism as fact in any future session.

Upload this, cremate the handoff note with full honours, and we're officially out of the morgue and into the drawing office.

## Addendum

Two corrections filed, and the first one actually _improves_ the experiment's design.

**Both Mokka** means the Latitude isn't a platform variable at all — same distro, same Obsidian, same plugin version, just weaker silicon. So if the two `vectors.json` copies diverge, the cause can't be OS or packaging differences; it isolates cleanly to per-device runtime state. That's a tighter test than I assumed we had. Divergence → per-device index confirmed beyond argument. Identical → the whitelist theory takes real damage. Either way, no confounding variable to hedge about afterwards.

**On `isDesktopOnly`:** right, and thanks — it's a mobile-compatibility declaration, not an architecture confession. `true` means "won't run on phone/tablet," and Electron/Node APIs are merely the usual _reason_ something can't, not what the flag says. Good news for the paperwork: I trimmed that line out of Comparison Doc v2 during the rewrite, so there's nothing to patch — the retired handoff note was the only place carrying the sloppy phrasing.

But the correction does surface something worth a `[?]` tag. Vault Curate declares `isDesktopOnly: false`, and the README's claim is "desktop builds the index; phones and tablets search it." If a phone searches an index the desktop built, then `index.sqlite` has to _travel_ — a binary SQLite blob moving between devices. That's precisely the sync-hostile arrangement R1/R2 exist to avoid, and it would mean their machine-switch resilience depends on syncing a whole database file rather than deriving it locally. Plausible, unverified — I haven't read whatever handles mobile index transport. Want me to add it to the doc's open questions? It's a one-line append, and it's a genuinely juicy one: the strongest incumbent may be quietly betting on binary-blob sync.

Standing by for the `vectors.json` verdict.

> [!warning] Addendum supersession — 2026-10-19 late session
> The "whitelist theory" speculation above is resolved: the exclusion is **selective-sync coverage semantics**, not a size limit or hidden blocklist. Dan's configuration: "Sync plugins and settings" ON (covers `manifest.json`, `main.js`, `styles.css`, `data.json`), "Sync enabled plugins" OFF (per-device enablement). Non-canonical plugin files simply have no lane. All recommendations in the addendum follow from the corrected mechanism.



Absolutely — and it closes the autopsy phase properly. All four surviving `[I]`/`[?]` tags from the doc now land as `[R]`, plus the new design inputs that flow from them. Here's the amendment in your preferred unwrapped Obsidian format, ready to append to **Comparison Doc v2**:


---
## Final Session Addendum — 2026-10-20
### Autopsy phase closure: zero open [I]/[?], all requirements tagged with evidence
---

### New evidence landed (all [R])

**R6 — rename behaviour**  
`renameNote = removeNote(old) + indexSingleFile(new)` → full re-embed. Deliberate trade-off: "Cheaper would be row-level update, but renames are rare enough." Routes through `removeNote` to fire kNN-graph removal hook (014 D6#5).  
*Rationale amended:* not "trivially avoidable" — avoidance is real multi-table surgery; incumbent's choice is measured, not negligent.

**R7 — batch sizing**  
`EMBED_BATCH_SIZE = 8` (indexer.ts:45), used on both backfill and chunk loops. Confirms incumbent uses `/api/embed` with batching, but tuning unmeasured anywhere. S2B=2, vector-search=no-batch bracket from below. Our tuning edge stands.

**R8 — selfWrites ledger**  
Line map: definition=main.ts:108, record=1803, hydrate=1838, persist=1901/1911, prune=1812. Prunes per-call against `hotDays` window (bounded ledger). **Tumor inference REFUTED**. Persists via `saveSettings()` → whole-settings serialization into `data.json` on every call. Serialized via `saveQueue`.

**rationalized R8 rationale:** bounded, but fused into synced settings; batch callers are LLM-bound, so one saveData/file is "noise" locally — false across sync channel (merge-conflict observed twice in one minute). NaN-tamper guards on 7 settings fields (each with red-team finding) — the tax for runtime-state in editable JSON.

**Self-write ledger persistence [R]**  
Confirmed: rides inside `VaultSearchData` object to `data.json` via `saveData(migrated)`. Each self-write triggers prune + serialize-save cycle. Prune cutoff = `Date.now() - hotDays*24*60*60*1000`.

**qwen3.5:4b model [U]→[R]**  
`data.json:31` on both machines. Override rationale sound: avoids downloading 1.7b for single use case when 4b already available. Validates recipe model-fingerprint requirement (direction-aware warnings: oversupply OK, undersupply warned).

**Cross-device / mobile transport [R]**  
Mobile indexGate: size gate → open gate → deep-read probe (meta+chunks+notes). Transport = filesystem-level sync (iCloud). Binary-blob transport confirmed as *designed behaviour*. Invalid on Obsidian Sync by construction (excludes plugin-folder blobs). Rationale: incumbent assumes vault file layer is sync plane; we assume explicit spine in visible vault.

**Architecture map staleness [R]**  
Generated at 1.7.0 (a55861c); checkout is 1.13.0. Map lacks heat/subsystem, no RRF-era tiers. Docs rot calibration: even source-linked interactive diagrams stale with codebase movement. Evidence tag must include generation date.

---

### Autopsy phase status: COMPLETE

Autopsy phase: **3 of 3 incumbents surveyed. Zero open [I]/[?] attributable to Vault Curate.**  
All requirements R1-R12 have final evidence tags. Comparison Doc v2 now carries the complete autopsy record.

Handoff note 261019 + addendum: cleared for cremation with full honours.  
Next session opens in drawing office with event-log schema task (actor field, tier derivation, chunk-level fields, batching policy). Write-class ruling still pending Dan's decision.

---

### Design gifts extracted for Vault Overseer event-log schema

| Concept | Incumbent workaround | Our structural solution |
|---|---|---|
| Author attribution | ±2s mtime tolerance window, clamped Date.now(), retroactive absolution | **`actor` field (user \| plugin \| sync)** on every event. Attribution by record, not archaeology. |
| Tier/heat classification | Stored `notes.tier` column → refactored to query-time derivation (010 D5) but dual-code-path liability | Compute at read time from event log alone. No stored tier column needed. |
| Model fingerprinting | Global `meta.embedding_model_id` key only; per-vector fingerprinting absent | Fingerprint every event/vector with model hash. Swap detection by construction. |
| Mobile index transport | Binary blob syncs via file-layer, integrity gates for torn transfers | Text spine rides native sync channel. No blob, no tears, no gates. |
| Batch sizing | Fixed constant (8), never measured | Measure ourselves per hardware profile. Tuning claim stays justified. |
| Judgment vs exposure | User decision logged (2026-07-23): edit=judgment, open=exposure | Steal verbatim. Actor semantics encode the distinction. |

## Closure — 2026-10-24

> \[!warning] This document is CLOSED **Status: complete, archived, immutable.** The autopsy phase closed 2026-10-20 with zero open `[I]`/`[?]`; this closure on 2026-10-24 formalizes it. No further edits of any kind — including edits that would "bring it up to date." An autopsy record that keeps growing is a corruption of its own evidence discipline.

**What this document now is:** the frozen evidence base for R1–R12. Every requirement citation elsewhere in the doc family resolves to a finding here, tagged and dated. The R-numbers remain **live as citations** — they are load-bearing forever — while the document carrying them is **mutable never again.**

**Where living implications live:** Vault Overseer facts subsequent to 2026-10-20 (the origin ladder, dwell-gate ratification and extraction, rename wiring, F09/F05a certification, the subscriber-seam commitment, the folder-renamed design) deliberately do **not** appear here. They belong to the drawing office, and live in **Event Log Schema v0.2 (rev. 2026-10-24)**, **Event Log Fixture Corpus v0.1 (rev. 2026-10-24)**, **Chunker Spec v0.1 (rev. 2026-10-24)**, and **Architecture Map v0.3 (rev. 2026-10-24)** — the doc family's living documents. This is the morgue; those are the drawing office. No cross-contamination in either direction.

**One standing correction, ledgered rather than edited:** the two honesty notes in the body and the Final Session Addendum's verified line-map render several in-body `[I]` tags superseded by `[R]` evidence. Rather than surgically retag a sealed record, the correction is recorded here: where the body and the Final Session Addendum disagree on an evidence tag, **the addendum governs.** The addendum post-dates the body and closed the open questions it now answers.

Out of the morgue. The autopsy paid for the architecture; the architecture has shipped its spine.
