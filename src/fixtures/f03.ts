// =============================================================================
// Vault Overseer — Fixture F03: Mid-flush crash with live buffer
// vault-overseer-index/src/fixtures/f03.ts
// Generated: 2026-10-22T11:35:00+01:00
// Rev B: 2026-10-25 — corpse suppression (delete/rename-away paths not re-chunked)
// Rev C: 2026-10-26 — heal→chunkNote migration (cp:0 → cp:2), RED-EARNING.
//
// REV C ERRATA (2026-10-26, post first contact): the original rev C world
// used homogeneous filler — every paragraph identical '=' bytes. Under
// chunkNote that merges into multiple chunks SHARING ONE vh (identical
// text + no chain + no fm ⇒ identical rendered input). That degeneracy
// made the p1-membership scenario lie (the displaced ord-0 chunk was
// vouched for by its twin's record) and hid a REAL production edge:
// heal double-emitted twin vhs within a single pass. Errata, threefold:
//   1. paraFiller now takes a salt — every paragraph is byte-distinct,
//      so every chunk has a unique vh (the honest world).
//   2. New scenario twin-vh: a deliberately homogeneous note — chunkNote
//      yields multiple chunks with one shared vh — asserts heal emits
//      that vh EXACTLY ONCE (within-pass dedup). RED against heal
//      without the fix; earns the one-line haveVh.add() change.
//   3. legacy-cp0's "every NEW record is cp:2" check now counts the
//      new cp:2 set instead of sweeping the whole shard with .every()
//      over pre-seeded cp:0 forensics (fixture bug, not heal bug).
// Lesson folded: salt your filler. Homogeneity in a synthetic world is
// a lying witness wearing honest clothes.
//
// Rev C is the fixture FIRST: it encodes the post-migration contract.
// Expected against MIGRATED heal WITHOUT within-pass dedup:
//   all green EXCEPT twin-vh — RED (the dedup is earned separately).
// Post-migration WITH within-pass dedup: ALL GREEN.
// (Against pre-migration stub heal: canonical/reversed/carve/p1/
// legacy RED; gap-refusal/corpse GREEN — receipt held 2026-10-26.)
//
// Threat: Tier-2 buffer part-full at process death — the failure mode
// the two-tier design PREDICTS, so it is tested harder than the
// unpredictable ones (corpus doctrine).
//
// Scenarios:
//   canonical   — 3 Tier-1 note.created (write-through) THEN Tier-2
//                 chunk.indexed (buffered, chunkNote-shaped), kill
//                 WITHOUT dispose(). Fresh context: startupChecks →
//                 healScan → dispose → heal AGAIN (idempotence) → P1.
//   reversed    — Tier-2 first, THEN Tier-1: buffer-carry drags
//                 everything to disk; the "crash" loses nothing. Heals
//                 ZERO (all vh collide). Vacuity guard.
//   gap-refusal — post-crash shard hand-corrupted with a seq gap:
//                 healScan must REFUSE loudly (never-fabricate).
//   corpse-suppress — create Alpha/Beta/Delta, rename Alpha→Gamma,
//                 delete Beta and Delta. Heals examine ONLY Gamma.
//   carve-disclosure — a note whose sole body is one over-ceiling
//                 fenced block: heal must emit the carved pieces AND
//                 disclose every carve as log.integrity. Second heal
//                 must re-emit AND re-disclose nothing.
//   p1-membership — a shard record with a stale vh (cp:2): heal's P1
//                 is fresh-derivation MEMBERSHIP — every recorded vh
//                 on a live path must be derivable from present-day
//                 bytes. Stale vh ⇒ p1 violation, loudly, every heal.
//   legacy-cp0  — a healthy stub-era record set (cp:0): post-migration
//                 heal treats cp:0 as a FOREIGN policy — loud skip
//                 with disclosure, never a fabricated verification.
//   twin-vh (NEW, errata) — a homogeneous note: chunkNote yields
//                 multiple chunks sharing one vh. Heal must emit that
//                 vh exactly ONCE per pass (within-pass dedup), the
//                 shard must hold exactly one record for it, and the
//                 second heal must find only collisions.
//
// Pass requires (corpus F03, rev C):
//   1. Tier-1 facts present exactly once — facts survived, full stop
//   2. The Tier-2 events absent from disk at kill time (canonical)
//   3. Heal re-derives all of them, field-identical to chunkNote output,
//      every record cp: 2
//   4. Heal logs itself: "buffer window lost, N events re-derived"
//   5. Idempotence: second heal dedupes every vh, emits zero, and
//      re-discloses zero carves
//   6. P1 (membership): every recorded chunk vh on a live path is
//      derivable from present-day bytes; stale vh ⇒ violation, named
//   7. Clean crash: no torn tail, seq contiguous, gaps: []
//   8. CORPSE SUPPRESSION: heal examines 1 path (Gamma), not 4
//   9. CARVE DISCLOSURE: over-ceiling fences carve with log.integrity
//      lines; count matches chunkNote's own disclosure
//  10. LEGACY cp:0: skipped loudly, never verified, never fabricated
//  11. TWIN VH: identical chunks emit exactly once per pass (dedup
//      holds WITHIN a derivation, not just against the spine)
//
// The killed context's idle timer stays armed — spawned with a
// geological tier2IdleMs (Zone 3 tunable, corpus rule 2: hostile FILES,
// no internal mocks). Determinism rule 4.
//
// Fillers are ASCII, paragraph-shaped, and SALTED (see errata): distinct
// bytes per paragraph ⇒ distinct vhs, except where the scenario is
// explicitly about homogeneity (twin-vh).
//
// Run:  node ./src/fixtures/f03.ts
// =============================================================================

