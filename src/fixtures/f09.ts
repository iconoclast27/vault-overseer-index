// =============================================================================
// Vault Overseer — Fixture F09: Dwell gate (v1, threshold-only)
// vault-overseer-index/src/fixtures/f09.ts
//
// Earns the extracted dwell gate (src/dwell/gate.ts) its v1 badge.
// Drives the PURE module with an injected clock and a manual timer
// queue — no Obsidian, no sleeps, no internal mocks (corpus rules
// 1–4). main.ts's adapter (emitDwell, WeakMap noteIds) is NOT under
// test here; dark-writer drops are the adapter's declared v1
// limitation and belong to the live receipt.
//
// v1 SEMANTICS UNDER TEST (ratified 2026-10-23):
//   S1  Threshold-only: the gate fires at 10s accrued; emission
//       carries dwell = 10 FLAT.
//   S2  Accumulation across openings: dwell banks on switch-away;
//       a return visit's timer arms for gate MINUS banked.
//   S3  One event per crossing. Emission resets the accrual and
//       rebaselines; NO second timer re-arms — continued dwell banks
//       toward the farewell flush ONLY.
//   S4  Farewell (sessionEnd): returns over-gate accruals with
//       ACTUAL dwell since last emission (floor seconds) and the
//       note's last-known path. Under-gate accruals are discarded.
//   S5  Collision fix (v1.1, 2026-10-24): accrual keyed by opaque
//       noteId — a fresh note at a reused path (Notes/Untitled.md)
//       inherits NOTHING from its dead predecessor.
//
// DECLARED BOUNDARY (not tested here, F05's warrant): placeholder-path
// emissions — file-open fires on note CREATE before the title is
// typed, so note.opened may record Notes/Untitled.md permanently.
// F09 asserts the COLLISION fix only.
//
// Corrections log (self-caught 2026-10-24, logged not hidden):
//   Draft 1 asserted a second threshold crossing 5s after emission
//   (v1 forbids re-arming — S3) and a 15s farewell from a note whose
//   timer had already fired at 10s (actual v1: emission at 10 flat,
//   5s banked, under-gate, discarded). Both scenarios red against
//   CORRECT gate code, inviting a fix in the wrong direction. The
//   over-gate farewell must be constructed as post-emission dwell.
//
// Run:  node ./src/fixtures/f09.ts
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
// Harness — virtual clock + manual timer queue
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

    /** Advance the clock, firing every due uncancelled unfired timer once. */
    function fastForward(ms: number): void {
        nowMs += ms;
        // Iterate over a snapshot: fire() does not arm new timers (no
        // re-arm in v1), but a snapshot is cheap insurance regardless.
        for (const t of [...timers]) {
            if (t.cancelled || t.fired) continue;
            if (t.dueAt <= nowMs) {
                t.fired = true;
                t.cb();
            }
        }
    }

    /** Timers armed but not yet fired — for arming assertions. */
    function armedCount(): number {
        return timers.filter((t) => !t.cancelled && !t.fired).length;
    }

    return { gate, emissions, fastForward, armedCount, timers };
}

// -----------------------------------------------------------------------------
// S1 — Threshold-only emission
// -----------------------------------------------------------------------------

function s1Threshold(): void {
    console.log('=== F09: S1 — threshold-only emission ===');
    const h = makeHarness(0);

    check('S1 no timer before any open', h.armedCount() === 0);

    h.gate.open('note-1', 'Notes/a.md');
    check('S1 timer armed on open', h.armedCount() === 1);

    h.fastForward(9_999);
    check('S1 no emission before the gate', h.emissions.length === 0,
          `got ${h.emissions.length}`);

    h.fastForward(1); // 10s exactly
    check('S1 one emission at the gate', h.emissions.length === 1,
          `got ${h.emissions.length}`);
    check('S1 emission dwell is flat 10', h.emissions[0]?.dwell === 10,
          `got ${h.emissions[0]?.dwell}`);
    check('S1 emission names the path', h.emissions[0]?.path === 'Notes/a.md',
          `got ${h.emissions[0]?.path}`);

    // Fractions floor: 10.5s of dwell would still report dwell 10 at the
    // crossing (flat value) — S1 pins the FLAT rule, not the clock's.
    const h2 = makeHarness(0);
    h2.gate.open('note-1', 'Notes/b.md');
    h2.fastForward(10_500);
    check('S1 overshoot still one emission, flat 10',
          h2.emissions.length === 1 && h2.emissions[0]?.dwell === 10,
          `got ${h2.emissions.length}, ${h2.emissions[0]?.dwell}`);
}

