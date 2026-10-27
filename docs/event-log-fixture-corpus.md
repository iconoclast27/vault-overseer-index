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
modified: 2026-10-24T17:36:47+01:00
---
---
# Vault Overseer — Event Log Fixture Corpus v0.1 (rev. 2026-10-24)

> [!abstract] Purpose Hostile fixtures proving the Event Log Schema v0.2 spine survives its own failure modes. Scenario fixtures (stateful, scripted corruption) — distinct from the chunker's property tests. Lives in the test vault at `~/Documents/Test Vault/_fixtures/log/`. Companion to Event Log Schema v0.2, Project Definition File, and Chunker Spec v0.1.

## Corpus design rules

1. **Fixtures run against the log module's public API only** — `appendEvent()`, `mergeScan()`, `startupChecks()`, `dispose()`. No test reaches into internals; if a test needs an internal, the internal is really a public.
2. **Corruption is injected at the file level** (hand-crafted shards on disk), never by mocking internals mid-flight. The log must survive hostile _files_, not hostile _method calls_.
3. **Every fixture asserts the `log.integrity` contract** where applicable: integrity actions are logged, loud, and named — silence is disqualifying (R5).
4. **Deterministic seeds.** Random generators seeded per-fixture; a fixture that fails intermittently is a fixture that hasn't diagnosed itself.
5. **Fast/slow split.** F01–F03, F06–F11 are fast (pure Node, no vault dependency, run on every commit). F04–F05 are slower harness tests (run pre-release / on-demand). Keeping the tight loop tight matters more than total coverage numbers.

> [!note] Revision 2026-10-24 — rule 5 scope note F05 has split (see F05a/F05b below): **F05a is fast** (pure-module gate semantics, virtual clock, no vault dependency) and joined the tight loop; F05b remains slow/harness, blocked on the embedder and batch queue. Rule 5's intent — protect the tight loop — is honored, with the split as the mechanism.

## Harness prerequisites

A tiny `FakeAdapter implements DataAdapter` (`read`, `write`, `append`, `mkdir`, `exists`) over a temp directory, plus a `spawnContext(origin)` helper returning an isolated `EventLog` instance with its own settings, simulating one device. Two contexts pointed at the same directory = a converged vault. No mocks of the log's own code, ever.

> [!note] Revision 2026-10-24 — a second harness idiom exists The dwell-gate fixtures (F09, F05a) do not use `spawnContext` at all: their subject is `src/dwell/gate.ts`, a pure module with injected clock/timer, driven directly with a virtual clock and a manual timer queue. Two idioms, two subjects: `spawnContext` for the spine, direct-drive for extracted gate semantics. Both obey rules 1–4 (public API only, no internal mocks, deterministic).

---

## F01 — Torn tail line

**Threat:** process death mid-`append()`; fsync lies; power loss on Latitude.

**Setup:** craft `mokka.jsonl` with 50 valid events, then append the first 140 bytes of a would-be 51st event (no trailing newline, mid-UTF-8 **mandatory** — tear inside a multi-byte character, e.g. ending mid-CJK or emoji, not just mid-ASCII).

**Procedure:** `startupChecks()` → `mergeScan()` on the damaged shard.

**Pass requires:**

- Reader consumes events 1–50 cleanly
- Partial line 51 discarded **and reported**: a `log.integrity` event lands with detail naming origin, offending byte length, and recovered-through seq
- Recovery is non-destructive: the torn bytes stay on disk untouched — no truncation, no rewrite
- The _next_ `appendEvent()` succeeds — writes resume from seq 51 without complaint, seq contiguity intact

**Fail smells:** silent truncation of the tail; startup refuses to boot; append forever blocked.

> [!note] Revision 2026-10-24 — parked boundary variant (registered, not scheduled) A known unbitten lane: **Tier-2-first flush after torn-tail boot**. F01 exercises torn-tail burial via a Tier-1 write-through; a boot on a torn shard whose _first_ write is a Tier-2 buffer flush would exercise `flushLocked()`'s torn-tail handling directly rather than relying on `startWriter`'s Tier-1 beacon landing first (defense by ordering, not structure). Candidate for the next F01-family variant. Not a red against current behavior — an untested path.

---

## F02 — Sequence gap

**Threat:** dropped sync line; truncated transfer; hand-edited shard.

**Setup:** 100 valid events; delete line 57 (and separately, test variant: delete lines 57–60).

**Procedure:** `mergeScan()` with gap-halting enabled (projection mode).

**Pass requires:**