import { FakeFileSystem, FakeAdapter, spawnContext, shardPath } from '../test-harness.ts';
import { startupChecks, mergeScan } from '../eventlog/reader.ts';
import { healScan } from '../eventlog/heal.ts';
import { chunkNote } from '../chunker/chunker.ts';
import { chunkStub, contentSha } from '../chunker/stub.ts';

const ROOT = '/f03';
const DIR = '_vault-index/events';
const ORIGIN = 'mokka';
const FIXED_TS = '2026-10-21T12:00:00+01:00';
const GEOLOGICAL_IDLE_MS = 3_600_000;

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
      if (ok) {
            console.log(`[PASS] ${name}`);
      } else {
            failures++;
            console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
      }
}

// --- Helpers -------------------------------------------------------------------

function splitByteLines(raw: Uint8Array): Uint8Array[] {
      const out: Uint8Array[] = [];
      let start = 0;
      for (let i = 0; i < raw.length; i++) {
            if (raw[i] === 0x0a) {
                  out.push(raw.slice(start, i));
                  start = i + 1;
            }
      }
      if (start < raw.length) out.push(raw.slice(start, raw.length));
      return out;
}

function parseEvents(raw: Uint8Array, type: string): Record<string, unknown>[] {
      return splitByteLines(raw)
      .map((l) => JSON.parse(Buffer.from(l).toString('utf-8')) as Record<string, unknown>)
      .filter((e) => e.type === type);
}

function countSubstring(raw: Uint8Array, needle: string): number {
      return Buffer.from(raw).toString('utf-8').split(needle).length - 1;
}

/** Sorted JSON keys of chunk events — field-equality without seq/ts noise. */
function chunkKeys(raw: Uint8Array): string[] {
      return parseEvents(raw, 'chunk.indexed')
      .map((e) =>
      JSON.stringify({ path: e.path, ord: e.ord, bs: e.bs, be: e.be, vh: e.vh, cp: e.cp }))
      .sort();
}

interface NoteSpec { path: string; bytes: Uint8Array; }

/** Real-chunker chunk count for a note — expectations derive from the
 * chunker itself (deterministic ⇒ provable equality), never from hand
 * arithmetic. Rev B learned this the hard way (F05a fixture reds). */
function realChunkCount(bytes: Uint8Array): number {
      return chunkNote(bytes).chunks.length;
}

function expectedChunkKeys(notes: NoteSpec[]): string[] {
      return notes
      .flatMap((n) =>
      chunkNote(n.bytes).chunks.map((c) =>
      JSON.stringify({ path: n.path, ord: c.ord, bs: c.bs, be: c.be, vh: c.vh, cp: c.cp })))
      .sort();
}

/**
 * Independent P1 probe — the same invariant heal polices, asserted here
 * with a second implementation. Rev C semantics: MEMBERSHIP. A recorded
 * chunk event is P1-clean iff its vh appears among the vhs freshly
 * derived from the note's present-day bytes. (The rev B offset-math
 * probe re-rendered with empty chain / null fm — valid only for the
 * stub's shape, unsound for cp:2 where chain and fm live outside the
 * log by design.) A stale vh is un-derivable ⇒ violation. Deliberate
 * consequence: reordered frontmatter or a heading inserted above the
 * span flags as a violation — different bytes, different vh, the record
 * IS stale. That is the sha-drift/eviction neighbor, parked, not denied.
 */
function p1Failures(raw: Uint8Array, notes: NoteSpec[]): number {
      const byPath = new Map(notes.map((n) => [n.path, chunkNote(n.bytes).chunks.map((c) => c.vh)]));
      let bad = 0;
      for (const e of parseEvents(raw, 'chunk.indexed')) {
            const vhs = byPath.get(String(e.path));
            if (vhs === undefined || !vhs.includes(String(e.vh))) bad++;
      }
      return bad;
}

// --- World: paragraph-shaped, SALTED notes, deterministic under chunkNote -----

/**
 * One paragraph = 8 lines, each 64 bytes: `${salt}|p{para}|l{line}|`
 * padded with '='. Distinct salt/para ⇒ distinct bytes ⇒ distinct vh.
 * (Errata: the unsalted rev C filler made every paragraph identical —
 * chunkNote merged them into chunks sharing ONE vh, a degenerate world
 * that lied to the p1-membership scenario. Salt your filler.)
 */
