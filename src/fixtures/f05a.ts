// =============================================================================
// Vault Overseer — Fixture F05a: Rename wiring (gate semantics)
// vault-overseer-index/src/fixtures/f05a.ts
//
// Earns the dwell gate's RENAME LANES (src/dwell/gate.ts: renamePath,
// renamePrefix) their v1 badge. Drives the pure gate with an injected
// clock and manual timer queue — no Obsidian, no sleeps, no internal
// mocks (corpus rules 1–4).
//
// SCOPE RULING (2026-10-24): the SPINE half of F05a — note.renamed
// landing on the event log via main.ts emitRename — is ADAPTER WIRING
// and is NOT under test here. It earns its proof by LIVE RECEIPT in
// the test vault (rename a note, read the shard tail), the same way
// the session beacon does. The fixture's jurisdiction is semantics:
// everything the gate does with paths.
//
// SEMANTICS UNDER TEST (ratified 2026-10-24):
//   R1  Rename while OPEN, before the threshold: the crossing emission
//       names the NEW path. This kills the placeholder-path wart at
//       the source for the common case — create note, dwell past the
//       gate while typing the title, the emission records the REAL
//       name, not Notes/Untitled.md.
//   R2  Rename while BANKED (opened, dwelt below the gate, switched
//       away): the return visit arms under the new path, and the
//       farewell names the new path.
//   R3  Foreign rename (no known lane): harmless no-op.
//   R4  History preservation: an emission already recorded keeps its
//       old path FOREVER — the gate never rewrites history, because
//       the spine is append-only and note.renamed carries the chain.
//       A rename after a crossing causes no re-emission.
//   R5  The full Untitled lifecycle, the wart's own portrait:
//       create → dwell below gate → rename to real title → return →
//       cross. Emission names the real title. (The OTHER portrait —
//       crossing BEFORE the rename — is the DECLARED correctable
//       case: emission records Untitled, note.renamed sits beside
//       it, the projection resolves. Asserted here as R5b.)
//   R6  FOLDER rename: prefix rewrite. Active note beneath the
//       renamed folder: threshold emission names the new prefixed
//       path. Banked lane beneath it: farewell names the new
//       prefixed path. Lanes OUTSIDE the prefix: untouched.
//   R7  TFile-identity independence: renamePath is path-keyed (exact
//       match), so the lane rewrite does not depend on the WeakMap —
//       asserted indirectly by R1–R2 driving by path only.
//
// DECLARED BOUNDARY: note.renamed's payload shape {from, to} and its
// placement in causal order on the spine belong to the live receipt.
// folder.renamed on the spine is PENDING a types.ts ruling (transcription
// ban) — the gate's prefix rewrite is live regardless.
//
// Corrections log: none yet — first delivery. (F09's log taught the
// lesson: assertions drafted against imagined semantics get walked
// against the ratified contract before shipping.)
//
// Run:  node ./src/fixtures/f05a.ts
// Node note: erasable TS, .ts import extensions.
// =============================================================================

import { DwellGate } from '../dwell/gate.ts';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
      checks++;
      if (ok) return true;
      failures++;
      console.log(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
      return false;
}

// -----------------------------------------------------------------------------
// Harness — virtual clock + manual timer queue (same idiom as F09)
// -----------------------------------------------------------------------------

interface MockTimer {
      cb: () => void;
      dueAt: number;
      cancelled: boolean;
      fired: boolean;
}

interface Emission {
      path: string;
      dwell: number;
}

function makeHarness(startMs: number) {
      let nowMs = startMs;
      const timers: MockTimer[] = [];
      const emissions: Emission[] = [];

      const gate = new DwellGate({
            gateMs: 10_000,
            now: () => nowMs,
                                 schedule: (cb, ms) => {
                                       const t: MockTimer = { cb, dueAt: nowMs + ms, cancelled: false, fired: false };
                                       timers.push(t);
                                       return {
                                             cancel: () => { t.cancelled = true; },
                                       };
                                 },
                                 emit: (path, dwell) => {
                                       emissions.push({ path, dwell });
                                 },
      });

      function fastForward(ms: number): void {
            nowMs += ms;
            for (const t of [...timers]) {
                  if (t.cancelled || t.fired) continue;
                  if (t.dueAt <= nowMs) {
                        t.fired = true;
                        t.cb();
                  }
            }
      }

      return { gate, emissions, fastForward, timers };
}

