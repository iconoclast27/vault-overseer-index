// =============================================================================
// Vault Overseer — Plugin Entry (main)
// src/main.ts
//
// The Obsidian bootstrap: resolve machine identity, run startup checks,
// construct the EventLog writer, verify the checkpoint chain, run the
// F03 heal scan, and expose the Plugin 2 seam. Everything here is wiring;
// the spine's semantics live in src/eventlog/*.
//
// 0.1.7-bound — PLANNER WIRING (frontier slot 4, 2026-10-29):
//
//   The note.modified producer (src/planner/planner.ts, rev A, F08-
//   certified 2026-10-28) becomes a real pipeline producer. Adapter
//   obligations per the planner's own header: map TAbstractFile ->
//   onVaultModify, call cancelPending from the delete and rename
//   handlers, arm() at writer attach, supply the scheduler.
//
//   - LISTENER: vault.on('modify') registers at layout-ready alongside
//     create/delete (Option-A consistency). PARTIAL RECEIPT (2026-10-29,
//     via typecheck): the callback parameter is TAbstractFile per
//     obsidian.d.ts typings — first draft wrongly assumed TFile and the
//     compiler caught it (TS2739 at the registration site). Handler now
//     guards with instanceof TFile, same pattern as create/delete. LINE
//     CITATION still owed — verify the obsidian.d.ts line number before
//     merge; the shape is typecheck-verified, the citation is not.
//   - ROUTING (ruled 2026-10-29): routeCreate AND routeRestore both
//     forward through the watcher lane's create path, GUARDED. Dead-on-
//     spine + alive-on-disk re-creating is exactly reconcile's S13
//     semantics; spine-unknown paths likewise converge on creation. A
//     vanished path throws inside stat — caught, disclosed via
//     reportIntegrity, never propagated: a routing throw must not kill
//     the flush loop.
//   - SCHEDULER (ruled in): window.setTimeout/clearTimeout — automatic
//     30s coalescing windows. Without it the lane is manual-flush-only.
//   - ARM ORDER (ruled): after watcherLane.flushAfterAttach() in
//     startWriter, so the planner's first flush reads a spine that
//     already contains the drained dark facts — routing decisions are
//     made against complete truth.
//   - STAT/SHA: extracted from the watcher's inline closures to private
//     helpers, shared with the planner lane (flagged refactor, 2026-10-
//     29 — behavior-identical, same error messages, one implementation
//     of the 16-hex sha convention instead of two).
//
//   DECLARED LIMITATIONS (loud, not hidden):
//   - Boot-window modifies (onload -> layout-ready) are missed —
//     heal-covered, same regime as Option A's create window.
//   - NO farewell flush at unload: onunload is synchronous and the
//     planner's flush is async behind a mergeScan — its appends would
//     race dispose()'s queue join and drop on this.log = null.
//     Unload-window loss extends the planner's declared crash-window
//     limitation; boot-heal is the recovery path.
//   - FOLDER-RENAME STALE-PENDING GAP (registered, unmitigated in v1):
//     a pending modify under a renamed folder SURVIVES the rename —
//     folder renames emit no spine event (folder.renamed still pending
//     transcription) and the planner exposes no prefix cancel — so the
//     flush emits note.modified against the STALE address. Bounded:
//     the projection already considered the path live, heal covers the
//     divergence. Systemic fix: folder.renamed + planner rev B
//     cancelPrefix (mirroring gate.renamePrefix) — a ruled design
//     change, not adapter territory.
//   - asModifiedPayload joins the registered bridge-debt family
//     (f12.ts, watcher closure, this one) — typing watch.ts's payload
//     surface at source retires all three.
//
// 0.1.6-bound — RECONCILE GATE (B3, 2026-10-25):
//
//   Two doors, one routine:
//     1) Automatic gate at arming: inside onLayoutReady, after listener
//        registration, compute the live-set diff (spine vs vault via
//        getMarkdownFiles(), l.10418), call reconcilePaths only if the
//        diff is non-empty, and emit a loud log.integrity declaring the
//        count when backfill happens.
//     2) Manual settings button: "Reconcile with vault" — same diff,
//        feeds the lane's return count into a Notice toaster.
//   Plus a third door discovered while wiring: certifyOrigin() calls the
//   same routine after startWriter, because on a virgin install the
//   automatic gate fires BEFORE certification (log === null) and refuses.
//   Without this, the exact case B3 exists to seal — fresh spine,
//   installation black hole — would wait on a human pressing a button.
//
//   Gate doctrine: runs EVERY arming (not just "fresh spine"), keyed on
//   the diff, not the spine age. Idempotence (F12 S10) makes it free when
//   clean; crash-mid-backfill self-heals on the next boot (S11). The
//   caller holds no freshness state.
//
//   GAP REFUSAL (F03 doctrine): mergeScan halts a gapped shard and
//   returns only the pre-gap events. Folding a projection from that
//   truncated stream would UNDERSTATE the live-set, and reconcile would
//   then FABRICATE note.created for paths the spine actually knows beyond
//   the gap — a never-fabricate violation, the exact crime the gap-refusal
//   lane exists to prevent. So reconcile refuses across a gapped spine,
//   loudly, with its own return code (-2). Same posture as heal.
//
//   SEQUENCING (single pass, honest): On a Rung-1 boot, startWriter runs
//   to completion in onload, calling flushAfterAttach() at its end. By the
//   time onLayoutReady fires, the lane is ALREADY ARMED — no dark refusal
//   is possible on this path. The single pass folds its diff post-arming,
//   which is what S12 requires.
//
//   TWO-BOOT VISIBILITY (declared consequence, not a bug): healScan runs
//   inside startWriter, BEFORE arming; reconcile runs after, in
//   onLayoutReady. So on boot 1 the spine learns every first-contact path
//   but heal has already run against the pre-backfill spine and indexed
//   nothing. Boot 2's heal sees the paths and indexes the vault. Benign —
//   content is never lost, only deferred one boot. Collapsing it to one
//   boot means arming the lane BEFORE healScan, which is a design change
//   to code Option A already live-verified; OPEN RULING, not taken here.
//
//   DOUBLE-EMIT WINDOW (declared, narrow): listeners register first,
//   reconcile reads the spine after. A create arriving in that window is
//   buffered by the lane but not yet on disk when the diff folds, so
//   reconcile re-emits it — a duplicate note.created. Harmless: the
//   projection fuses duplicate creates on one path into a single live
//   entry, and the second emission carries fresher stat/sha. Accepted to
//   keep the pass single and the arming window short. Closing it means
//   swapping the order (reconcile, THEN register listeners) at the cost of
//   a longer window in which real events are missed. OPEN RULING.
//
//   SPINE READ: mergeScan() from reader.ts — the same disciplined door
//   heal uses (torn-tail aware, contiguity-checked, gap-reporting).
//   Projection via projectPaths() — shared with heal, single
//   implementation, no second dialect of "what does the spine say exists."
//
// 0.1.6-bound — WATCHER REGISTRATION DEFERRAL (Option A, 2026-10-25):
//
//   The create/delete listeners now register INSIDE
//   workspace.onLayoutReady (obsidian.d.ts l.10740), per the API's own
//   instruction in the vault.on('create') doc block (l.10429): "If you
//   do not wish to receive create events on vault load, register your
//   event handler inside Workspace.onLayoutReady."
//
//   WHY (live-observed 2026-10-25): Obsidian fires vault.on('create')
//   for EVERY pre-existing file while indexing the vault at boot.
//   Registration in onload heard the firestorm as user creation —
//   ~507 note.created per boot on the test vault, recurring on every
//   reload (shard growth 6974 -> 7487 lines across two boots, plus a
//   fresh-shard run where the 500-cap dark buffer absorbed the storm
//   and disclosed 6 dropped facts). The lane was innocent; the adapter
//   timing was wrong.
//
//   DECLARED LIMITATION (Option A, v1): genuine creates arriving in
//   the onload -> layout-ready window are MISSED. The window exists
//   only during boot, and nothing downstream starves — the heal scan
//   indexes content independently of note.created. Option B (deliberate
//   backfill at arming via getMarkdownFiles(), l.10418) is the ratified
//   successor, NOW IMPLEMENTED as the B3 gate above: the spine gains a
//   controlled, uncapped first-contact snapshot so a fresh shard learns
//   the world.
//
// 0.1.5-bound — RENAME WIRING (F05a, ratified 2026-10-24):
//
//   The plugin's second vault event: 'rename' — vault.on('rename',
//   (file: TAbstractFile, oldPath: string), obsidian.d.ts l.10451,
//   verified 2026-10-24). The handler branches on which arrived:
//
//   - TFile   => note.renamed {from, to} through the writer (Tier-1
//                write-through — renames are file facts, loss on
//                crash is not tolerated. Verified against
//                TIER2_TYPES 2026-10-24: the Tier-2 set contains
//                note.opened/chunk.* only, so note.renamed routes
//                write-through, with the Tier-2 buffer carried
//                ahead of it so disk order == seq order. Actor
//                'user' — the rename is the human's act, recorded
//                by instrument). Drops while the writer is dark,
//                like every adapter emission (declared v1
//                limitation). The gate's lanes are rewritten in the
//                same handler, so in-flight accrual and future
//                emissions name the new path.
//   - TFolder => gate.renamePrefix(oldPath, file.path): a folder
//                rename mass-invalidates every storage address under
//                it (notes, attachments, embeds; linked or not — links
//                are maintained by Obsidian and unaffected). Spine
//                emission (folder.renamed) is PENDING a types.ts
//                ruling: a new event type transcribes only against
//                its fixture-loaded consumer, and the index's
//                subscriber seam is the committed future consumer.
//                Until ruled, the branch rewrites gate prefixes and
//                emits nothing.
//
//   OWNING WART KILLED: placeholder-path emissions are CORRECTABLE.
//   file-open fires on note CREATE before the title is typed; an
//   emission crossing before the rename still records
//   Notes/Untitled.md, but note.renamed now sits beside it on the
//   spine, so the projection resolves the chain. The uncorrectable
//   placeholder is dead; the correctable one is declared v1 behavior.
//
//   Ontology ruling (2026-10-24): folders are administrative grouping
//   (PARA); the organic organization is the LINK GRAPH, the index's
//   province. Paths are storage addresses, not relationships.
//
// 0.1.4-bound — DWELL-GATE EXTRACTION (ratified 2026-10-24):
//
//   The dwell gate's semantics moved to src/dwell/gate.ts (pure module,
//   injectable clock + timer, emit via callback — same seam shape as
//   EventLog's `now`). main.ts is now a thin adapter, per the header
//   doctrine above: wiring here, semantics in modules. The extraction
//   carries a behavior fix, ratified 2026-10-24:
//
//   - COLLISION FIX: the accrual map keys by opaque note-id derived
//     from TFile identity (WeakMap<TFile, string>), not by path.
//     Obsidian reuses `Notes/Untitled.md` for successive new-note
//     creations; path keying let a later creation inherit a
//     predecessor's banked dwell and fire early (live-observed
//     2026-10-23, F09-family wart #2). Distinct TFiles now have
//     distinct ids — no inheritance. F09 (src/fixtures/f09.ts) is
//     the fixture earning this.
//   - REMAINING DECLARED WART (superseded by F05a, 2026-10-24, kept
//     for the record): placeholder-path emissions were uncorrectable
//     until note.renamed was wired. Now correctable — see the
//     0.1.-bound block above.
//
//   Farewell ordering doctrine, unchanged: onunload() is SYNCHRONOUS
//   and enqueues farewell dwell events into the serialized write
//   queue BEFORE dispose() is called — the queue's serialization,
//   plus this ordering, makes the farewell race structurally
//   impossible.
//
// 0.1.3-bound — F03 HEAL SCAN WIRING (ratified 2026-10-23):
//
//   healScan() now runs inside startWriter, after the chain-verification
//   fold and after the session.opened beacon. Placement doctrine: the
//   writer must exist (heal appends chunk.indexed + log.integrity); the
//   beacon lands FIRST so the session record precedes derived
//   re-derivation work; the heal owns its own refusal lane (seq gaps =>
//   loud refusal, never-fabricate) independent of chain verification.
//   Wrapped in its own guard so a heal throw reports through the ledger
//   instead of escaping onload — same doctrine as the chain fold.
//
//   Runtime receipt owed: heal.ts uses the Node `Buffer` global in its
//   P1 re-render path. The require('os') spike proved the renderer
//   accepts CommonJS, so Buffer is expected present — but esbuild does
//   not verify globals, and the P1 lane only executes when chunk
//   records exist. Verify with `typeof Buffer` in devtools before
//   trusting the first healed shard.
//
// 0.1.2 — RUNG 3 DELETED (design ratified 2026-10-23):
//
//   The former Rung 3 (virgin install => os.hostname() seed) never
//   called writeOriginFile() while startWriter claimed it had — a
//   never-fabricate violation, dormant only because every machine
//   took Rung 2. Identity-by-inference also contradicts the ladder's
//   own principle, and hostname produces junk names besides. The os
//   import is deleted with it. Virgin installs now fall through to
//   Rung 2 with an EMPTY candidate list: the human declares the id
//   via the certification surface; the writer stays dark until then.
//
// The ladder as it now stands (designed 2026-10-23, shipped 0.1.1):
//
//   Rung 1  origin.txt in the plugin folder. A non-canonical file, so
//           Obsidian Sync structurally excludes it from ferrying;
//           BRAT updates touch only the canonical quartet, so it
//           survives releases. If present, that's the origin, period.
//   Rung 2  No origin.txt => the writer stays DARK, whether shards
//           exist or not. The settings surface lists any found shards
//           and demands HUMAN certification (continue an existing
//           shard or declare a new id; a virgin install simply gets
//           an empty candidate list). No machine ever infers identity
//           from synced state or from the OS. Certification is
//           logged as origin.migrated-interim.
//   Rung 4  data.json's origin field is NEVER read again. If present
//           it is scrubbed on load and the scrub is logged as a
//           settings.changed-interim event. It is NOT a migration
//           source — auto-lifting it gambles on a sync-conflict coin
//           toss.
//
// 0.1.2 — DWELL-GATE SEMANTICS (v1, ratified 2026-10-23; enforcement
//   now lives in src/dwell/gate.ts, extracted 2026-10-24):
//
//   note.opened fires when a note's accrued dwell crosses the 10s gate.
//     - Threshold-only emission: no note-close event listening (the
//       Obsidian close path is messy; the gate alone filters noise).
//     - Flat exposure weight 1; the gate suppresses noise, it does
//       not grade heat.
//     - Dwell ACCUMULATES across separate openings of the same note
//       within a session: abandon at 8s, return later, the timer arms
//       for the remaining 2s. Multiple openings reaching a combined
//       threshold fire one event.
//     - One event per gate crossing; emission resets that note's
//       accrual. Continued dwelling after an emission banks toward
//       the farewell flush only — NO second timer re-arms after a
//       crossing.
//     - Farewell (onunload): the gate applies at session end too —
//       dwell below 10s emits NOTHING (per Fixture Corpus F09;
//       ratified 2026-10-23). Dwell events are enqueued before
//       dispose() so the serialized write queue flushes them ahead
//       of the farewell drain.
//   v1 limitations (declared, not hidden):
//     - Threshold emissions carry dwell=10 flat; richer dwell values
//       belong to a close-emit world this version does not build.
//     - Dwell banked while the writer is dark (Rung-2 pending,
//       foreign-origin block) is lost.
//     - The accrual map is session-scoped, one entry per distinct
//       note opened; no persistence across reloads.
//     - Placeholder-path emissions remain until F05 rename wiring
//       (note.renamed not yet listened for).
//
//   API receipts: on('file-open', (file: TFile | null) => any, ctx?)
//   — obsidian.d.ts l.11041. Verified 2026-10-23.
//   on('rename', (file: TAbstractFile, oldPath: string) => any, ctx?)
//   — obsidian.d.ts l.10451. Verified 2026-10-24. TFolder instanceof
//   disambiguates; folder renames arrive on the same event (no
//   separate folder-rename hook exists).
//   on('modify', (file: TAbstractFile) => any, ctx?) — SHAPE
//   VERIFIED via typecheck 2026-10-29 (callback param is
//   TAbstractFile per obsidian.d.ts typings; first draft wrongly
//   assumed TFile — TS2739 caught it). LINE CITATION still owed.
//   onLayoutReady(callback: () => any): void — obsidian.d.ts l.10740,
//   with the create-at-load guidance at l.10429. Verified 2026-10-25.
//   getMarkdownFiles(): TFile[] — obsidian.d.ts l.10418. Verified
//   2026-10-25 (Option B ammunition; now load-bearing for B3).
//
// 0.1.2 — CHAIN-VERIFICATION REPORT FOLD (ratified 2026-10-23):
//
//   The 0.1.1 startWriter ran verifyChain once inside a try/catch but
//   recorded the failure in a SEPARATE trailing block that re-ran
//   verifyChain unguarded. Defects: two full shard reads per boot;
//   notice and ledger could disagree (the reads sandwich this
//   plugin's own Tier-1 appends, plus Sync's mid-flight arrivals);
//   the throw path double-reported with different wording; and the
//   unguarded second call could throw past onload, killing the
//   session.opened beacon — the integrity recorder silencing
//   the session record. Fold: ONE read, ONE report, one channel.
//
// Consequence: data.json carries shared knobs only. Per-device state
// lives in sync-excluded lanes (origin.txt) or it isn't safe.
//
// TYPECHECK FIX (2026-10-29, three contained fixes):
//   1. `settings` redeclared over Plugin's base property (TS2612):
//      definite-assignment assertion (`!`) still emits a field define
//      that would overwrite the base — replaced with `declare`, which
//      emits nothing and lets loadSettings remain the sole assigner.
//   2. `this.app.setting` (TS2339): Obsidian's public App typings lack
//      the internal settings-tab surface this certification path uses
//      to force a redraw. Contained structural cast at the one call
//      site; named, not hidden.
//   3. Watcher appendEvent payload bridge (TS2345): the watcher lane's
//      dep surface carries shape-loose payloads while the typed log API
//      demands the discriminated union — same bridge as f12.ts's
//      asTypedPayload (Option B, 2026-10-29). REGISTERED DEBT, shared
//      with the fixture: typing watch.ts's payloads at source retires
//      both bridges. Keep the two copies in sync until then.
// =============================================================================