function paraFiller(paras: number, salt: string): Uint8Array {
      const parts: string[] = [];
      for (let p = 0; p < paras; p++) {
            for (let l = 0; l < 8; l++) {
                  const prefix = `${salt}|p${p}|l${l}|`;
                  parts.push(prefix + '='.repeat(63 - prefix.length) + '\n');
            }
            if (p < paras - 1) parts.push('\n'); // blank line separates paragraphs
      }
      return Buffer.from(parts.join(''), 'utf-8');
}

/**
 * Deliberately HOMOGENEOUS note (errata scenario fuel): every paragraph
 * identical '=' bytes. chunkNote yields multiple chunks that SHARE one
 * vh — the world that earns the within-pass dedup red.
 */
function homoParaFiller(paras: number): Uint8Array {
      const para = ('='.repeat(63) + '\n').repeat(8); // 512 bytes
      return Buffer.from(Array(paras).fill(para).join('\n'), 'utf-8');
}

/**
 * One over-ceiling fenced block: '```text\n' + content + '\n```\n'.
 * An atomic paragraph exceeding CEILING (3072): carved at UTF-8-safe
 * byte offsets, every carve owed a disclosure. Piece lengths differ
 * (ceiling cut + remainder), so piece vhs are distinct.
 */
function fenceFiller(contentBytes: number): Uint8Array {
      return Buffer.from('```text\n' + '='.repeat(contentBytes) + '\n```\n', 'utf-8');
}

function buildWorld(paraCounts: number[]): { fs: FakeFileSystem; notes: NoteSpec[] } {
      const fs = new FakeFileSystem();
      const notes = paraCounts.map((k, i) => {
            const path = `Notes/f03-${i + 1}.md`;
            return { path, bytes: paraFiller(k, `f03-${i + 1}`) };
      });
      for (const n of notes) fs.write(`${ROOT}/${n.path}`, n.bytes);
      return { fs, notes };
}

async function appendFacts(ctx: { log: ReturnType<typeof spawnContext>['log'] }, notes: NoteSpec[]): Promise<void> {
      for (const n of notes) {
            await ctx.log.appendEvent('user', 'note.created', {
                  path: n.path,
                  mtime: 1763000000000,
                  bytes: n.bytes.length,
                  content_sha: contentSha(n.bytes),
            });
      }
}

/**
 * Buffered Tier-2 chunks in POST-MIGRATION form: chunkNote geometry,
 * cp: 2. This is what the live lane emits after the migration, so it
 * is what the doomed context must be holding when it dies.
 */
async function appendChunks(ctx: { log: ReturnType<typeof spawnContext>['log'] }, notes: NoteSpec[]): Promise<number> {
      let n = 0;
      for (const note of notes) {
            for (const c of chunkNote(note.bytes).chunks) {
                  await ctx.log.appendEvent('plugin', 'chunk.indexed', {
                        path: note.path, ord: c.ord, bs: c.bs, be: c.be, vh: c.vh, cp: c.cp,
                  });
                  n++;
            }
      }
      return n;
}

