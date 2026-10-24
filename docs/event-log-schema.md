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
modified: 2026-10-24T17:06:53+01:00
---
---

# Vault Overseer — Event Log Schema v0.2 (rev. 2026-10-24)

> [!abstract] Purpose Defines Layer 0: the append-only, per-origin JSONL spine in `_vault-index/events/`. The log is the synced source of truth; every projection (FTS, link graph, vectors) is a per-device derivative, rebuildable from it. Supersedes Schema v0.1 and its addendum rulings of 2026-10-20; revised same day to fold in the Chunker Spec coupling (version unchanged — conventions made explicit, no behavior altered). Revised 2026-10-24 to reflect dwell-gate ratification (0.1.2–0.1.4), rename wiring (0.1.5), and checkpoint cadence verification. Companion to Project Definition File, Architecture Map v0.3, Tool & Skill Strategy, Chunker Spec v0.1, and Event Log Fixture Corpus v0.1.

## Design principles

1. **Human-readable in micro** — one event per line, stable field order, meaningful key names. `rg '"type":"note.renamed"'` works as an ad-hoc query language.
2. **Everything is attributable** — the `actor` field replaces VC's ±2s mtime-archaeology with attribution by record.
3. **Nothing is silently lost** — per-origin sequence numbers, checkpoint digests, and loud gap alarms (R5).
4. **Cheap by construction** — rename never re-embeds (R6); identical embedding inputs share one vector-hash (R7 dedupe).
5. **Durability is classified, not uniform** — safety-critical events are write-through; bulk events are buffered and healable.
6. **The spine stores metadata, never content** — chunk text and note bodies re-derive from the vault's synced files themselves. The spine is a recipe, not a warehouse.

## File layout — per-origin shards

```
_vault-index/
  events/
    Desktop.jsonl
    Latitude.jsonl
  recipes/
  skills/          (user overrides per Tool & Skill Strategy)
```