// -----------------------------------------------------------------------------
// S2 — Accumulation across openings
// -----------------------------------------------------------------------------

function s2Accumulation(): void {
    console.log('=== F09: S2 — accumulation across openings ===');
    const h = makeHarness(0);

    // Visit 1: 8s, then switch away (workspace empties).
    h.gate.open('note-1', 'Notes/a.md');
    h.fastForward(8_000);
    h.gate.noFileOpen();

    // Visit 2: timer must arm for the REMAINING 2s, not a fresh 10s.
    h.gate.open('note-1', 'Notes/a.md');
    const armed = h.timers.filter((t) => !t.cancelled && !t.fired);
    check('S2 return visit arms exactly one timer', armed.length === 1,
          `got ${armed.length}`);
    check('S2 timer armed for the remaining 2s',
          armed[0]?.dueAt === 10_000, `dueAt=${armed[0]?.dueAt}, want 10000`);

    h.fastForward(2_000); // combined 10s
    check('S2 combined dwell crosses: one emission',
          h.emissions.length === 1, `got ${h.emissions.length}`);
    check('S2 emission dwell is flat 10 (not 8, not 2)',
          h.emissions[0]?.dwell === 10, `got ${h.emissions[0]?.dwell}`);

    // The negative space: 8s + 1s must NOT cross.
    const h2 = makeHarness(0);
    h2.gate.open('note-1', 'Notes/a.md');
    h2.fastForward(8_000);
    h2.gate.noFileOpen();
    h2.gate.open('note-1', 'Notes/a.md');
    h2.fastForward(1_000);
    check('S2 9s combined stays silent', h2.emissions.length === 0,
          `got ${h2.emissions.length}`);
}

// -----------------------------------------------------------------------------
// S3 — One event per crossing; no re-arm after emission
// -----------------------------------------------------------------------------

function s3NoRearm(): void {
    console.log('=== F09: S3 — emission resets; no second timer ===');
    const h = makeHarness(0);

    h.gate.open('note-1', 'Notes/a.md');
    h.fastForward(10_000); // crossing: 1 emission
    check('S3 first crossing emitted once', h.emissions.length === 1);

    check('S3 no timer re-armed after crossing', h.armedCount() === 0,
          `got ${h.armedCount()}`);

    // 25 more seconds of continued dwelling on the same open note.
    h.fastForward(25_000);
    check('S3 continued dwelling emits NOTHING further',
          h.emissions.length === 1, `got ${h.emissions.length}`);

    // The 25s banks toward the farewell flush only. Under-gate banked
    // dwell after an emission surfaces at sessionEnd — but 25s is
    // over-gate, so it MUST surface as a farewell (S4's lane; asserted
    // here so S3 and S4 jointly pin the full post-emission contract).
    const farewells = h.gate.sessionEnd();
    check('S3 post-emission dwell banks to exactly one farewell',
          farewells.length === 1, `got ${farewells.length}`);
    check('S3 farewell dwell is post-emission dwell (25s)',
          farewells[0]?.dwellSeconds === 25, `got ${farewells[0]?.dwellSeconds}`);
    check('S3 farewell names the path',
          farewells[0]?.path === 'Notes/a.md', `got ${farewells[0]?.path}`);
}

// -----------------------------------------------------------------------------
// S4 — Farewell: over-gate returned with real dwell; under-gate discarded
// -----------------------------------------------------------------------------