/** Spawn a fresh heal context over an existing shard. */
async function freshContext(fs: FakeFileSystem) {
      const adapter = new FakeAdapter(fs, ROOT);
      const su = await startupChecks(adapter, ORIGIN, DIR);
      const ctx = spawnContext(ORIGIN, ROOT, {
            fs,
            now: () => FIXED_TS,
                               initialSeq: su.recoveredThroughSeq,
                               settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      return { adapter, ctx };
}

// --- Scenario 1: canonical — Tier-1 first, genuine loss, heal, heal again ----

async function scenarioCanonical(): Promise<void> {
      console.log('\n=== F03 scenario: canonical (Tier-1 first, kill with live buffer) ===');
      const { fs, notes } = buildWorld([12, 12, 12]);
      const SHARD = shardPath(ROOT, ORIGIN);
      const TOTAL = notes.reduce((s, n) => s + realChunkCount(n.bytes), 0);
      console.log(`world: ${notes.length} notes, ${TOTAL} chunkNote chunks expected`);

      // DOOMED CONTEXT: spawns with shared fs, writes Tier-1 then Tier-2, dies
      const doomed = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      await appendFacts(doomed, notes);
      const appended = await appendChunks(doomed, notes);

      check('canonical: Tier-2 events appended (world arithmetic holds)',
            appended === TOTAL, `got ${appended}`);
      check('canonical: writer holds all Tier-2 events buffered at kill time',
            doomed.log.pendingCount === TOTAL, `got ${doomed.log.pendingCount}`);

      // KILL: abandon without dispose(). No farewell flush, ever.
      void doomed;

      const rawAtKill = fs.getBytes(SHARD)!;
      check('canonical: exactly 3 lines on disk at kill time',
            splitByteLines(rawAtKill).length === 3, `got ${splitByteLines(rawAtKill).length}`);
      check('canonical: zero chunk events leaked to disk',
            parseEvents(rawAtKill, 'chunk.indexed').length === 0);
      check('canonical: all 3 Tier-1 facts durable',
            parseEvents(rawAtKill, 'note.created').length === 3);

      // FRESH CONTEXT: shares the SAME fs, runs startupChecks then heal
      const h1 = await freshContext(fs);
      const su2 = await startupChecks(h1.adapter, ORIGIN, DIR);

      check('canonical: startup recovers seq 3',
            su2.recoveredThroughSeq === 3, `got ${su2.recoveredThroughSeq}`);
      check('canonical: no torn tail', !su2.tornTail);
      check('canonical: no foreign origin', !su2.foreignOrigin);
      check('canonical: filesystem contains 3 note.created events',
            parseEvents(fs.getBytes(SHARD)!, 'note.created').length === 3);

      const heal1 = await healScan(h1.ctx.log, h1.adapter, DIR);
      check('canonical: heal did not refuse', !heal1.refused);
      check('canonical: heal examined 3 paths', heal1.pathsExamined === 3);
      check('canonical: heal re-derived all lost chunks (chunkNote count)',
            heal1.chunksReemitted === TOTAL, `got ${heal1.chunksReemitted}`);
      check('canonical: zero dedupe hits on first heal',
            heal1.vhDeduped === 0, `got ${heal1.vhDeduped}`);
      check('canonical: zero P1 failures on first heal', heal1.p1Failures === 0);
      check('canonical: zero P1 SKIPS on first heal (cp:2 is home policy)',
            heal1.p1Skipped === 0, `got ${heal1.p1Skipped} — cp:2 records hit the foreign-policy skip`);
      await h1.ctx.log.dispose(); // farewell flush — durability restored
      const rawHealed = fs.getBytes(SHARD)!;
      check('canonical: no "file absent" integrity reports',
            countSubstring(rawHealed, 'file absent') === 0);
      check('canonical: all re-derived chunk events on disk after heal',
            parseEvents(rawHealed, 'chunk.indexed').length === TOTAL);
      check('canonical: heal logged itself (buffer window lost)',
            countSubstring(rawHealed, 'buffer window lost') >= 1);
      check('canonical: re-derived chunks are field-identical to chunkNote output',
            JSON.stringify(chunkKeys(rawHealed)) === JSON.stringify(expectedChunkKeys(notes)));
      check('canonical: every re-derived record is cp:2',
            parseEvents(rawHealed, 'chunk.indexed').every((e) => Number(e.cp) === 2));
      check('canonical: P1 holds — every recorded vh derivable from bytes',
            p1Failures(rawHealed, notes) === 0, `got ${p1Failures(rawHealed, notes)}`);

      // Idempotence: heal AGAIN from a fresh context. Everything must collide.
      const h2 = await freshContext(fs);
      const heal2 = await healScan(h2.ctx.log, h2.adapter, DIR);
      check('canonical: second heal re-emits NOTHING',
            heal2.chunksReemitted === 0, `got ${heal2.chunksReemitted}`);
      check('canonical: second heal dedupes every vh',
            heal2.vhDeduped === TOTAL, `got ${heal2.vhDeduped}`);
      check('canonical: second heal still P1-clean', heal2.p1Failures === 0);
      check('canonical: second heal still P1-skip-free', heal2.p1Skipped === 0);
      await h2.ctx.log.dispose();

      const rawFinal = fs.getBytes(SHARD)!;
      check('canonical: still exactly the same chunk events after second heal',
            parseEvents(rawFinal, 'chunk.indexed').length === TOTAL);
      const finalScan = await mergeScan(new FakeAdapter(fs, ROOT), DIR);
      check('canonical: final scan — no gaps, Tier-1 facts survived exactly once',
            finalScan.gaps.length === 0 &&
            finalScan.events.filter((e) => e.type === 'note.created').length === 3);
}

// --- Scenario 2: reversed order — vacuity guard -------------------------------

async function scenarioReversed(): Promise<void> {
      console.log('\n=== F03 scenario: reversed (Tier-2 first — vacuity guard) ===');
      const { fs, notes } = buildWorld([12, 12, 12]);
      const SHARD = shardPath(ROOT, ORIGIN);
      const TOTAL = notes.reduce((s, n) => s + realChunkCount(n.bytes), 0);

      const ctx = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      await appendChunks(ctx, notes); // Tier-2 FIRST — buffered
      await appendFacts(ctx, notes);  // Tier-1 write-through CARRIES the buffer
      void ctx;                       // "crash" — but the buffer already fled

      const raw = fs.getBytes(SHARD)!;
      check('reversed: buffer was carried — facts + chunks on disk',
            splitByteLines(raw).length === 3 + TOTAL,
            `got ${splitByteLines(raw).length} (expected ${3 + TOTAL})`);
      check('reversed: crash lost nothing (all chunk events durable)',
            parseEvents(raw, 'chunk.indexed').length === TOTAL);

      // A heal here MUST emit zero: the crash was vacuous, and emitting
      // would be DOUBLE-EMITTING events that never died.
      const h = await freshContext(fs);
      const heal = await healScan(h.ctx.log, h.adapter, DIR);
      check('reversed: heal re-emits zero (no double-emit)',
            heal.chunksReemitted === 0, `got ${heal.chunksReemitted}`);
      check('reversed: heal dedupes every vh (collision guard)',
            heal.vhDeduped === TOTAL, `got ${heal.vhDeduped}`);
      await h.ctx.log.dispose();
      check('reversed: no phantom "buffer window lost" report',
            countSubstring(fs.getBytes(SHARD)!, 'buffer window lost') === 0);
}

// --- Scenario 3: gap refusal — never-fabricate --------------------------------

async function scenarioGapRefusal(): Promise<void> {
      console.log('\n=== F03 scenario: gap refusal (heal across a broken spine) ===');
      const { fs } = buildWorld([12, 12, 12]);
      const SHARD = shardPath(ROOT, ORIGIN);

      const ctx = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      const notes3 = buildWorld([12, 12, 12]).notes; // facts only; buffer irrelevant
      await appendFacts(ctx, notes3);
      void ctx;

      // Hand-corruption: delete line 2 (seq 2) — byte-clean, F02's lane.
      const raw = fs.getBytes(SHARD)!;
      const lines = splitByteLines(raw);
      const corrupted = lines.filter((_, i) => i !== 1);
      const joined = Buffer.concat(corrupted.map((l) => Buffer.concat([l, Buffer.from('\n')])));
      fs.write(SHARD, joined);

      const h = await freshContext(fs);
      const heal = await healScan(h.ctx.log, h.adapter, DIR);
      check('gap-refusal: heal REFUSED', heal.refused);
      check('gap-refusal: nothing re-derived across the gap',
            heal.chunksReemitted === 0, `got ${heal.chunksReemitted}`);
      await h.ctx.log.dispose();

      const rawAfter = fs.getBytes(SHARD)!;
      check('gap-refusal: refusal logged loudly and names the gap',
            countSubstring(rawAfter, 'heal refused') >= 1 &&
            countSubstring(rawAfter, 'expected_seq: 2') >= 1);
      check('gap-refusal: zero chunk events fabricated',
            parseEvents(rawAfter, 'chunk.indexed').length === 0);
}

// --- Scenario 4: corpse suppression — delete/rename-away paths not examined ---

async function scenarioCorpseSuppress(): Promise<void> {
      console.log('\n=== F03 scenario: corpse suppression (delete/renamed-away not examined) ===');
      const fs = new FakeFileSystem();
      const SHARD = shardPath(ROOT, ORIGIN);

      // Build a spine with four paths:
      //   Alpha created → renamed to Gamma (Alpha is corpse, Gamma is live)
      //   Beta created → deleted (Beta is corpse)
      //   Delta created → renamed to Epsilon → deleted (Delta is rename-victim,
      //                                                      Epsilon is corpse)
      //
      // Disk has ONLY Gamma.md; Alpha/Beta/Delta/Epsilon are absent.
      // The live-set projection (deleted/renamed-from subtract) examines
      // only Gamma; an additive projection files corpses as "file absent".

      const ctx1 = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });

      await ctx1.log.appendEvent('user', 'note.created', {
            path: 'Notes/Alpha.md', mtime: 1763000000000, bytes: 128, content_sha: 'aaa'
      });
      await ctx1.log.appendEvent('user', 'note.created', {
            path: 'Notes/Beta.md', mtime: 1763000000001, bytes: 128, content_sha: 'bbb'
      });
      await ctx1.log.appendEvent('user', 'note.created', {
            path: 'Notes/Delta.md', mtime: 1763000000002, bytes: 128, content_sha: 'ccc'
      });
      await ctx1.log.appendEvent('user', 'note.renamed', {
            from: 'Notes/Alpha.md', to: 'Notes/Gamma.md'
      });
      await ctx1.log.appendEvent('user', 'note.deleted', {
            path: 'Notes/Beta.md', last_content_sha: 'bbb'
      });
      await ctx1.log.appendEvent('user', 'note.renamed', {
            from: 'Notes/Delta.md', to: 'Notes/Epsilon.md'
      });
      await ctx1.log.appendEvent('user', 'note.deleted', {
            path: 'Notes/Epsilon.md', last_content_sha: 'ccc'
      });
      await ctx1.log.dispose();

      // Setup disk: ONLY Gamma.md exists, populated with a real-chunker note
      fs.write(`${ROOT}/Notes/Gamma.md`, paraFiller(1, 'gamma'));

      const h = await freshContext(fs);
      const heal = await healScan(h.ctx.log, h.adapter, DIR);

      check('corpse-suppress: heal did not refuse', !heal.refused);
      check('corpse-suppress: heal examined EXACTLY 1 path (Gamma)',
            heal.pathsExamined === 1, `got ${heal.pathsExamined}`);
      check('corpse-suppress: zero "file absent" reports for corpses',
            countSubstring(fs.getBytes(SHARD)!, 'file absent') === 0,
            'additive projection files corpses as absent');
      check('corpse-suppress: chunk.indexed for Gamma (live path)',
            parseEvents(fs.getBytes(SHARD)!, 'chunk.indexed').length >= 1);
      check('corpse-suppress: zero chunks for Alpha/Beta/Delta/Epsilon',
            parseEvents(fs.getBytes(SHARD)!, 'chunk.indexed')
            .every((e: Record<string,unknown>) => String(e.path) === 'Notes/Gamma.md'));

      await h.ctx.log.dispose();
}