One writer per file: each machine appends only to its own shard, named by the per-device `origin` id held in Zone 3 settings. **Sync conflicts are eliminated by construction** — the spine can never merge-conflict with itself, which is the lesson Obsidian Sync taught us live (S2B's `data.json`, twice in one minute).

Read access is a merge-scan across shards ordered by `(origin, seq)`. **Global `ts` is never trusted for ordering** — clock skew between Mokka and the Latitude is real. Timestamps are display and diagnostic data only.

Plugin 2 never writes the log directly. It appends via Plugin 1's exposed `appendEvent()` API, preserving single-writer-per-shard and sharing Plugin 1's sequence counter — consistent with the existing "Plugin 2 consumes Plugin 1's API" seam.

Startup guard: a shard whose last line carries a foreign `origin` value is rejected loudly (`log.integrity`) before any append — misconfigured duplicate ids fail safe, not silently.

## The envelope

Every line is one JSON object; keys in this exact order:

|Key|Type|Meaning|
|---|---|---|
|`v`|int|Schema version. Currently `1`. Forward-only migrations.|
|`seq`|int|Monotonic per-origin sequence. Gaps are alarms, not trivia.|
|`ts`|ISO 8601 with offset|Origin-local wall clock. Diagnostic only.|
|`origin`|string|Device id (`Desktop`, `Latitude`).|
|`actor`|enum|`user` \| `plugin` \| `sync`. Attribution by record, not archaeology.|
|`type`|string|Dot-namespaced, greppable (catalog below).|
|…payload|—|Type-specific fields, fixed order per type.|

Paths are vault-relative, POSIX separators, no leading slash. Example lines (whitespace here for readability; real lines are compact):

```json
{"v":1,"seq":10417,"ts":"2026-10-20T21:04:11+01:00","origin":"Desktop","actor":"user","type":"note.modified","path":"Projects/Vault Overseer/Notes/foo.md","mtime":1763000000000,"bytes":1421,"content_sha":"e3b0c4…81f9"}
{"v":1,"seq":10418,"ts":"2026-10-20T21:04:11+01:00","origin":"Desktop","actor":"plugin","type":"chunk.indexed","path":"Projects/Vault Overseer/Notes/foo.md","ord":0,"bs":0,"be":512,"vh":"9f86d0…d440","cp":3}
{"v":1,"seq":10419,"ts":"2026-10-20T21:05:02+01:00","origin":"Desktop","actor":"plugin","type":"embed.batch","fp":"ollama/nomic-embed-text:1.5/d768/docquery/cp3#a1b2c3d4","count":64,"ok":63,"failed":1,"ms":1830,"batch":16}
{"v":1,"seq":10420,"ts":"2026-10-20T21:06:47+01:00","origin":"Desktop","actor":"user","type":"write.applied","path":"Journal/2026-10-20.md","field":"description","before":null,"after":"Weekly sync ritual…","class":"auto","recipe":"set-description","mfp":"qwen3.5:4b"}
{"v":1,"seq":10421,"ts":"2026-10-20T21:40:03+01:00","origin":"Desktop","actor":"user","type":"note.opened","path":"Journal/2026-10-20.md","dwell":10}
```

## Offset conventions — `bs`/`be`

The schema's most off-by-one-prone contract, stated once, here:

- Offsets are **raw UTF-8 byte positions into the file as stored** — never decoded-string indices (JS string positions ≠ byte positions for any non-ASCII content; a BOM occupies bytes 0–2 and is accounted, not imagined away).
- Range is **inclusive-exclusive**: `[bs, be)` — the chunk text is `file_bytes.slice(bs, be)` exactly.
- **Nothing is normalized.** CRLF vaults produce offsets straddling `\r`; the reader reproduces them faithfully. A line-ending flip by an editor is a genuine content change (different `vh`, re-embed) — honest, not wasteful.
- Authority: the Chunker Spec v0.1 defines how chunks are produced; this schema defines what the log guarantees about recording them. Offsets that fail to reproduce their text are `log.integrity` events, not accepted history.

## Hashes and fingerprints — the content-addressing core

- **`content_sha`** — SHA-256 of full note file bytes, truncated to 16 hex chars. Drives the planner's unchanged-content check (R6).
- **`vh` (vector-hash)** — SHA-256 of the exact prefixed string sent to the embedder: task prefix + heading chain + frontmatter context + chunk text, per chunk policy `cp`. Computed by the **single shared `renderEmbedInput()` function** — the chunker and embed path are one implementation, not two drifting copies (VC's lesson generalized). The determinism unit: same `vh` + same `fp` ⇒ same vector, guaranteed. Duplicate paragraphs and template boilerplate dedupe embeddings for free.
- **`fp` (model fingerprint, embedding)** — `provider/model:dims/prefix-scheme/chunk-policy#hash8`. Dimensions discovered at warmup via single-`"_"` probe (VC's trick, adopted). Prefix scheme `docquery` = the `search_document:` / `search_query:` split (R3). Stamped on every embed event — vector-space provenance per event, not once in `meta` (R4).
- **`mfp` (model fingerprint, LLM)** — same construction for judgment models. Oversupply at the model tier is fine; undersupply gets warned.
- **`cp` (chunk policy version)** — integer on every `chunk.indexed` event. Owned by the chunker; the log never interprets it. Mixed `cp` in a projection ⇒ re-chunk required.

## Event catalog

### File events — Tier 1 (write-through)

|Type|Payload|Notes|
|---|---|---|
|`note.created`|`path, mtime, bytes, content_sha`||
|`note.modified`|`path, mtime, bytes, content_sha`|Planner dedups no-op modifications (same sha + mtime ⇒ no event, no seq consumed)|
|`note.deleted`|`path, last_content_sha`|Tombstone; chunks evict lazily|
|`note.renamed`|`from, to`|**Tier 1 write-through.** Emits nothing else. Chunks untouched — `vh` is path-independent (R6, cheap by construction). Post-rename sha check verifies content really moved intact; drift ⇒ targeted re-embed of affected chunks only|
|`note.conflicted`|`path, conflict_copy_path`|`actor: sync`. Obsidian Sync's silent conflict resolution becomes a first-class citizen|
|`note.opened`|`path, dwell`|`actor: user`, **dwell-time gated** (below). Tier 2 buffered|

> [!important] folder.renamed — DESIGNED, PENDING CONSUMER (ledgered 2026-10-24) Ratified fact: a folder rename mass-invalidates the storage address of everything beneath it (notes, attachments, embeds). Stock Obsidian emits one 'rename' for the folder with NO child events; links are maintained, child paths are not. The future index must learn this the instant it happens (notification latency == persistence latency), via the spine's future subscriber seam.
> 
> Status: NOT EMITTED as of 0.1.5. The gate's prefix rewrite (`renamePrefix`) is live; the spine event awaits the transcription doctrine's consumer — the index's subscriber lane. Gap accrual while pending: NONE (no index tails the log yet). The moment the subscriber seam lands, this event becomes load-bearing and every prior silent folder rename is invisible to the index's replay; resolution is the structural vault-join (spine path vs. vault-present path).
> 
> Payload shape when transcribed: `{from, to}` mirroring `note.renamed`. Fixture: extends F05a's R6 family; one new spine-assertion scenario.

### Chunk & link events — Tier 2 (bulk, buffered)

|Type|Payload|Notes|
|---|---|---|
|`chunk.indexed`|`path, ord, bs, be, vh, cp`|**Metadata only — no chunk text, ever.** Byte offsets follow the offset conventions above; they re-verify text against the note at read time|
|`chunk.evicted`|`vh, path`|Chunk gone from a still-existing note|
|`link.added` / `link.removed`|`from, target, kind`|`kind: wikilink\|embed\|md-link`. Full graph re-derivable from notes|

### Embed events — Tier 2 (bulk, buffered)

|Type|Payload|Notes|
|---|---|---|
|`embed.batch`|`fp, count, ok, failed, ms, batch`|Batch summary only. Doubles as per-hardware batch telemetry — the measurement no incumbent ever ran (R7)|

### Skill & write events — Tier 1 (write-through, never buffered)

|Type|Payload|Notes|
|---|---|---|
|`skill.invoked`|`recipe, paths[], outcome`|Plugin 2's accountability trail|
|`write.proposed`|`recipe, path, field, before, after`|Diff-gated proposals awaiting approval|
|`write.applied`|`path, field, before, after, class, recipe, mfp`|`class: approved \| auto`. Carries prior value (Strategy guardrail 3's mechanism, staged per its design note)|
|`write.reverted`|`ref, path`|`ref` = originating `(origin, seq)`. Replay-revert, by construction|

### Ops events — Tier 1

|Type|Payload|Notes|
|---|---|---|
|`session.opened`|`plugin_versions, settings_sha`|Boots the read context|
|`settings.changed`|`keys[]`|**The R8 fire alarm.** Chatty events here mean runtime state has crept into `data.json`|
|`log.checkpoint`|`last_seq, events, digest`|10k events or dispose-time farewell checkpoint|
|`log.integrity`|`detail`|Torn line, gap, shard rejection, offset-verification failure, repair scan — every integrity action gets logged (R5: silence is disqualifying)|

## Durability tiers and flush policy

|Tier|Events|Flush|Loss on crash|
|---|---|---|---|
|**1 — write-through**|all `note.*` except `opened`, `write.*`, `skill.*`, `settings.*`, `session.*`, `log.*`|Immediate, single `adapter.append()`|None tolerated|
|**2 — buffered**|`chunk.*`, `link.*`, `embed.batch`, `note.opened`|64 events, 3s idle, or hard cap 512; farewell flush on unload|≤ one buffer window; healable by mtime+sha rescan, which logs itself|

Buffered events are re-derivable by design; write-through events are facts about history that cannot be reconstructed. **Facts survive, derivatives heal.**

Thresholds are per-machine tunables in Zone 3 settings, not constants in code. Appends use `vault.adapter.append()` (O(line)) — never `vault.modify()` (whole-file rewrite; vector-search's 28 MiB cautionary exhibit).

## Dwell-time gating — `note.opened`

**v1 semantics (ratified 2026-10-23, F09-certified):** Significance over minutiae. The event fires **only on dwell-threshold crossing** — there is **no note-close emission** (the close-emit world is explicitly not built in v1).

- Minimum gate: **10 seconds** (dial, not doctrine). Swipe-throughs and dashboard burps never write a line.
- Threshold emission carries **dwell = 10 flat** — exposure weight stays flat regardless of actual dwell. The gate suppresses noise; it does not grade heat.
- **Accumulation across openings:** dwell banks per note when the note is switched away or the workspace empties. A return visit's timer arms for the remaining time to the gate. Multiple openings reaching a combined threshold fire one event.
- **One event per crossing; emission resets accrual.** Continued dwelling after an emission banks toward the farewell flush only — **NO second timer re-arms** for a note that has already crossed this session.
- **Farewell flush (sessionEnd):** returns **over-gate accruals only**, measured from the last emission (floor seconds, may exceed 10). Under-gate accruals are discarded silently. A swipe-through at session end emits **nothing**.

> [!example] Crossing example: open at 10:00:00, dwell 8s, switch away. Return at 10:01:00, dwell 2s — crossing fires at 10:01:10 with dwell=10 flat. Continued dwelling until 10:01:45 (35s total post-emission) banks 35s. Session ends at 10:01:45 — farewell returns 35s under the original emission's path. If no crossing occurred, the 8s+2s+35s bank is discarded at session end because the threshold was never crossed.

> [!important] **What the schema used to say (2026-10-20, superseded):** "on note close or dwell-threshold crossing, whichever first" and "Note still open at session end ⇒ farewell-flush emits with dwell-so-far." Both lines contradicted the ratified v1 semantics. The close-emit path was removed; farewell now emits only post-emission accruals. This revision (2026-10-24) aligns the spec with the ratified ruling.

## Chunk text residency — metadata only

The log stores `path, ord, bs, be, vh, cp` per chunk and nothing else. Chunk text re-derives from the synced note bytes + chunk policy; offsets verify it. Cold rebuild costs one vault scan — verification, not reconstruction. This **supersedes the Project Definition's "chunk text + offsets" storage-contract line** (vintage 2026-10-18, pre-dating the shard ruling); annotate that doc at next touch, do not silently rewrite.

> Supersession register — all flagged for annotation at next touch of the affected doc:
> 
> - Project Definition, Layer 0 wording ("one chunk per line" single-log phrasing) → per-origin shards
> - Project Definition, storage contract ("chunk text + offsets" synced) → metadata only
> - Architecture Map v0.2, machine-switch diagram (single `events.jsonl`) → per-origin shards; fold into Map v0.3
> - Architecture Map v0.2, pipeline diagram (`Chunker → Prefixer → Embedder`) → prefixer folds into the chunker via shared `renderEmbedInput()`; fold into Map v0.3

## Read-time derivations — no stored tier, ever

Heat is a pure function of the event stream (VC's 010 D5 refactor, adopted), computed at query time:

- **Judgment events** (`note.modified` actor=user, `write.applied` actor=plugin): weight **3**
- **Exposure events** (`note.opened`, dwell-gated): weight **1**
- **Plugin reads** (related-notes lookups): weight **0.5**
- Exponential decay, half-life **21 days**
- Tier thresholds: illustratively hot ≥ 8, warm ≥ 1

All constants are dials living in the projection layer — policy, not log. Named, tunable, and empirically revisitable only after live usage accumulates; no value here carries an endorsement beyond "plausible starting point."

The judgment-vs-exposure criterion (VC 2026-07-23 user decision) is encoded structurally: editing is judgment, opening is exposure, and the event types never blur into an mtime soup.

## Integrity — R5 made loud

1. `seq` contiguity per shard: gaps halt the projection with a report naming `(origin, expected_seq, got_seq)` — never skip, never pad.
2. Torn tail line: reader discards the partial line, emits `log.integrity`. Non-destructive recovery.
3. Sync drops: checkpoint digests let received-vs-sent state be verified. Obsidian Sync owes us silence; the log keeps the accounts anyway.
4. Foreign-origin guard: startup rejects a shard whose last line mismatches the local id (misconfiguration fails loud).
5. Offset verification: chunk offsets that fail to reproduce their text at read time are integrity events, not silent drift — the killer invariant policed by the log, defined by the chunker.
6. Growth: v1 never rotates or compacts. Estimated single-digit MB/year of text, far inside Sync's 200 MB/file lane. Compaction is a future migration-numbered policy.

## Checkpoints — cadence verified

- Cadence: **10k events**, or **dispose-time farewell checkpoint**, whichever comes first.
- No time-based cadence exists (monthly, daily, or otherwise). The 2026-10-20 schema mentioned "monthly" but that was aspirational; the code implements event-count + dispose only.
- Each checkpoint covers `last_seq = event's seq − 1`, digest over lines 1..last_seq inclusive.

## Versioning & migration

Forward-only, idempotent migrations keyed on `v`, with downgrade guard and unknown-version normalization (VC's migration discipline, adopted). `v:1` is the floor; migration machinery exists from day one, exercised by hostile fixtures in the test vault.

## Relations

- [[Project Definition File]] → Layer 0 charter (constraint #2 and storage-contract lines vintage-flagged, superseded by this schema and Map v0.3 zones)
- [[Architecture Map v0.3]] → zone model instantiated here (shard topology + prefixer fold)
- [[Lessons from the Incumbents — Comparison Doc v2]] → R2/R4/R5/R6/R7/R8 evidence base
- [[Tool & Skill Strategy]] → write classes and guardrails driving Tier-1 write events
- [[Vault Overseer — Chunker Spec v0.1]] → producer of `bs`/`be`/`vh`/`cp`; single shared `renderEmbedInput()` authority
- [[Vault Overseer — Event Log Fixture Corpus v0.1]] → hostile proof of this schema, with approved amendments folded (F01 multi-byte tear mandatory, F03 offset-verification clause, F04 cross-origin byte-determinism criterion)

## Amendments Log v0.2 (2026-10-24)

- **Dwell-time gating section rewritten:** replaced "note close or dwell-threshold crossing" with threshold-only (no close emission). Added accumulation-across-openings, one-event-per-crossing-no-re-arm, and over-gate farewell semantics. Added worked example.
- **Checkpoint cadence corrected:** "monthly, or 10k events" → "10k events or dispose-time farewell checkpoint". No time-based cadence exists.
- **`note.renamed` tier clarified:** explicitly marked "Tier 1 write-through" in catalog (code verification: `TIER2_TYPES` contains only `note.opened`, `chunk.indexed`, `chunk.evicted`).
- **Origin names updated:** `mokka`/`latitude` → `Desktop`/`Latitude` (actual shard names in production).
- **`folder.renamed` ledger entry added:** designed, pending consumer; status and rationale as of 2026-10-24.
- **Amendments register:** this section added for traceability of schema revisions.

## Footer

_Schema v0.2, rev. 2026-10-24. Consolidates v0.1 plus all six session rulings: metadata-only chunks, per-origin shards, dwell-gated exposure (ratified 2026-10-23, certified F09), heat dials without endorsement, event-count checkpoints, rename wiring. Folder rename event designed but not emitted. Same-day revision aligns spec with ratified v1 semantics and verified code behavior. No open schema questions remain; the frontier is now empirical. Ratable as v1-pending-fixtures._

---