- Scan yields events 1–56 and stops
- Report names `(origin: mokka, expected_seq: 57, got_seq: 58)` — precise, actionable, greppable
- `log.integrity` emitted naming the gap bounds
- **Never skips, never pads, never fabricates** — the missing event is a hole in the record, and the record admits it
- **Repair is refusal, not reconstruction.** On a gapped spine the repair path (`--repair` equivalent) refuses with disclosure: it emits `log.integrity` naming the gap, fabricates nothing, and leaves the hole intact — the hole survives the attempt. Re-deriving tier-2 lines from mtime+sha is **F03's regime** (a provably lost buffer window), not F02's: a gap is a hole in the record, and no rescan can know what belonged in it. F02 tests that the spine admits ignorance; F03 tests that it recovers what it provably lost.

**Fail smells:** "best effort" scan continuing past the gap; gap healed invisibly with no trace; repair path fabricating filler lines to close the gap.

**Status (2026-10-24):** clause 5's repair-refusal path is live in `f02.ts` (flipped 2026-10-21, calling `healScan` directly) and green. Verified green in the 2026-10-24 full-suite baseline.

---

## F03 — Mid-flush crash with live buffer

**Threat:** Tier-2 buffer part-full at process death — the case the two-tier design _predicts_, so it must be tested harder than the unpredictable ones.