// --- Scenario 5: carve disclosure (NEW, rev C) --------------------------------

async function scenarioCarveDisclosure(): Promise<void> {
      console.log('\n=== F03 scenario: carve disclosure (over-ceiling fence — silence disqualifies) ===');
      const fs = new FakeFileSystem();
      const SHARD = shardPath(ROOT, ORIGIN);
      const SPEC: NoteSpec = { path: 'Notes/f03-carve.md', bytes: fenceFiller(7000) };
      fs.write(`${ROOT}/${SPEC.path}`, SPEC.bytes);

      // Ground truth from the chunker itself — pieces, carves, determinism.
      const truth = chunkNote(SPEC.bytes);
      check('carve: world arithmetic — fence produces 3 pieces',
            truth.chunks.length === 3, `got ${truth.chunks.length}`);
      check('carve: world arithmetic — chunker discloses 2 carves',
            truth.carves.length === 2, `got ${truth.carves.length}`);
      check('carve: every carved piece is under the ceiling',
            truth.chunks.every((c) => c.be - c.bs <= 3072));

      const ctx1 = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      await appendFacts(ctx1, [SPEC]);
      await ctx1.log.dispose(); // Tier-1 write-through; facts durable

      const h1 = await freshContext(fs);
      const heal1 = await healScan(h1.ctx.log, h1.adapter, DIR);
      check('carve: heal did not refuse', !heal1.refused);
      check('carve: heal emitted every carved piece',
            heal1.chunksReemitted === truth.chunks.length,
            `got ${heal1.chunksReemitted}`);
      await h1.ctx.log.dispose();

      const raw1 = fs.getBytes(SHARD)!;
      check('carve: chunk.carve disclosed once per chunker carve',
            countSubstring(raw1, 'chunk.carve') === truth.carves.length,
            `got ${countSubstring(raw1, 'chunk.carve')} (expected ${truth.carves.length})`);
      check('carve: every emitted record is cp:2',
            parseEvents(raw1, 'chunk.indexed').every((e) => Number(e.cp) === 2));
      check('carve: no "file absent" reports',
            countSubstring(raw1, 'file absent') === 0);

      // Idempotence, disclosure included: heal AGAIN — zero new chunks AND
      // zero new carve complaints. Disclosure rides novel emission; a
      // recurring disclose would be the corpse-report defect reborn.
      const h2 = await freshContext(fs);
      const heal2 = await healScan(h2.ctx.log, h2.adapter, DIR);
      check('carve: second heal re-emits NOTHING',
            heal2.chunksReemitted === 0, `got ${heal2.chunksReemitted}`);
      await h2.ctx.log.dispose();
      const raw2 = fs.getBytes(SHARD)!;
      check('carve: second heal re-discloses NOTHING (no recurring complaint)',
            countSubstring(raw2, 'chunk.carve') === truth.carves.length,
            `got ${countSubstring(raw2, 'chunk.carve')} after second heal`);
}