// -----------------------------------------------------------------------------
// R1 — Rename while open, before the threshold
// -----------------------------------------------------------------------------

function r1RenameDuringOpen(): void {
      console.log('=== F05a: R1 — rename while open, pre-threshold ===');
      const h = makeHarness(0);

      // The note is created as Untitled; the user dwells while typing the title.
      h.gate.open('note-1', 'Notes/Untitled.md');
      h.fastForward(4_000);

      // Title committed: rename fires (gate rewrite first, spine fact second —
      // main.ts's order; the fixture drives the gate half).
      h.gate.renamePath('Notes/Untitled.md', 'Area/Projects/Renamer.md');

      h.fastForward(6_000); // 10s total accrued
      check('R1 one emission after combined dwell',
            h.emissions.length === 1, `got ${h.emissions.length}`);
      check('R1 emission names the NEW path',
            h.emissions[0]?.path === 'Area/Projects/Renamer.md',
            `got ${h.emissions[0]?.path}`);
      check('R1 emission dwell is flat 10',
            h.emissions[0]?.dwell === 10, `got ${h.emissions[0]?.dwell}`);
      check('R1 no emission ever named the placeholder',
            h.emissions.every((e) => e.path !== 'Notes/Untitled.md'));
}

// -----------------------------------------------------------------------------
// R2 — Rename while banked below the gate
// -----------------------------------------------------------------------------

function r2RenameWhileBanked(): void {
      console.log('=== F05a: R2 — rename while banked ===');

      // (a) Return visit crosses under the new name.
      const h = makeHarness(0);
      h.gate.open('note-1', 'Notes/Bank.md');
      h.fastForward(6_000);
      h.gate.noFileOpen(); // banked at 6s

      h.gate.renamePath('Notes/Bank.md', 'Notes/Worth.md');

      h.gate.open('note-1', 'Notes/Worth.md'); // return visit
      h.fastForward(4_000); // 6 + 4 = 10s
      check('R2a return visit crosses on combined dwell',
            h.emissions.length === 1, `got ${h.emissions.length}`);
      check('R2a crossing names the NEW path',
            h.emissions[0]?.path === 'Notes/Worth.md',
            `got ${h.emissions[0]?.path}`);

      // (b) The farewell half: banked over-gate post-emission, renamed, session ends.
      const h2 = makeHarness(0);
      h2.gate.open('note-1', 'Notes/Evening.md');
      h2.fastForward(10_000); // crossing
      h2.fastForward(15_000); // 15s banked post-emission
      h2.gate.noFileOpen();

      h2.gate.renamePath('Notes/Evening.md', 'Notes/Night.md');

      const farewells = h2.gate.sessionEnd();
      check('R2b farewell returned', farewells.length === 1, `got ${farewells.length}`);
      check('R2b farewell names the NEW path',
            farewells[0]?.path === 'Notes/Night.md', `got ${farewells[0]?.path}`);
      check('R2b farewell dwell preserved (15s)',
            farewells[0]?.dwellSeconds === 15, `got ${farewells[0]?.dwellSeconds}`);
}

// -----------------------------------------------------------------------------
// R3 — Foreign rename: no known lane
// -----------------------------------------------------------------------------

function r3ForeignRename(): void {
      console.log('=== F05a: R3 — foreign rename no-op ===');
      const h = makeHarness(0);

      h.gate.open('note-1', 'Notes/Known.md');
      h.fastForward(5_000);
      h.gate.noFileOpen();

      // A rename of a file the gate has never heard of.
      h.gate.renamePath('Notes/Stranger.md', 'Notes/Other.md');

      // The known lane is untouched: still 5s, still the old name.
      h.gate.open('note-1', 'Notes/Known.md');
      const armed = h.timers.filter((t) => !t.cancelled && !t.fired);
      check('R3 known lane unaffected (arms for remaining 5s)',
            armed.length === 1 && armed[0]?.dueAt === 10_000,
            `dueAt=${armed[0]?.dueAt}, want 10000`);

      h.fastForward(5_000);
      check('R3 crossing still names the KNOWN path',
            h.emissions.length === 1 && h.emissions[0]?.path === 'Notes/Known.md',
            `got ${JSON.stringify(h.emissions[0])}`);
}