**Setup:** `spawnContext('mokka')`; append 40 Tier-2 events (buffer threshold: 64) + 3 Tier-1 events; **kill without `dispose()`** — no farewell flush. Simulate by abandoning the instance (the harness owns the fs; torn-write injection not needed here — we want the _clean_ crash case first, dirty crash is F01's job).

**Procedure:** fresh `spawnContext('mokka')` on same directory; `startupChecks()`; heal scan.

**Pass requires:**

- The 3 Tier-1 events are present in the shard — **facts survived, full stop**
- The 40 Tier-2 events are absent, and that absence is _known_: heal scan detects mtime/`content_sha` of the affected file vs. last indexed seq and schedules re-index
- Heal scan logs itself (`log.integrity`, detail: "buffer window lost, N events re-derived from sha")
- Recovery costs one rescan, zero lost facts, zero duplicate `chunk.indexed` events after healing (idempotent re-derivation — the `vh` collision with the lost lines must not double-emit)
- **Re-derived `chunk.indexed` events must satisfy P1 (offsets-reproduce-text) against present-day file content** — the chunker spec's killer invariant policed at recovery, not just at creation

**Fail smells:** re-derivation emitting duplicates; heal scan silent; any Tier-1 loss; re-derived offsets failing to reproduce their text.

**Status (2026-10-27):** migration debt closed 2026-10-26 (F03 rev C rev D rev D reseed), stub deleted 2026-10-27 (Phase 4). Heal now re-derives via `chunkNote` (cp: 2) on all live paths; foreign cp (≠2) loudly skipped with disclosure; within-pass vh dedup verified (scenario twin-vh, 2026-10-26 errata). Fresh-shard recertification (Phase 3) verified cp:2 uniformity, idempotent boot-2 growth noise-level. No mixed-cp shards exist or will exist.


---

## F04 — Simultaneous indexing during sync convergence

**Threat:** the scenario no incumbent survived — both machines appending while shards travel. Run first among the slow suite; it exercises shards, write-through, and merge in one pass.

**Setup:** two `spawnContext`s, `mokka` and `latitude`, same directory (pre-convergence). Each indexes a _disjoint_ set of ~20 new notes: Mokka gets `projects-*.md`, Latitude gets `journal-*.md`, with deliberate overlap in _content_ — 5 paragraphs shared between both machines' notes (dedupe bait: same `vh` should appear from both origins).

**Procedure:** Phase A: both contexts index concurrently (interleaved by the harness's scheduler, seeded). Phase B: "convergence" — simulate by both contexts mounting the full two-shard directory; run `mergeScan()` from each perspective.

**Pass requires:**

- Neither shard ever carries a foreign `origin` value — each context appended only to its own file
- Merge-scan from both perspectives yields the **identical total event multiset** (order may differ by `(origin, seq)` grouping; events must not)
- All Tier-1 facts from both machines present exactly once
- Shared-`vh` paragraphs produce two `chunk.indexed` events (different paths, same `vh`) but the projection's embed plan dedupes them to one vector fetch
- No seq collisions within a shard; no cross-shard seq assumptions (Mokka's seq 42 and Latitude's seq 42 coexist without complaint)
- Both contexts' sequence counters continued monotonically across convergence
- **Shared `vh` values are byte-identical across origins** — cross-machine determinism of `renderEmbedInput` proven here, not just assumed from the chunker's P3 (this is the integration point where the two designs meet; the fixture asserts what the property test implies)

**Fail smells:** any write to the wrong shard; merge-scan results differing by perspective; seq treated as globally unique; `vh` byte mismatch for identical content across origins.

---

## F05 — Rename handling (split 2026-10-24)

Split by dependency: the gate-side semantics are testable now; the embed race is not. **F05a is the former, F05b the latter.**

### F05a — Rename wiring: gate semantics and spine facts

**Threat:** path staleness. Emissions and farewells naming dead paths; uncorrectable placeholder emissions (`Notes/Untitled.md` recorded permanently with no rename record to resolve it); folder renames mass-invalidating storage addresses with the gate unaware.

**Scope ruling (2026-10-24):** the fixture bites the **extracted gate's rename lanes** (`renamePath`, `renamePrefix` in `src/dwell/gate.ts`) — pure-module, virtual clock, no vault dependency. The spine half — `note.renamed` landing on the log via `main.ts` — is adapter wiring and earns its proof by **live receipt** (rename a note in the test vault, read the shard tail), the same way the session beacon does.

**Procedure:** drive the gate through the Untitled lifecycle, renames at every phase (open, banked, post-emission), foreign renames, and folder-rename prefix rewrites.

**Pass requires:**

- **R1** Rename while open, pre-threshold: crossing emission names the NEW path — the common Untitled case dies at the source
- **R2** Rename while banked: return visit crosses under the new path; farewell names the new path
- **R3** Foreign rename (no known lane): harmless no-op
- **R4** History preservation: recorded emissions keep their old paths FOREVER — the gate never rewrites history; `note.renamed` on the spine carries the chain and the projection resolves it
- **R5** Untitled lifecycle, both portraits: rename-before-crossing emits the real title (wart avoided); crossing-before-rename records the placeholder — the **declared correctable** case — and the farewell still names the new path
- **R6** Folder rename prefix rewrite: paths under the renamed prefix follow; sibling prefixes (`Area` vs `Area 2`) untouched; chained prefixes (A→B→C) compose

**Status (2026-10-24): SHIPPED, CERTIFIED.** `f05a.ts`: 26 checks, 6 scenario groups, ALL GREEN. **First contact drew two legitimate reds** — fixture arithmetic, not gate semantics (a single oversized `fastForward` hop consumed the crossing and post-emission dwell in one clock advance; fixed by splitting the hop). The reds satisfy this corpus's own hostility clause. Spine tier note: `note.renamed` is **Tier-1 write-through** (verified against `TIER2_TYPES` 2026-10-24: `note.opened`, `chunk.indexed`, `chunk.evicted` only) — a lost rename poisons every downstream path resolution.

**Fail smells:** emissions naming dead paths; gate re-writing recorded emissions (history-editing); prefix match catching siblings; farewell under a stale prefix.

### F05b — Rename during embed-in-flight

**Threat:** R6's crown jewel — the assertion that rename never re-embeds. If this fixture passes, R6 is proven, not promised.

**Blocked on:** the embedder, batch queue, and `embed.batch` — none exist yet (indexer Phase 3). Transcribing `embed.batch` before its fixture-loaded consumer would violate the transcription doctrine. **Deferred, not weakened** — the pass requirements below stand as written.

**Setup:** context indexes `Projects/alpha.md` (4 chunks), embedding completes. Then: schedule a rename to `Projects/beta.md` _while a re-embed batch for `alpha.md` is queued_ — harness forces the race: rename event emitted after embed dispatch begins but before `embed.batch` resolves.

**Procedure:** let the race resolve; run `mergeScan()`; inspect subsequent embed plan for `beta.md`.

**Pass requires:**

- `note.renamed` with `from: Projects/alpha.md, to: Projects/beta.md`, and nothing else — no re-chunk, no re-embed events for unchanged content
- Post-rename `content_sha` check passes (sha identical, `vh`s path-independent — chunks carry over untouched)
- The in-flight embed result lands against `beta.md` — the queue is path-remapped, not discarded (discarding wastes work; remapping preserves it)
- If the harness contrives sha-drift (rename actually changed content mid-flight — the adversarial variant), a _targeted_ re-embed of only drifted chunks fires — never full-note re-embed
- Total embed calls for the whole fixture: exactly one batch (the original), zero additional after the rename

**Fail smells:** full re-embed after rename — that's vector-search's crime, and this fixture exists specifically to prevent us committing it by accident.

---

## F06 — Sync conflict copy

**Threat:** Obsidian Sync's silent conflict resolution — the event class exists to make the quiet loud.

**Setup:** `Projects/plan.md` indexed; craft `Projects/plan conflicted copy 2026-10-20.md` on disk with diverged content.

**Procedure:** file watcher picks it up; `mergeScan()`.

**Pass requires:**

- `note.conflicted` fires with `actor: sync`, both paths in payload
- Conflict copy indexed like any other note — separate `content_sha`, separate chunks (it _is_ a real file; pretending it isn't is the incumbent's disease)
- The two notes' differing `content_sha`s are both live in the projection — user decides survivorship, the plugin records the fork
- Extension edge cases pass: non-md conflict copies ignored gracefully; nested conflict-copy-of-conflict-copy indexed without recursion panic

---

## F07 — Foreign-origin guard (parked)

Shard whose last line's origin mismatches local id ⇒ loud startup rejection, no append.

> [!note] Status nuance (2026-10-24): the guard itself is live in `reader.ts`/`main.ts` (startup rejects, writer dark) and has a code-level witness; the formal _fixture_ remains parked. Promote when next touching the corpus.

---

## F08 — No-op modification dedup (parked)

Same sha + mtime ⇒ zero events, zero seq consumed. Must prove the seq counter _doesn't_ advance — off-by-one here poisons everything downstream. Blocked on the file watcher (no `note.modified` producer yet).

---

## F09 — Dwell gate (PROMOTED 2026-10-24)

**Promoted from the parked list, with a semantics correction:** the parked entry read "note open at session end emits with dwell-so-far; dwell below 10s gate emits nothing." The first clause was superseded by the ratified v1 semantics — farewell returns **over-gate post-emission accruals only**. The promotion transcribes the ratified law, not the parked sketch.

**Threat:** a noisy spine. Ungated opens flood the log with swipe-throughs; the dwell signal drowns. Also: the accumulated-collision wart — successive `Untitled.md` creations inheriting a dead predecessor's banked dwell via path-keyed accrual (live-observed 2026-10-23, seq-11-gap session).

**Subject:** the extracted dwell gate (`src/dwell/gate.ts`) — pure module, injected clock and timer, emit via callback. v1 semantics per schema (ratified 2026-10-23; extraction ratified 2026-10-24).

**Pass requires:**

- **S1** Threshold-only: gate fires at 10s accrued; emission carries dwell = 10 FLAT; overshoot still one emission; 9.999s stays silent
- **S2** Accumulation across openings: 8s banked + return visit arms for the remaining 2s; combined 10s fires one event, flat 10; 9s combined stays silent
- **S3** One event per crossing, no re-arm: post-emission dwelling emits NOTHING further; the banked post-emission dwell surfaces as farewell only
- **S4** Farewell: over-gate post-emission accruals returned with actual dwell (floor seconds) and last-known path; under-gate discarded silently; second `sessionEnd()` returns nothing; multiple lanes resolve independently
- **S5** Collision fix: accrual keyed by opaque noteId — a fresh note at a reused path (`Untitled.md` twice) inherits NOTHING; the newcomer crosses on its own dwell; same-note reopen still accumulates (the fix narrows the blast radius, not the feature)

**Status (2026-10-24): SHIPPED, CERTIFIED.** `f09.ts`: 32 checks, 5 scenarios, ALL GREEN. Live witnesses concur: `Desktop.jsonl` seq 13 (dwell 52 — exactly the post-emission remainder) and seq 24 (dwell 25 — same arithmetic through the extracted module).

**Fail smells:** re-arming timers after a crossing; farewell measuring from the open instead of the last emission; path-keyed accrual leaking between note identities; under-gate farewells emitting.

**Declared boundary:** placeholder-path emissions (crossing before the title is typed) remain **correctable-not-prevented** — v1 behavior, resolved by the projection over `note.renamed` chains. F05a's R5b asserts this exact behavior.

---

## F10 — `write.reverted` replay (parked)

Revert of an auto-applied write restores `before` exactly, event-by-ref. Blocked on Plugin 2.

---

## F11 — Checkpoint verification

**Threat:** checkpoint chain integrity; coverage invariants; falsified-ledger attacks; tail-drop losses.

**Setup:** multiple scenarios testing shutdown checkpoints, threshold auto-checkpoints, tamper under checkpoint, truncation under checkpoint, and coverage-violation (falsified last_seq field).

**Scenarios:**

1. **shutdown** — append 3 events, dispose → checkpoint present, chain verifies end-to-end
2. **threshold** — cross checkpointInterval mid-stream → auto-checkpoint emitted, chain verifies across checkpoint boundaries
3. **tamper** — mutate a covered line's bytes → digest mismatch, verification fails loudly
4. **truncation** — delete a covered line → digest mismatch, chain witnesses the hole
5. **coverage** — falsify checkpoint's last_seq field only → digest still matches chain, but positional witness catches the lie (vanished lines)

**Pass requires:**

- Shutdown checkpoint emitted on dispose() when events were appended
- Threshold auto-checkpoint emitted when interval crossed (configurable via settings)
- Coverage invariant: checkpoint's last_seq equals preceding data max seq (not overall shard max)
- Tamper under surviving checkpoint fails verification with digest-mismatch detail
- Truncation of covered line fails verification with digest-mismatch detail
- Falsified last_seq field (carried digest intact) fails verification with coverage-violation detail
- Honest limitation documented: tail drop consuming checkpoint line itself has no single-file witness; that detection is cross-machine territory (schema clause 3: received-vs-sent)

**Fail smells:** checkpoint missing; chain verifies despite tamper; coverage violation silent; falsified last_seq accepted; no distinction between digest failure and positional failure.

---

## F11-deepening — Hostile encore (PROMOTED 2026-10-24)

**Was parked as "hostile encore owed per doctrine; corpus passed first contact." Shipped since and green:** torn-tail checkpoint, interleaved Tier-2 buffers across threshold, intermediate chain segments asserted independently. `f11-deepening.ts` runs in the tight loop; verified green in the 2026-10-24 full-suite baseline (alongside csuite's C01–C06 and the property corpus). The encore is owed no more — it is paid.

---

## Secondary clauses demanding fixtures (parked, not forgotten)

Remaining parked entries after the 2026-10-24 promotions:

- ~~F09 farewell-flush dwell event~~ — **promoted 2026-10-24, certified** (above, with semantics correction)
- ~~F11 deepening~~ — **promoted 2026-10-24, green** (above)
- **F07 foreign-origin guard** — kept parked with a status nuance (guard live in code, fixture owed)
- **F08 no-op modification dedup** — kept parked, blocked on the file watcher
- **F10 `write.reverted` replay** — kept parked, blocked on Plugin 2
- **Tier-2-first flush after torn-tail boot** — registered 2026-10-24 under F01's boundary note

Parked per house rules — the promoted entries above are paid; the parked remainder is next sprint's, not smuggled into this one.

## Definition of done for this phase

All seven fixtures green in the test vault, reproducible from a clean clone with seeded inputs, **and** at least one fixture initially red against the first implementation — a corpus that passes on first contact hasn't been hostile enough. If the first implementation passes everything untouched, add nastier variants (deeper UTF-8 tears in F01, wider gaps in F02, checkpoint-chain tamper variants in F11) before trusting green.

**Hostility ledger (2026-10-24):** the clause has teeth — F05a drew two legitimate first-contact reds (fixture arithmetic, fixed) and F11's family drew first-contact reds in its original pass (per the 2026-10-22 footer). F09 itself passed first contact against extracted code; its hostility is inherited from the extraction's drafting history (four self-caught drafting defects before it ever ran — logged in the session, not the corpus).

---

Footer note on versioning: v0.1 (rev. 2026-10-24) folds in: (1) F09 promoted from parked to a full certified entry, with the parked sketch's "dwell-so-far" farewell wording corrected to the ratified over-gate-post-emission rule; (2) F05 split into F05a (shipped, certified — rename wiring, gate semantics) and F05b (deferred — embed-in-flight race, blocked on the embedder, requirements unchanged); (3) F11-deepening promoted from parked (shipped, green); (4) F03 gains the stub→chunker migration debt annotation; (5) F02 clause 5's repair-refusal status confirmed live and green; (6) F01 gains the Tier-2-first-flush boundary variant as a registered candidate; (7) rule 5 scope note for the split's effect on the fast/slow line; (8) second harness idiom (pure-module direct-drive) noted. Previous rev. 2026-10-22 amendments (F02 clause 5 reinterpretation, F11 seating) and rev. 2026-10-20 amendments (F01 multi-byte tear, F03 re-derived-offsets, F04 byte-determinism) remain in place. No pass requirements were weakened by any amendment; F05b's deferral changes scheduling, not the bar.