// --- Scenario 6: p1 membership (NEW, rev C) -----------------------------------

async function scenarioP1Membership(): Promise<void> {
      console.log('\n=== F03 scenario: p1 membership (stale vh on a live path) ===');
      const fs = new FakeFileSystem();
      const SHARD = shardPath(ROOT, ORIGIN);
      // SALTED (errata): distinct paragraphs ⇒ distinct chunk vhs, so the
      // displaced ord-0 chunk cannot be vouched for by a twin's record.
      const SPEC: NoteSpec = { path: 'Notes/f03-p1.md', bytes: paraFiller(6, 'p1') };
      fs.write(`${ROOT}/${SPEC.path}`, SPEC.bytes);

      const STALE_VH = 'f' + '0'.repeat(15); // 16 hex chars, sha-shaped, wrong

      // Errata guard: if the salt regresses, this scenario goes vacuous —
      // fail loudly HERE rather than lie quietly THERE.
      const truthVhs = chunkNote(SPEC.bytes).chunks.map((c) => c.vh);
      check('p1-membership: world arithmetic — all chunk vhs distinct (salt guard)',
            new Set(truthVhs).size === truthVhs.length,
            `got ${new Set(truthVhs).size}/${truthVhs.length} distinct`);

      // Spine construction: facts + chunk events with ord 0's vh STALE —
      // the exact record a mid-version content change would leave behind
      // (offsets plausible, vh un-derivable from present-day bytes).
      const ctx1 = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      await appendFacts(ctx1, [SPEC]);
      for (const c of chunkNote(SPEC.bytes).chunks) {
            await ctx1.log.appendEvent('plugin', 'chunk.indexed', {
                  path: SPEC.path, ord: c.ord, bs: c.bs, be: c.be,
                  vh: c.ord === 0 ? STALE_VH : c.vh,
                  cp: c.cp,
            });
      }
      await ctx1.log.dispose(); // farewell flush — the poisoned record is durable

      const h1 = await freshContext(fs);
      const heal1 = await healScan(h1.ctx.log, h1.adapter, DIR);
      check('p1-membership: heal did not refuse', !heal1.refused);
      check('p1-membership: stale vh FLAGGED as p1 failure',
            heal1.p1Failures === 1, `got ${heal1.p1Failures}`);
      check('p1-membership: cp:2 records NOT skipped (home policy verified)',
            heal1.p1Skipped === 0, `got ${heal1.p1Skipped}`);
      check('p1-membership: heal re-emits exactly the displaced ord-0 chunk',
            heal1.chunksReemitted === 1, `got ${heal1.chunksReemitted}`);
      await h1.ctx.log.dispose();

      const raw1 = fs.getBytes(SHARD)!;
      check('p1-membership: violation named loudly in log.integrity',
            countSubstring(raw1, 'p1 violation') >= 1);
      check('p1-membership: no foreign-policy skip noise',
            countSubstring(raw1, 'unknown chunk policy') === 0);

      // The stale record is append-only truth: it stays on the spine, so
      // EVERY heal re-detects it. This is the eviction debt (parked)
      // wearing its name tag — the fixture asserts it is reported, not
      // hidden, until chunk.evicted retires the corpse record.
      const h2 = await freshContext(fs);
      const heal2 = await healScan(h2.ctx.log, h2.adapter, DIR);
      check('p1-membership: second heal re-emits NOTHING (real vhs deduped)',
            heal2.chunksReemitted === 0, `got ${heal2.chunksReemitted}`);
      check('p1-membership: stale record STILL flagged every heal (until eviction)',
            heal2.p1Failures === 1, `got ${heal2.p1Failures}`);
      await h2.ctx.log.dispose();
}