// -----------------------------------------------------------------------------
// R4 — History preservation: emissions already recorded keep old paths
// -----------------------------------------------------------------------------

function r4HistoryPreserved(): void {
      console.log('=== F05a: R4 — history preservation ===');
      const h = makeHarness(0);

      h.gate.open('note-1', 'Notes/Before.md');
      h.fastForward(10_000); // crossing — emission recorded with old path
      check('R4 crossing recorded', h.emissions.length === 1);

      h.gate.renamePath('Notes/Before.md', 'Notes/After.md');

      // No re-emission, no correction of the recorded fact. The spine
      // carries note.renamed; the projection resolves the chain.
      h.fastForward(5_000);
      check('R4 rename causes no re-emission',
            h.emissions.length === 1, `got ${h.emissions.length}`);
      check('R4 recorded emission keeps its ORIGINAL path',
            h.emissions[0]?.path === 'Notes/Before.md',
            `got ${h.emissions[0]?.path}`);
      check('R4 recorded dwell unchanged (flat 10)',
            h.emissions[0]?.dwell === 10, `got ${h.emissions[0]?.dwell}`);
}

// -----------------------------------------------------------------------------
// R5 — The Untitled lifecycle, both portraits
// -----------------------------------------------------------------------------

function r5UntitledLifecycle(): void {
      console.log('=== F05a: R5 — Untitled lifecycle ===');

      // (a) Wart avoided at source: rename BEFORE the crossing.
      //     Driven fully in R1; here the FULL lifecycle with a return visit.
      const h = makeHarness(0);
      h.gate.open('note-1', 'Notes/Untitled.md');
      h.fastForward(6_000);
      h.gate.noFileOpen(); // banked at 6s

      h.gate.renamePath('Notes/Untitled.md', 'Area/Resources/Real Name.md');

      h.gate.open('note-1', 'Area/Resources/Real Name.md'); // return
      h.fastForward(4_000); // combined 10s
      check('R5a lifecycle crossing names the real title',
            h.emissions.length === 1 &&
            h.emissions[0]?.path === 'Area/Resources/Real Name.md',
            `got ${JSON.stringify(h.emissions[0])}`);

      // (b) The DECLARED correctable case: crossing BEFORE the rename.
      //     The emission records the placeholder — forever, by append-only
      //     doctrine — and the rename makes it CORRECTABLE, not wrong.
      const h2 = makeHarness(0);
      h2.gate.open('note-1', 'Notes/Untitled.md');
      h2.fastForward(10_000); // crossing under the placeholder name
      check('R5b placeholder crossing recorded (the declared behavior)',
            h2.emissions.length === 1 &&
            h2.emissions[0]?.path === 'Notes/Untitled.md',
            `got ${JSON.stringify(h2.emissions[0])}`);

      h2.gate.renamePath('Notes/Untitled.md', 'Notes/Titled.md');
      h2.fastForward(20_000); // further dwell banks post-emission

      const farewells = h2.gate.sessionEnd();
      check('R5b farewell names the NEW path',
            farewells.length === 1 && farewells[0]?.path === 'Notes/Titled.md',
            `got ${JSON.stringify(farewells[0])}`);
      check('R5b farewell dwell is post-emission (20s)',
            farewells[0]?.dwellSeconds === 20, `got ${farewells[0]?.dwellSeconds}`);
}

// -----------------------------------------------------------------------------
// R6 — Folder rename: prefix rewrite
// -----------------------------------------------------------------------------