import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TAbstractFile,
    TFile,
    TFolder,
    normalizePath,
} from 'obsidian';

import { EventLog, defaultLocalIso } from './eventlog/eventlog.ts';
import { startupChecks, mergeScan } from './eventlog/reader.ts';
import { verifyChain } from './eventlog/checkpoint.ts';
import { healScan } from './eventlog/heal.ts';
import { projectPaths } from './eventlog/projection.ts';
import { DwellGate } from './dwell/gate.ts';
import { makeWatcherLane } from './watcher/watch.ts';
import { makePlanner } from './planner/planner.ts';
import type { PlannerLane } from './planner/planner.ts';
import type {
    NoteCreatedPayload,
    NoteDeletedPayload,
    VaultOverseerEvent,
} from './eventlog/types.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const EVENTS_DIR = '_vault-index/events';
const ORIGIN_FILE = 'origin.txt';

// The dwell gate's threshold (10s) and all gate semantics live in
// src/dwell/gate.ts. Promoting it to a shared data.json knob is future
// icing (it only tunes behavior — the moment a setting changes WHAT
// gets logged, it moves to sync-excluded lanes).

// Reconcile return codes. Positive = paths emitted. Negative = refusal,
// with the reason distinguishable so both doors can say why.
const RECONCILE_REFUSED_DARK = -1;
const RECONCILE_REFUSED_GAP = -2;