function s4Farewell(): void {
    console.log('=== F09: S4 — farewell gate ===');

    // (a) Under-gate, never crossed: silent.
    const ha = makeHarness(0);
    ha.gate.open('note-1', 'Notes/swipe.md');
    ha.fastForward(8_000);
    const fa = ha.gate.sessionEnd();
    check('S4a swipe-through (8s) discards at session end',
          fa.length === 0, `got ${fa.length}`);
    check('S4a swipe-through emitted nothing during the session',
          ha.emissions.length === 0, `got ${ha.emissions.length}`);

    // (b) Over-gate farewell: crossed at 10s, dwelt 15 more.
    const hb = makeHarness(0);
    hb.gate.open('note-1', 'Notes/long.md');
    hb.fastForward(10_000); // crossing
    hb.fastForward(15_000); // post-emission dwell
    const fb = hb.gate.sessionEnd();
    check('S4b over-gate farewell returned', fb.length === 1, `got ${fb.length}`);
    check('S4b farewell dwell is the post-emission 15s',
          fb[0]?.dwellSeconds === 15, `got ${fb[0]?.dwellSeconds}`);
    check('S4b farewell names the path',
          fb[0]?.path === 'Notes/long.md', `got ${fb[0]?.path}`);
    check('S4b exactly one session emission preceded it',
          hb.emissions.length === 1 && hb.emissions[0]?.dwell === 10);

    // (c) sessionEnd clears everything: a second call returns nothing.
    const fc = hb.gate.sessionEnd();
    check('S4c second sessionEnd returns nothing', fc.length === 0,
          `got ${fc.length}`);

    // (d) Two lanes, one over one under: only the over-gate farewell.
    const hd = makeHarness(0);
    hd.gate.open('note-1', 'Notes/over.md');
    hd.fastForward(10_000); // over.md crosses
    hd.fastForward(12_000); // banks 12s post-emission
    hd.gate.open('note-2', 'Notes/under.md'); // banks over.md, fresh lane
    hd.fastForward(4_000); // under.md: 4s, never crosses
    const fd = hd.gate.sessionEnd();
    check('S4d exactly one farewell (the over-gate lane)',
          fd.length === 1, `got ${fd.length}`);
    check('S4d the farewell is the over-gate lane',
          fd[0]?.path === 'Notes/over.md' && fd[0]?.dwellSeconds === 12,
          `got ${JSON.stringify(fd[0])}`);
}

// -----------------------------------------------------------------------------
// S5 — Collision fix: distinct ids at the same path
// -----------------------------------------------------------------------------

function s5Collision(): void {
    console.log('=== F09: S5 — collision fix (noteId keying) ===');
    const h = makeHarness(0);

    // The live-observed wart's shape: first Untitled creation dwells
    // BELOW the gate (8s) and is abandoned. A new creation reuses the
    // same path. Under path keying, the newcomer inherits the 8s and
    // fires 2s in. Under noteId keying, it starts at zero.
    h.gate.open('note-1', 'Notes/Untitled.md');
    h.fastForward(8_000);
    h.gate.noFileOpen(); // abandon below the gate

    h.gate.open('note-2', 'Notes/Untitled.md'); // DISTINCT id, SAME path
    h.fastForward(3_000);
    check('S5 newcomer inherits nothing (no emission at 3s)',
          h.emissions.length === 0,
          `got ${h.emissions.length} — accrual leaked across creations`);
    check('S5 no timer fired early',
          h.timers.every((t) => t.fired === false || t.dueAt >= 18_000),
          'a timer fired before the newcomer banked 10s of its own');

    h.fastForward(7_000); // newcomer's own 10s complete
    check('S5 newcomer crosses on ITS OWN dwell',
          h.emissions.length === 1, `got ${h.emissions.length}`);
    check('S5 newcomer emission is flat 10 at the shared path',
          h.emissions[0]?.dwell === 10 && h.emissions[0]?.path === 'Notes/Untitled.md',
          `got ${JSON.stringify(h.emissions[0])}`);

    // Symmetric control: the SAME id reopening DOES accumulate (S2
    // already proves it, but this pins that id-keying did not break
    // same-note accumulation — the fix must narrow the blast radius).
    const h2 = makeHarness(0);
    h2.gate.open('note-1', 'Notes/same.md');
    h2.fastForward(6_000);
    h2.gate.noFileOpen();
    h2.gate.open('note-1', 'Notes/same.md');
    h2.fastForward(4_000); // 6 + 4 = 10s same note
    check('S5 same-note reopen still accumulates',
          h2.emissions.length === 1, `got ${h2.emissions.length}`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function main(): void {
    s1Threshold();
    s2Accumulation();
    s3NoRearm();
    s4Farewell();
    s5Collision();
    console.log('');
    if (failures === 0) {
        console.log(`F09: ALL GREEN (${checks} checks, 5 scenarios)`);
        console.log('F09: dwell gate v1 + collision fix SURVIVED THE FIXTURE');
    } else {
        console.log(`F09: ${failures} RED (out of ${checks} checks)`);
    }
}

main();
process.exitCode = failures === 0 ? 0 : 1;