function r6FolderRename(): void {
      console.log('=== F05a: R6 — folder rename prefix rewrite ===');

      // (a) Active note beneath the renamed folder: crossing names the
      //     new prefixed path.
      const h = makeHarness(0);
      h.gate.open('note-1', 'Area/Projects/Deep/Work.md');
      h.fastForward(3_000);

      h.gate.renamePrefix('Area/Projects', 'Area/Archive');

      h.fastForward(7_000); // 10s total
      check('R6a crossing names the prefixed path',
            h.emissions.length === 1 &&
            h.emissions[0]?.path === 'Area/Archive/Deep/Work.md',
            `got ${JSON.stringify(h.emissions[0])}`);

      // (b) Banked lanes beneath the folder + one OUTSIDE: farewell
      //     rewrites inside, leaves outside untouched.
      const h2 = makeHarness(0);
      h2.gate.open('note-inside', 'Area/Projects/Inside.md');
      h2.fastForward(10_000); // crossing
      h2.fastForward(12_000); // 12s banked post-emission
      h2.gate.open('note-outside', 'Notes/Outside.md');
      h2.fastForward(10_000); // outside's own crossing
      h2.fastForward(11_000); // 11s post-emission dwell, banked below
      h2.gate.noFileOpen(); // both banked

      h2.gate.renamePrefix('Area/Projects', 'Area/Archive');

      const farewells = h2.gate.sessionEnd();
      check('R6b two farewells returned', farewells.length === 2,
            `got ${farewells.length}`);
      const inside = farewells.find((f) => f.dwellSeconds === 12);
      const outside = farewells.find((f) => f.dwellSeconds === 11);
      check('R6b inside-lane farewell rewrites the prefix',
            inside !== undefined && inside.path === 'Area/Archive/Inside.md',
            `got ${JSON.stringify(inside)}`);
      check('R6b outside-lane farewell untouched',
            outside !== undefined && outside.path === 'Notes/Outside.md',
            `got ${JSON.stringify(outside)}`);

      // (c) Nested-rename composition: rename A→B, then B→C. The lane
      //     follows both hops. (Chains are the projection's daily bread;
      //     the gate must survive them too.)
      const h3 = makeHarness(0);
      h3.gate.open('note-1', 'X/Mobile.md');
      h3.fastForward(2_000);
      h3.gate.renamePrefix('X', 'Y');
      h3.gate.renamePrefix('Y', 'Z');
      h3.fastForward(8_000); // 10s
      check('R6c chained prefix renames compose',
            h3.emissions.length === 1 && h3.emissions[0]?.path === 'Z/Mobile.md',
            `got ${JSON.stringify(h3.emissions[0])}`);

      // (d) Prefix boundary discipline: 'Area' must NOT rewrite
      //     'Area 2/...' — the prefix matches 'Area/' including the slash.
      const h4 = makeHarness(0);
      h4.gate.open('note-1', 'Area 2/Neighbor.md');
      h4.fastForward(5_000);
      h4.gate.noFileOpen();
      h4.gate.renamePrefix('Area', 'Area/Archive');
      const fw = h4.gate.sessionEnd();
      check('R6d sibling-prefix lane untouched by the rewrite',
            fw.length === 0, // 5s banked, under gate — discarded silently
            `got ${fw.length}`);
      // The stronger form: reopen and cross, asserting the untouched path.
      const h5 = makeHarness(0);
      h5.gate.open('note-1', 'Area 2/Neighbor.md');
      h5.fastForward(5_000);
      h5.gate.noFileOpen();
      h5.gate.renamePrefix('Area', 'Area Renamed');
      h5.gate.open('note-1', 'Area 2/Neighbor.md');
      h5.fastForward(5_000);
      check('R5d sibling-prefix crossing keeps its own path',
            h5.emissions.length === 1 &&
            h5.emissions[0]?.path === 'Area 2/Neighbor.md',
            `got ${JSON.stringify(h5.emissions[0])}`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function main(): void {
      r1RenameDuringOpen();
      r2RenameWhileBanked();
      r3ForeignRename();
      r4HistoryPreserved();
      r5UntitledLifecycle();
      r6FolderRename();
      console.log('');
      if (failures === 0) {
            console.log(`F05a: ALL GREEN (${checks} checks, 6 scenario groups)`);
            console.log('F05a: rename lanes v1 SURVIVED THE FIXTURE');
      } else {
            console.log(`F05a: ${failures} RED (out of ${checks} checks)`);
      }
}

main();
process.exitCode = failures === 0 ? 0 : 1;