// -----------------------------------------------------------------------------
// Settings — shared knobs ONLY (data.json rides Sync; identity does not)
// -----------------------------------------------------------------------------

export interface VaultOverseerSettings {
    /**
     * Intentionally empty in 0.1.1. Any future knob placed here MUST be
     * machine-independent — per-device state belongs in non-canonical
     * files like origin.txt, which Sync structurally excludes. R8's
     * fire alarm (settings.changed) polices chatter here.
     */
}

const DEFAULT_SETTINGS: VaultOverseerSettings = {};

/**
 * Typed bridge from the watcher lane's shape-loose payload to the typed
 * log API (typecheck fix, 2026-10-29 — same registered debt as f12.ts's
 * asTypedPayload; retire both by typing watch.ts at source). The lane's
 * own producer code constructs these payloads; this cast is contained at
 * the adapter boundary, not sprinkled.
 */
function asTypedPayload(p: unknown): NoteCreatedPayload | NoteDeletedPayload {
    return p as NoteCreatedPayload | NoteDeletedPayload;
}

/**
 * Typed bridge for the planner lane's shape-loose payload (slot 4 wiring,
 * 2026-10-29) — third member of the registered bridge-debt family
 * (f12.ts, the watcher closure above, this one). Built on Extract rather
 * than a named payload type: whether types.ts exports a NoteModifiedPayload
 * alias is unverified this session — swap for the named import if it
 * exists. Retire all three by typing the producing modules at source.
 */
function asModifiedPayload(
    p: unknown,
): Extract<VaultOverseerEvent, { type: 'note.modified' }>['payload'] {
    return p as Extract<VaultOverseerEvent, { type: 'note.modified' }>['payload'];
}

// -----------------------------------------------------------------------------
// Adapter — Obsidian's DataAdapter behind the log's structural interface
// -----------------------------------------------------------------------------

/**
 * Thin wrapper: normalizes paths and maps list() to bare names. Satisfies
 * the EventLog's LogAdapter, the reader's ByteSource, and the watcher's
 * dep surface — one adapter, one filesystem view. Plugin-folder paths
 * (origin.txt) also route through here; the vault-relative path passed by
 * the caller already contains the plugin folder segment.
 *
 * 2026-10-25 (B3): promoted to a plugin field so reconcile can read the
 * spine via mergeScan without inventing accessors on EventLog (whose
 * `adapter` is private — a ghost-API trap avoided).
 */
class VaultLogAdapter {
    constructor(private readonly inner: App['vault']['adapter']) {}

    async mkdir(path: string): Promise<void> {
        await this.inner.mkdir(normalizePath(path));
    }

    async write(path: string, data: string): Promise<void> {
        await this.inner.write(normalizePath(path), data);
    }

    async append(path: string, data: string): Promise<void> {
        await this.inner.append(normalizePath(path), data);
    }

    async exists(path: string): Promise<boolean> {
        return await this.inner.exists(normalizePath(path));
    }

    async readBinary(path: string): Promise<Uint8Array | undefined> {
        const p = normalizePath(path);
        if (!(await this.inner.exists(p))) return undefined;
        const buf = await this.inner.readBinary(p);
        return new Uint8Array(buf);
    }

    async readUtf8(path: string): Promise<string | undefined> {
        const p = normalizePath(path);
        if (!(await this.inner.exists(p))) return undefined;
        const bytes = new Uint8Array(await this.inner.readBinary(p));
        return new TextDecoder('utf-8').decode(bytes);
    }