// --- Scenario 7: legacy cp:0 (NEW, rev C) -------------------------------------

async function scenarioLegacyCp0(): Promise<void> {
      console.log('\n=== F03 scenario: legacy cp:0 (stub-era records are foreign, not verifiable) ===');
      const fs = new FakeFileSystem();
      const SHARD = shardPath(ROOT, ORIGIN);
      const SPEC: NoteSpec = { path: 'Notes/f03-legacy.md', bytes: paraFiller(6, 'legacy') };
      fs.write(`${ROOT}/${SPEC.path}`, SPEC.bytes);

      const STUB_COUNT = chunkStub(SPEC.bytes).length;
      const REAL_COUNT = realChunkCount(SPEC.bytes);
      check('legacy-cp0: world arithmetic — stub and chunkNote geometries differ',
            STUB_COUNT !== REAL_COUNT,
            `stub ${STUB_COUNT} vs real ${REAL_COUNT} — scenario is vacuous if equal`);

      // Spine construction: a healthy stub-era record set (cp:0, byte-perfect
      // against the stub's own shape) plus the note's Tier-1 facts.
      const ctx1 = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      await appendFacts(ctx1, [SPEC]);
      for (const c of chunkStub(SPEC.bytes)) {
            await ctx1.log.appendEvent('plugin', 'chunk.indexed', {
                  path: SPEC.path, ord: c.ord, bs: c.bs, be: c.be, vh: c.vh, cp: c.cp,
            });
      }
      await ctx1.log.dispose();

      const h1 = await freshContext(fs);
      const heal1 = await healScan(h1.ctx.log, h1.adapter, DIR);
      check('legacy-cp0: heal did not refuse', !heal1.refused);
      check('legacy-cp0: every cp:0 record LOUDLY skipped (foreign policy)',
            heal1.p1Skipped === STUB_COUNT, `got ${heal1.p1Skipped} (expected ${STUB_COUNT})`);
      check('legacy-cp0: zero FABRICATED failures against cp:0 records',
            heal1.p1Failures === 0, `got ${heal1.p1Failures}`);
      check('legacy-cp0: fresh cp:2 derivation emitted (novel vh set)',
            heal1.chunksReemitted === REAL_COUNT, `got ${heal1.chunksReemitted} (expected ${REAL_COUNT})`);
      await h1.ctx.log.dispose();

      // Errata: "every NEW record is cp:2" must EXCLUDE the pre-seeded
      // cp:0 forensics — they belong on the spine, loudly skipped, until
      // a retirement tool exists. Count the new set; forbid foreign cps.
      const raw1 = fs.getBytes(SHARD)!;
      const chunkEvents = parseEvents(raw1, 'chunk.indexed');
      const cp2Records = chunkEvents.filter((e) => Number(e.cp) === 2).length;
      const foreignRecords =
      chunkEvents.filter((e) => Number(e.cp) !== 0 && Number(e.cp) !== 2).length;
      check('legacy-cp0: skip disclosed, naming cp: 0 as the foreign policy',
            countSubstring(raw1, 'unknown chunk policy') >= STUB_COUNT &&
            countSubstring(raw1, 'cp: 0') >= 1);
      check('legacy-cp0: exactly REAL_COUNT new cp:2 records on the spine',
            cp2Records === REAL_COUNT, `got ${cp2Records} (expected ${REAL_COUNT})`);
      check('legacy-cp0: no records with any cp outside {0, 2}',
            foreignRecords === 0, `got ${foreignRecords}`);

      // Idempotence: the cp:2 set now collides; the cp:0 forensics stay
      // skipped every heal — loudly, forever, until the migration tool
      // that retires them exists (registered debt, named here).
      const h2 = await freshContext(fs);
      const heal2 = await healScan(h2.ctx.log, h2.adapter, DIR);
      check('legacy-cp0: second heal re-emits NOTHING',
            heal2.chunksReemitted === 0, `got ${heal2.chunksReemitted}`);
      check('legacy-cp0: forensics still skipped loudly on second heal',
            heal2.p1Skipped === STUB_COUNT, `got ${heal2.p1Skipped}`);
      await h2.ctx.log.dispose();
}