    async listDir(path: string): Promise<string[]> {
        const listing = await this.inner.list(normalizePath(path));
        return listing.files
        .map((f) => f.slice(f.lastIndexOf('/') + 1))
        .sort();
    }
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

async function sha256Hex(text: string, len = 16): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text),
    );
    return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, len);
}

// -----------------------------------------------------------------------------
// Origin resolution — the ladder
// -----------------------------------------------------------------------------

interface OriginResolution {
    /** Resolved machine identity. null => Rung 2: needs certification. */
    origin: string | null;
    /** Shard names found in the events dir, for the certification surface. */
    foundShards: string[];
    /** Origin ids extracted from shard filenames, sorted. */
    foundOrigins: string[];
    /** True when origin.txt existed and supplied the identity. */
    fromOriginFile: boolean;
}

/**
 * The ladder, in ratified priority order. Reads origin.txt (Rung 1),
 * inventories shards (Rung 2's evidence), and NEVER consults data.json's
 * origin field (Rung 4 — that field is scrubbed separately in
 * loadSettings and is not a migration source).
 */
async function resolveOrigin(
    adapter: VaultLogAdapter,
    pluginFolder: string,
): Promise<OriginResolution> {
    // Rung 1: origin.txt in the plugin folder — that's the origin, period.
    // Non-canonical file: structurally excluded from Sync, untouched by BRAT.
    const originPath = `${pluginFolder}/${ORIGIN_FILE}`;
    if (await adapter.exists(originPath)) {
        const raw = await adapter.readUtf8(originPath);
        const candidate = raw?.trim() ?? '';
        if (candidate.length > 0) {
            return {
                origin: candidate,
                foundShards: [],
                foundOrigins: [],
                fromOriginFile: true,
            };
        }
        // An EMPTY origin.txt is a dead lane, not a Rung-1 hit. Fall
        // through to Rung 2 — an empty file certifies nothing.
    }

    // Rung 2 evidence: what shards exist? Ferried identity is not
    // consulted here — only file NAMES, which are structure, not state.
    let foundShards: string[] = [];
    if (await adapter.exists(EVENTS_DIR)) {
        foundShards = (await adapter.listDir(EVENTS_DIR)).filter((n) =>
        n.endsWith('.jsonl'),
        );
    }
    const foundOrigins = foundShards
    .map((n) => n.replace(/\.jsonl$/, ''))
    .sort();

    // Rung 2 — covers BOTH cases since 0.1.2 deleted Rung 3:
    //   shards exist => list them as certification candidates
    //   no shards (virgin install) => empty candidate list
    // Either way the human certifies; the machine never infers
    // identity from ferried state or from the OS. The writer stays
    // dark until certification happens via the settings surface.
    return {
        origin: null,
        foundShards,
        foundOrigins,
        fromOriginFile: false,
    };
}

/**
 * Rung 2 completion: persist the certified/chosen id to origin.txt,
 * creating the sync-excluded identity lane. Called only from
 * the certification surface (Rung 2) — the only path that creates
 * origin.txt, since Rung 3 was deleted in 0.1.2.
 */
async function writeOriginFile(
    adapter: VaultLogAdapter,
    pluginFolder: string,
    origin: string,
): Promise<void> {
    const originPath = `${pluginFolder}/${ORIGIN_FILE}`;
    await adapter.write(originPath, `${origin}\n`);
}

// -----------------------------------------------------------------------------
// Plugin
// -----------------------------------------------------------------------------

export default class VaultOverseerIndex extends Plugin {
    /**
     * `declare` (typecheck fix 2026-10-29): the former `!` assertion
     * still emitted a field define overwriting Plugin's base property.
     * Declare emits nothing; loadSettings is the sole assigner.
     */
    declare settings: VaultOverseerSettings;

    log: EventLog | null = null;

    /** The resolved machine identity — never sourced from data.json. */
    originId: string | null = null;

    /**
     * Rung 2 pending: origin ids awaiting human certification. Empty
     * (but non-null) for a virgin install — no shards, no candidates.
     */
    pendingCertification: string[] | null = null;

    /** True after onload when the foreign-origin guard fired — writer refused. */
    writerBlocked = false;

    /**
     * True if startup chain verification failed: the shard's checkpoint
     * digest does not match its contents. The writer STILL RECORDS
     * (see onload rationale) — this flag drives the settings-tab
     * warning only.
     */
    chainBroken = false;

    /**
     * data.json carried a legacy `origin` field that was scrubbed at
     * load. Logged once the writer exists; surfaced in settings so the
     * scrub is never silent.
     */
    private scrubbedLegacyOrigin: string | null = null;

    /**
     * The vault-facing adapter (B3, 2026-10-25). Promoted from a local in
     * onload/certifyOrigin so reconcile can reach mergeScan's ByteSource
     * door. Set first thing in onload; null only before that.
     */
    private adapter: VaultLogAdapter | null = null;

    // --- Dwell-gate adapter state (semantics live in src/dwell/gate.ts) ---

    /**
     * The pure gate, wired to this plugin's writer. Field initializer
     * is safe: the emit closure captures `this` lazily, so the gate
     * exists before onload but cannot emit into a dark writer.
     */
    private readonly dwellGate = new DwellGate({
        emit: (path, dwell) => this.emitDwell(path, dwell),
    });

    // --- Watcher lane adapter state (semantics live in src/watcher/watch.ts) ---

    /**
     * The pure watcher lane, wired to this plugin's writer. Field
     * initializer is safe: the deps closures capture `this` lazily,
     * so the lane exists before onload but cannot emit into a dark
     * writer. Dark-buffer cap defaults to 500 per session ruling
     * 2026-10-25.
     *
     * Slot-4 refactor (2026-10-29): stat/sha extracted to private
     * helpers, shared with the planner lane — behavior-identical,
     * same error messages.
     */
    private readonly watcherLane = makeWatcherLane(
        {
            stat: (path: string) => this.statSnapshot(path),
                                                   contentSha: (path: string) => this.contentShaOf(path),
                                                   appendEvent: async (actor, type, payload) => {
                                                       if (this.log === null) return; // writer dark: drop
                                                       await this.log.appendEvent(actor, type, asTypedPayload(payload));
                                                   },
                                                   reportIntegrity: async (detail) => {
                                                       if (this.log === null) return;
                                                       await this.log.reportIntegrity(detail);
                                                   },
        },
        { darkBufferCap: 500 },
    );

    // --- Planner lane adapter state (semantics live in src/planner/planner.ts) ---

    /**
     * The pure planner lane (note.modified producer, F08-certified),
     * wired to this plugin's writer. NULL until onload constructs it
     * (the lane's context needs the adapter, which exists only after
     * onload's first statement); optional-chained call sites treat
     * null as a no-op. ARMED only inside startWriter, after the
     * watcher's drain — pre-arm observations are dropped (Q3,
     * heal-covered), matching the planner's declared lifecycle.
     */
    private plannerLane: PlannerLane | null = null;

    /** Sequential counter backing the TFile->noteId map. */
    private noteIdCounter = 0;

    /**
     * Opaque note-id per TFile (collision fix, 2026-10-24). Obsidian
     * reuses `Notes/Untitled.md` across successive creations; keying
     * accrual by PATH let a new creation inherit a dead predecessor's
     * banked dwell. WeakMap<TFile, string> gives every distinct file
     * object its own id for the session — same path, different note,
     * different lane. The map itself is session-scoped and garbage
     * collects with the TFiles.
     */
    private readonly noteIdMap = new WeakMap<TFile, string>();

    async onload(): Promise<void> {
        await this.loadSettings();

        this.adapter = new VaultLogAdapter(this.app.vault.adapter);

        // Planner lane (slot 4, 2026-10-29): constructed once the
        // adapter exists; observations are dropped pre-arm (Q3,
        // heal-covered) until startWriter arms it after the watcher's
        // drain — the same lifecycle shape as the watcher lane, one
        // boot stage later. Scheduler wired: automatic 30s coalescing
        // windows via DOM timers (the electron renderer's window is
        // the ambient clock; handles are numbers on this platform).
        this.plannerLane = makePlanner(
            {
                stat: (path: string) => this.statSnapshot(path),
                                       contentSha: (path: string) => this.contentShaOf(path),
                                       appendEvent: async (actor, type, payload) => {
                                           if (this.log === null) return; // writer dark: drop
                                           await this.log.appendEvent(actor, type, asModifiedPayload(payload));
                                       },
                                       reportIntegrity: async (detail) => {
                                           if (this.log === null) return;
                                           await this.log.reportIntegrity(detail);
                                       },
                                       // Routing (ruled 2026-10-29): both hooks forward through
                                       // the create lane, guarded — see routeToCreateLane.
                                       routeCreate: (path) => this.routeToCreateLane(path, 'spine-unknown'),
                                       routeRestore: (path) => this.routeToCreateLane(path, 'spine-dead'),
                                       scheduler: {
                                           setTimer: (cb, ms) => window.setTimeout(cb, ms),
                                       clearTimer: (handle) => window.clearTimeout(handle),
                                       },
            },
            {
                source: this.adapter,
                eventsDir: EVENTS_DIR,
            },
            {
                windowMs: 30_000, // the map's debouncer figure
                maxPending: 500, // dark-buffer precedent
            },
        );

        // manifest.dir is the vault-relative path to this plugin's
        // folder (obsidian.d.ts l.7378-7381). Typed optional; the
        // fallback is defensive only — dir is always set at runtime
        // for an installed plugin.
        const pluginFolder =
        this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

        const resolution = await resolveOrigin(this.adapter, pluginFolder);

        if (resolution.origin === null) {
            // Rung 2: no origin.txt — shards may or may not exist. Writer
            // stays DARK — no EventLog is constructed, so no shard is
            // touched while identity is uncertified. Certification
            // surface lives in the settings tab (also reachable
            // immediately).
            this.pendingCertification = resolution.foundOrigins;
            new Notice(
                'Vault Overseer: no origin.txt — open Settings -> Vault ' +
                'Overseer to certify this machine\'s identity.',
                15000,
            );
        } else {
            await this.startWriter(this.adapter, resolution.origin, resolution.fromOriginFile);
        }

        // Dwell-gate wiring. registerEvent cleans up automatically on
        // unload — no manual offref bookkeeping. Tracked even while the
        // writer is dark; emissions are simply dropped until the writer
        // exists (declared v1 limitation).
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => this.onFileOpen(file)),
        );

        // Rename wiring (F05a, 2026-10-24). Same registerEvent doctrine:
        // tracked even while the writer is dark; note.renamed drops
        // silently (declared v1 limitation) while gate rewrites still
        // happen — the gate's truth must not depend on the writer's mood.
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)),
        );

        // Watcher wiring (F12, 2026-10-25) — DEFERRED to layout-ready
        // (Option A). Per the API's own guidance in the vault.on
        // ('create') doc block (obsidian.d.ts l.10429), registering the
        // create handler in onload hears the boot-indexing firestorm —
        // one 'create' per pre-existing file — as user creation (live
        // observed 2026-10-25: ~507 note.created per boot, recurring
        // every reload). onLayoutReady (l.10740) fires after indexing,
        // so the listeners wake into a quiet vault and hear only real
        // events.
        //
        // DECLARED LIMITATION (Option A, v1): a genuine create landing
        // between onload and layout-ready is missed — boot-window
        // only, nothing downstream starves (heal indexes content
        // independently). The B3 gate below closes the resulting
        // first-contact hole deliberately.
        //
        // registerEvent inside the callback still books cleanup for
        // unload; onLayoutReady runs the callback immediately when the
        // layout is already ready (reload-plugin path), so no
        // registration is ever skipped.
        //
        // B3 AUTOMATIC GATE — single pass, post-arming. On a Rung-1
        // boot, startWriter already ran to completion in onload
        // (including flushAfterAttach() at its end), so the lane is
        // ARMED by the time this fires; no dark refusal is possible on
        // this path. On a Rung-2 install the writer is still dark here
        // and this call refuses (-1) — certifyOrigin() reconciles after
        // certification instead. See the header for the declared
        // double-emit window and the two-boot visibility consequence.
        this.app.workspace.onLayoutReady(() => {
            this.registerEvent(
                this.app.vault.on('create', (file) => this.onVaultCreate(file)),
            );
            this.registerEvent(
                this.app.vault.on('delete', (file) => this.onVaultDelete(file)),
            );

            // Modify wiring (slot 4, 2026-10-29): registers with the
            // other vault listeners, Option-A consistency. Modifies
            // in the boot window are missed — heal-covered, same
            // regime as the create window (declared, see header).
            // Callback param is TAbstractFile per the typings (shape
            // receipt via typecheck 2026-10-29); onVaultModify guards
            // with instanceof TFile, same pattern as create/delete.
            this.registerEvent(
                this.app.vault.on('modify', (file) => this.onVaultModify(file)),
            );

            // Fire and forget: the gate owns its own reporting.
            void this.runReconcileWithVault();
        });

        this.addSettingTab(new OverseerSettingTab(this.app, this));
    }

    // ---------------------------------------------------------------------------
    // B3 reconcile (wiring: automatic gate + manual button + post-certification)
    // ---------------------------------------------------------------------------

    /**
     * Reconcile routine (B3): fold the spine's live-set via mergeScan +
     * projectPaths, diff against the vault's getMarkdownFiles(), and ask
     * the lane to emit note.created for the gaps. Idempotent against the
     * spine's own live-set (F12 S10), so a clean spine costs one fold and
     * emits nothing.
     *
     * PUBLIC because the settings tab calls it (cross-class).
     *
     * Returns: >= 0 = paths emitted; -1 = refused, writer dark;
     * -2 = refused, seq gap in the spine (never fabricate across a
     * truncated scan — F03 doctrine).
     */
    async runReconcileWithVault(): Promise<number> {
        if (this.log === null || this.adapter === null || this.originId === null) {
            // Writer dark (Rung 2 pending, foreign-origin block, or
            // unloaded). The automatic gate stays silent here; the
            // manual button explains itself.
            return RECONCILE_REFUSED_DARK;
        }

        // Read the spine through the disciplined door: torn-tail aware,
        // contiguity-checked, gap-reporting. Same scan heal uses.
        const scan = await mergeScan(this.adapter, EVENTS_DIR);

        // GAP REFUSAL (F03 doctrine). mergeScan HALTS a gapped shard and
        // returns only the pre-gap events. Projecting from that truncated
        // stream would understate the live-set, and reconcile would then
        // fabricate note.created for paths the spine knows beyond the
        // gap. Never fabricate: refuse, loudly, and name the gap.
        if (scan.gaps.length > 0) {
            const first = scan.gaps[0];
            if (first === undefined) return RECONCILE_REFUSED_GAP;
            const detail =
            `reconcile refused: seq gap in spine (origin=${first.origin}, ` +
            `expected_seq=${first.expected_seq}, got_seq=${first.got_seq}) — ` +
            'fix the gap before reconciling';
     console.error('[vault-overseer]', detail);
     new Notice(`Vault Overseer: ${detail}`, 15000);
     await this.log.reportIntegrity(detail);
     return RECONCILE_REFUSED_GAP;
        }

        // Torn tails and unreadable lines are reported by the scan but do
        // not invalidate the projection (they sit at the shard's end and
        // are discarded, not skipped mid-stream). Surface them anyway —
        // silence is disqualifying.
        if (scan.integrity.length > 0) {
            await this.log.reportIntegrity(
                `reconcile scan: ${scan.integrity.map((r) => r.detail).join('; ')}`,
            );
        }

        const proj = projectPaths(scan.events);
        const knownSet = proj.livePaths;

        const vaultPaths = this.app.vault.getMarkdownFiles().map((f) => f.path);
        const emitted = await this.watcherLane.reconcilePaths(vaultPaths, knownSet);

        if (emitted > 0) {
            new Notice(`Vault Overseer: reconciled ${emitted} paths`, 15000);
            await this.log.reportIntegrity(
                `reconcile: backfilled ${emitted} first-contact paths ` +
                `(origin=${this.originId})`,
            );
        }
        // emitted === 0: silent. A clean spine is the steady state; the
        // automated gate must not chatter on every boot.

        return emitted;
    }

    // ---------------------------------------------------------------------------
    // Dwell-gate adapter (thin wiring; semantics in src/dwell/gate.ts)
    // ---------------------------------------------------------------------------

    /**
     * file-open receipt (obsidian.d.ts l.11041): callback receives the
     * newly opened TFile, or null when no file is open. Null routes to
     * the gate's noFileOpen (banks outgoing dwell without emitting).
     */
    private onFileOpen(file: TFile | null): void {
        if (file === null) {
            this.dwellGate.noFileOpen();
            return;
        }
        this.dwellGate.open(this.getNoteId(file), file.path);
    }

    /**
     * Opaque note-id from TFile identity. First sighting assigns a fresh
     * id; every subsequent open of the SAME file object reuses it, so
     * dwell accumulates across openings of one note while distinct
     * creations of the same path never share a lane.
     */
    private getNoteId(file: TFile): string {
        let id = this.noteIdMap.get(file);
        if (id === undefined) {
            id = `note-${++this.noteIdCounter}`;
            this.noteIdMap.set(file, id);
        }
        return id;
    }

    /**
     * Tier-2 append through the writer's public API. Drops silently
     * while dark — declared v1 limitation. Fire-and-forget at the call
     * site: the writer's serialized queue orders the write; the gate's
     * callback does not need to await it to preserve ordering.
     */
    private async emitDwell(path: string, dwell: number): Promise<void> {
        if (this.log === null) return; // writer dark: Rung 2 pending or foreign-origin
        await this.log.appendEvent('user', 'note.opened', { path, dwell });
    }

    // ---------------------------------------------------------------------------
    // Rename adapter (thin wiring; F05a, 2026-10-24)
    // ---------------------------------------------------------------------------

    /**
     * Vault rename receipt (obsidian.d.ts l.10451): callback receives
     * the renamed TAbstractFile plus its old path. Branches on which
     * it got — file renames are our event (note.renamed, F05a); folder
     * renames rewrite the gate's prefixes (mass invalidation of
     * storage addresses; spine emission pending the types.ts ruling).
     */
    private onVaultRename(file: TAbstractFile, oldPath: string): void {
        if (file instanceof TFolder) {
            // Folder rename: every known path under oldPath/ is stale.
            // Rewrite the gate's addresses; emit nothing yet (pending
            // the folder.renamed transcription ruling).
            //
            // KNOWN GAP (slot 4, declared in the header): pending planner
            // modifies under this prefix SURVIVE the rename — the
            // planner has no prefix cancel. Systemic fix is folder.renamed
            // + planner rev B cancelPrefix; not improvised here.
            this.dwellGate.renamePrefix(oldPath, file.path);
            return;
        }

        // Rename cancels the pending modify on the OLD path (planner
        // ruling 2026-10-28): rename is semantically a modify subclass;
        // the rename's own post-rename sha check covers content drift.
        // Quiet — the cancelling event IS the record.
        this.plannerLane?.cancelPending(oldPath);

        // Gate first (synchronous, cheap): accrual truth never depends
        // on the writer's mood. Then the spine fact, ordered by the
        // serialized queue with everything else.
        this.dwellGate.renamePath(oldPath, file.path);
        void this.emitRename(oldPath, file.path);
    }

    /**
     * Tier-1 write-through for note.renamed (tier label corrected
     * 2026-10-24: verified against TIER2_TYPES — the Tier-2 set holds
     * note.opened/chunk.* only, so renames route write-through, loss
     * on crash not tolerated, buffer carried ahead so disk order ==
     * seq order). Drops silently while dark, same as every adapter
     * emission.
     */
    private async emitRename(from: string, to: string): Promise<void> {
        if (this.log === null) return; // writer dark: Rung 2 pending or foreign-origin
        await this.log.appendEvent('user', 'note.renamed', { from, to });
    }

    // ---------------------------------------------------------------------------
    // Watcher adapter (thin wiring; F12, 2026-10-25)
    // ---------------------------------------------------------------------------

    /**
     * Shared stat at observation time (slot-4 extraction, 2026-10-29 —
     * was an inline closure in the watcher's deps; identical behavior
     * and error message). Throws on absent file — callers that must
     * not propagate route through their own guards.
     */
    private async statSnapshot(path: string): Promise<{ mtime: number; bytes: number }> {
        const stat = await this.app.vault.adapter.stat(path);
        if (stat === null || stat.type !== 'file') {
            throw new Error(`Watcher stat: file absent (${path})`);
        }
        return { mtime: stat.mtime, bytes: stat.size };
    }

    /**
     * Shared content sha (slot-4 extraction, 2026-10-29): SHA-256,
     * 16 hex chars — the shard convention. One implementation, two
     * lanes (watcher + planner), zero drift between them.
     */
    private async contentShaOf(path: string): Promise<string> {
        const bytes = await this.app.vault.adapter.readBinary(path);
        if (bytes === undefined) {
            throw new Error(`Watcher sha: file absent (${path})`);
        }
        const hash = await crypto.subtle.digest(
            'SHA-256',
            new Uint8Array(bytes),
        );
        return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
    }

    /**
     * Vault create receipt: filter to md files, forward to the lane.
     * Registered at layout-ready (Option A) — see onload. The lane
     * stats at observation time (mtime/bytes/sha frozen then, even if
     * the file changes before flush — stat-drift trap avoided).
     */
    private async onVaultCreate(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        await this.watcherLane.onVaultCreate({
            path: file.path,
            isFolder: false,
            ext: file.extension,
        });
    }

    /**
     * Vault delete receipt: filter to md files, forward to the lane.
     * The lane consumes the last-known sha as a tombstone; absent when
     * the path was never observed (pre-watcher file, rename victim).
     * The delete also CANCELS any pending planner modify for the path
     * (tombstone wins — planner ruling 2026-10-28).
     */
    private async onVaultDelete(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        this.plannerLane?.cancelPending(file.path);
        await this.watcherLane.onVaultDelete({
            path: file.path,
            isFolder: false,
            ext: file.extension,
        });
    }

    // ---------------------------------------------------------------------------
    // Planner adapter (thin wiring; slot 4, 2026-10-29)
    // ---------------------------------------------------------------------------

    /**
     * Vault modify receipt: filter to TFiles, forward to the planner
     * lane. Callback param is TAbstractFile per the typings (shape
     * receipt via typecheck 2026-10-29 — TS2739 caught the first
     * draft's TFile assumption at the registration site); the
     * instanceof guard is the create/delete pattern, folder modifies
     * never reaching the lane. Stats at observation time INSIDE the
     * lane; last-wins per path in the coalescing window; the flush
     * decides emit vs suppress vs route against flush-time spine
     * truth.
     */
    private async onVaultModify(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        await this.plannerLane?.onVaultModify({
            path: file.path,
            isFolder: false,
            ext: file.extension,
        });
    }

    /**
     * Planner routing sink (ruled 2026-10-29): a pending modify whose
     * path the spine never knew (routeCreate) or says is dead
     * (routeRestore) forwards through the watcher lane's create path.
     * Both cases converge on S13's semantics — dead-on-spine +
     * alive-on-disk reconciles by re-creation. GUARDED: the path may
     * have vanished between observation and routing (folder-rename
     * stale address); the stat throw is caught and disclosed, never
     * propagated — a routing throw must not kill the flush loop.
     */
    private async routeToCreateLane(path: string, reason: string): Promise<void> {
        try {
            await this.watcherLane.onVaultCreate({ path, isFolder: false, ext: 'md' });
        } catch (err) {
            const detail =
            `planner routing (${reason}) failed for '${path}': ` +
            `${err instanceof Error ? err.message : String(err)} — ` +
            'observation dropped, heal-covered';
     console.error('[vault-overseer]', detail);
     if (this.log !== null) {
         await this.log.reportIntegrity(detail);
     }
        }
    }

    // ---------------------------------------------------------------------------
    // Writer boot
    // ---------------------------------------------------------------------------

    /**
     * Construct the writer, run startup checks + chain verification,
     * run the F03 heal scan, and emit the session-opened beacon order.
     * Shared by the Rung-1 onload path and the Rung-2 certification
     * path.
     */
    private async startWriter(
        adapter: VaultLogAdapter,
        origin: string,
        fromOriginFile: boolean,
    ): Promise<void> {
        this.originId = origin;

        const startup = await startupChecks(adapter, origin, EVENTS_DIR);

        if (startup.foreignOrigin) {
            const detail = startup.integrity.map((r) => r.detail).join('; ');
            const msg =
            `Vault Overseer: foreign origin in shard tail for '${origin}' ` +
            '— writer DISABLED. Fix the origin or the shard, then reload.';
            console.error('[vault-overseer]', msg, detail);
            new Notice(msg, 15000);
            this.writerBlocked = true;
            return;
        }

        this.log = new EventLog({
            adapter,
            origin,
            eventsDir: EVENTS_DIR,
            initialSeq: startup.recoveredThroughSeq,
            now: () => defaultLocalIso(),
                                hasTornTail: startup.tornTail,
        });

        // Deferred integrity bookkeeping that needed a writer to exist:
        // (a) Rung 2 birth: origin.txt was written by the certification
        //     surface this boot — say so, naming the mechanism. (Since
        //     0.1.2 this is the ONLY path with fromOriginFile=false;
        //     Rung 3 and its hostname seed are gone.)
        // (b) Rung 4: data.json carried a legacy origin field — record
        //     the scrub. Silent scrubs are disqualifying.
        if (!fromOriginFile) {
            await this.log.reportIntegrity(
                `origin.migrated-interim: origin.txt created with id='${origin}' ` +
                'via human certification (settings surface)',
            );
        }
        if (this.scrubbedLegacyOrigin !== null) {
            await this.log.reportIntegrity(
                `settings.changed-interim: keys=[origin], scrubbed_from_data_json=` +
                `'${this.scrubbedLegacyOrigin}' — field is dead in 0.1.1+, never read`,
            );
            this.scrubbedLegacyOrigin = null;
        }

        // -----------------------------------------------------------------
        // Chain verification — ONE read, ONE report, one channel (fold
        // ratified 2026-10-23; see header). The detail string is computed
        // once and drives console, Notice, and ledger identically, so
        // they can never disagree. The throw path is folded into the
        // same channel — no separate wording, no second event, and no
        // unguarded re-entry past onload that could kill the
        // session.opened beacon below.
        // -----------------------------------------------------------------
        let chainDetail: string | null = null;
        try {
            const chain = await verifyChain(adapter, `${EVENTS_DIR}/${origin}.jsonl`, origin);
            if (!chain.valid) {
                chainDetail = chain.detail ?? 'unknown chain failure';
            }
        } catch (err) {
            chainDetail =
            `chain verification threw: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (chainDetail !== null) {
            this.chainBroken = true;
            console.error('[vault-overseer] chain verification FAILED:', chainDetail);
            new Notice(
                `Vault Overseer: checkpoint chain verification FAILED for '${origin}' ` +
                '— shard integrity is compromised. Details recorded in the event log.',
                15000,
            );
            await this.log.reportIntegrity(`chain verification failed: ${chainDetail}`);
        }

        if (startup.integrity.length > 0) {
            await this.log.reportIntegrity(
                startup.integrity.map((r) => r.detail).join('; '),
            );
        }

        const settingsSha = await sha256Hex(JSON.stringify(this.settings));
        await this.log.reportIntegrity(
            `session.opened-interim: plugin_versions=vault-overseer-index@${this.manifest.version}, settings_sha=${settingsSha}`,
        );

        // -----------------------------------------------------------------
        // F03 heal scan — re-derive Tier-2 chunks from vault bytes.
        // Runs AFTER the session beacon (the session record precedes
        // derived re-derivation work). The scan owns its refusal lane:
        // a seq gap halts the projection and heal refuses loudly via
        // log.integrity, independent of chain verification above. Its
        // own emissions (chunk.indexed, "buffer window lost" reports)
        // ride the same serialized queue as everything else.
        //
        // Guard doctrine: a heal throw reports through the ledger and
        // does NOT escape startWriter — nothing may kill the writer
        // after the beacon has landed. A refused heal is a RECORDED
        // refusal, not a failed boot.
        //
        // ORDERING NOTE (B3): heal runs BEFORE the reconcile gate, so on
        // a fresh spine heal sees no paths and indexes nothing; the
        // backfill lands after, and boot 2's heal does the indexing. See
        // "TWO-BOOT VISIBILITY" in the header — declared, open ruling.
        // -----------------------------------------------------------------
        try {
            await healScan(this.log, adapter, EVENTS_DIR);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error('[vault-overseer] heal scan threw:', detail);
            await this.log.reportIntegrity(`heal scan threw: ${detail}`);
        }

        // ARMING: the writer is up, drain the dark buffer and arm the
        // watcher lane live. Overflow disclosure (if any) precedes the
        // drained facts; the spill is named before the survivors land.
        // Under Option A this buffer should be EMPTY at arming on a
        // normal boot (listeners register at layout-ready, after the
        // firestorm); the dark path remains for the Rung-2
        // certification-late edge.
        //
        // Awaited (was fire-and-forget): reconcile refuses while the lane
        // is dark, and the Rung-2 path calls reconcile immediately after
        // this returns. Awaiting makes "armed" a fact the next statement
        // can rely on rather than a hope.
        await this.watcherLane.flushAfterAttach();

        // ARM THE PLANNER after the watcher's drain (ruled 2026-10-29):
        // the planner's first coalescing flush reads the spine, and this
        // ordering guarantees the drained dark facts are on it — the
        // routing decisions (unknown/dead) are made against complete
        // truth. On the Rung-2 certification path this same statement
        // arms the lane post-certification; pre-arm observations were
        // dropped (Q3, heal-covered).
        this.plannerLane?.arm();
    }

    /**
     * SYNCHRONOUS, and the order below is load-bearing: farewell dwell
     * events are APPENDED (into the serialized write queue) before
     * dispose() is called, so the queue flushes them ahead of the
     * farewell drain. The serialized queue makes the race impossible;
     * this ordering is why dispose() sees them.
     *
     * Farewell gate ruling (v1, per F09, ratified): dwell below 10s
     * emits NOTHING at session end — a swipe-through doesn't become
     * signal just because Obsidian was closing.
     *
     * NO planner farewell flush (slot 4, declared): onunload is
     * synchronous, the planner's flush is async behind a mergeScan —
     * its appends would race dispose()'s queue join and drop on
     * this.log = null. Window loss extends the planner's declared
     * crash-window limitation; boot-heal is the recovery path.
     */
    onunload(): void {
        // Bank the active note and collect over-gate accruals. The gate
        // cancels its own timer; the return carries actual dwell-so-far
        // (floor seconds), which may exceed 10.
        const farewells = this.dwellGate.sessionEnd();

        // Enqueue each farewell BEFORE dispose joins the queue — the
        // writer's serialization guarantees they land first.
        for (const f of farewells) {
            void this.emitDwell(f.path, f.dwellSeconds);
        }

        void this.log?.dispose();
        this.log = null;
    }

    /**
     * Public API surface for Plugin 2 (and anything else). Null while the
     * writer is blocked (foreign-origin, Rung-2 uncertified) or unloaded —
     * callers must handle it.
     */
    getApi(): {
        appendEvent: EventLog['appendEvent'];
        lastSeq: number;
    } | null {
        if (this.log === null) return null;
        const log = this.log;
        return {
            appendEvent: log.appendEvent.bind(log),
            get lastSeq(): number {
                return log.lastSeq;
            },
        };
    }

    /**
     * Rung 4 enforcement + shared-knob load. The legacy `origin` field,
     * if ferried in by Sync, is scrubbed from disk immediately —
     * whatever data.json wins the sync race, it cannot lie about
     * identity because nobody ever reads the field again.
     */
    async loadSettings(): Promise<void> {
        const persisted = (await this.loadData()) as
        | (Partial<VaultOverseerSettings> & { origin?: unknown })
        | null;

        if (persisted !== null && 'origin' in persisted) {
            this.scrubbedLegacyOrigin =
            typeof persisted.origin === 'string' ? persisted.origin : null;
            delete persisted.origin;
            await this.saveData(persisted);
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, persisted ?? {});
    }

    async saveSettings(next: Partial<VaultOverseerSettings>): Promise<void> {
        const changed = Object.keys(next).filter(
            (k) => next[k as keyof VaultOverseerSettings] !==
            this.settings[k as keyof VaultOverseerSettings],
        );
        this.settings = Object.assign({}, this.settings, next);
        await this.saveData(this.settings);
        if (changed.length > 0 && this.log !== null) {
            await this.log.reportIntegrity(
                `settings.changed-interim: keys=[${changed.join(', ')}]`,
            );
        }
    }

    /**
     * Rung 2 completion: human-certify this machine against an existing
     * shard (or a brand-new id). Writes origin.txt, then boots the writer
     * through the same startWriter() path the Rung-1 path uses.
     *
     * B3 (2026-10-25): reconciles after booting. This is the door that
     * matters most — a virgin install's automatic gate fires before
     * certification and refuses (writer dark), so without this call the
     * fresh-spine black hole would wait on a human remembering a button.
     * startWriter awaits flushAfterAttach AND arms the planner, so both
     * lanes are live here.
     */
    async certifyOrigin(origin: string): Promise<void> {
        const trimmed = origin.trim();
        if (trimmed.length === 0) return;

        if (this.adapter === null) {
            // Defensive only: onload sets this.adapter before any UI exists.
            console.error('[vault-overseer] certifyOrigin: adapter not initialized');
            return;
        }

        const pluginFolder =
        this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

        await writeOriginFile(this.adapter, pluginFolder, trimmed);
        this.pendingCertification = null;
        await this.startWriter(this.adapter, trimmed, false);

        // Seal the installation black hole: the fresh spine now learns
        // the world. Refusals (dark/gap) report themselves.
        await this.runReconcileWithVault();

        // Force the settings tab to redraw its certification surface away.
        // TYPECHECK FIX (2026-10-29): `app.setting` is not in Obsidian's
        // public App typings — this is the internal settings surface,
        // used deliberately and named here. Contained structural cast,
        // one call site, optional-chained end to end.
        const settingsApp = this.app as unknown as {
            setting?: { activeTab?: { display?: () => void } };
        };
        settingsApp.setting?.activeTab?.display?.();
    }
}

// -----------------------------------------------------------------------------
// Settings tab — status + the Rung-2 certification surface
// -----------------------------------------------------------------------------

class OverseerSettingTab extends PluginSettingTab {
    plugin: VaultOverseerIndex;

    constructor(app: App, plugin: VaultOverseerIndex) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // --- Origin (read-only: identity lives in origin.txt, not here) ---

        new Setting(containerEl)
        .setName('Origin (device id)')
        .setDesc(
            'Per-device shard id. Identity lives in origin.txt inside the ' +
            'plugin folder — sync-excluded, BRAT-proof. Edit that file (or ' +
            'certify below) to change it; the origin setting itself is gone ' +
            'from data.json.',
        )
        .addText((text) =>
        text
        .setPlaceholder('uncertified')
        .setValue(this.plugin.originId ?? '')
        .setDisabled(true),
        );

        // --- B3: the manual reconcile door ---

        new Setting(containerEl)
        .setName('Reconcile with vault')
        .setDesc(
            'Backfill first-contact paths into the spine. Safe to click ' +
            'repeatedly — idempotent: if the spine already knows everything, ' +
            'nothing is emitted. Refuses (loudly) across a seq gap rather ' +
            'than fabricate facts from a truncated scan.',
        )
        .addButton((btn) =>
        btn
        .setButtonText('Reconcile now')
        .setCta()
        .onClick(async () => {
            const emitted = await this.plugin.runReconcileWithVault();
            if (emitted === 0) {
                new Notice('Vault Overseer: vault and index agree', 6000);
            }
            // emitted > 0: the routine already toasted the count.
            // emitted < 0: the routine already toasted the refusal reason
            // (dark or gap) — no second Notice, no contradictory wording.
        }),
        );

        // --- Rung 2: the certification surface (writer dark until done) ---

        if (this.plugin.pendingCertification !== null) {
            containerEl.createEl('h3', { text: 'Certify this machine\'s identity' });
            containerEl.createEl('p', {
                text:
                'This machine has no origin.txt — identity cannot be inferred ' +
                'from synced state or from the OS. Pick which shard this machine ' +
                'writes, or declare a new device id (a virgin install offers only ' +
                'the new-id option). Nothing is appended until this is answered.',
                cls: 'mod-info',
            });

            for (const candidate of this.plugin.pendingCertification) {
                new Setting(containerEl)
                .setName(candidate)
                .setDesc(`Continue writing the existing ${candidate}.jsonl shard.`)
                .addButton((btn) =>
                btn
                .setButtonText(`Certify as '${candidate}'`)
                .onClick(() => void this.plugin.certifyOrigin(candidate)),
                );
            }

            // New device id field with its own callback closure
            const newIdSetting = new Setting(containerEl)
            .setName('New device id')
            .setDesc('Start a brand-new shard for a machine not listed above.');

            let newValue = '';
            newIdSetting.addText((text) =>
            text
            .setPlaceholder('e.g. phone-1')
            .onChange((value) => {
                newValue = value;
                newIdSetting.setTooltip(value);
            }),
            );
            newIdSetting.addButton((btn) =>
            btn.setButtonText('Create new origin').onClick(() => {
                if (newValue.trim().length > 0) {
                    void this.plugin.certifyOrigin(newValue.trim());
                }
            }),
            );
        }

        // --- Warnings (carried from 0.1.0) ---

        if (this.plugin.writerBlocked) {
            containerEl.createEl('p', {
                text: '⚠ Writer BLOCKED: foreign origin detected in the shard ' +
                'tail. Resolve the mismatch, then reload the plugin.',
                cls: 'mod-warning',
            });
        }

        if (this.plugin.chainBroken) {
            containerEl.createEl('p', {
                text: '⚠ Chain verification FAILED at startup: the shard\'s checkpoint ' +
                'digest does not match its contents (tamper, truncation, or a sync ' +
                'drop). The writer is still recording — the failing checkpoint\'s ' +
                'seq is named in the event log.',
                cls: 'mod-warning',
            });
        }
    }
}