// --- Scenario 8: twin-vh (NEW, rev C errata) -----------------------------------

async function scenarioTwinVh(): Promise<void> {
      console.log('\n=== F03 scenario: twin-vh (identical chunks — within-pass dedup) ===');
      const fs = new FakeFileSystem();
      const SHARD = shardPath(ROOT, ORIGIN);
      // HOMOGENEOUS by design: identical paragraphs ⇒ multiple chunks
      // sharing one vh. The world that earns the within-pass dedup red.
      // A real note CAN look like this — repeated boilerplate paragraphs.
      const SPEC: NoteSpec = { path: 'Notes/f03-twin.md', bytes: homoParaFiller(6) };
      fs.write(`${ROOT}/${SPEC.path}`, SPEC.bytes);

      const truth = chunkNote(SPEC.bytes);
      const distinctVhs = new Set(truth.chunks.map((c) => c.vh)).size;
      check('twin-vh: world arithmetic — multiple chunks share ONE vh',
            truth.chunks.length >= 2 && distinctVhs === 1,
            `got ${truth.chunks.length} chunks, ${distinctVhs} distinct vhs`);

      const ctx1 = spawnContext(ORIGIN, ROOT, {
            fs, now: () => FIXED_TS, settings: { tier2IdleMs: GEOLOGICAL_IDLE_MS },
      });
      await appendFacts(ctx1, [SPEC]);
      await ctx1.log.dispose();

      const h1 = await freshContext(fs);
      const heal1 = await healScan(h1.ctx.log, h1.adapter, DIR);
      check('twin-vh: heal did not refuse', !heal1.refused);
      check('twin-vh: shared vh emitted EXACTLY ONCE (within-pass dedup)',
            heal1.chunksReemitted === 1, `got ${heal1.chunksReemitted}`);
      check('twin-vh: twin chunks deduped within the pass',
            heal1.vhDeduped === truth.chunks.length - 1,
            `got ${heal1.vhDeduped} (expected ${truth.chunks.length - 1})`);
      await h1.ctx.log.dispose();

      const raw1 = fs.getBytes(SHARD)!;
      check('twin-vh: exactly ONE chunk.indexed record for the shared vh',
            parseEvents(raw1, 'chunk.indexed').length === 1,
            `got ${parseEvents(raw1, 'chunk.indexed').length} records`);
      check('twin-vh: the single record is cp:2',
            parseEvents(raw1, 'chunk.indexed').every((e) => Number(e.cp) === 2));

      // Second heal: the shared vh now collides — nothing re-emits, and
      // every twin chunk counts as a dedupe hit.
      const h2 = await freshContext(fs);
      const heal2 = await healScan(h2.ctx.log, h2.adapter, DIR);
      check('twin-vh: second heal re-emits NOTHING',
            heal2.chunksReemitted === 0, `got ${heal2.chunksReemitted}`);
      check('twin-vh: second heal dedupes every twin chunk',
            heal2.vhDeduped === truth.chunks.length,
            `got ${heal2.vhDeduped} (expected ${truth.chunks.length})`);
      await h2.ctx.log.dispose();
}

// --- Main -----------------------------------------------------------------------

async function main(): Promise<void> {
      await scenarioCanonical();
      await scenarioReversed();
      await scenarioGapRefusal();
      await scenarioCorpseSuppress();
      await scenarioCarveDisclosure();
      await scenarioP1Membership();
      await scenarioLegacyCp0();
      await scenarioTwinVh();
      console.log('');
      if (failures === 0) {
            console.log('F03: ALL GREEN (canonical heal + idempotence + reversed-order vacuity guard '
            + '+ gap refusal + corpse suppression + carve disclosure + p1 membership '
            + '+ legacy cp:0 skip + twin-vh within-pass dedup)');
      } else {
            console.log(`F03: ${failures} RED`);
      }
}

main().then(() => process.exit(failures === 0 ? 0 : 1));
