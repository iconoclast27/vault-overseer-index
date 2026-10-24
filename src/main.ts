// =============================================================================
// Vault Overseer — Plugin Entry (main)
// src/main.ts
//
// The Obsidian bootstrap: resolve machine identity, run startup checks,
// construct the EventLog writer, verify the checkpoint chain, run the
// F03 heal scan, and expose the Plugin 2 seam. Everything here is wiring;
// the spine's semantics live in src/eventlog/*.
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
//                limitation). The gate's lanes are rewritten in
//                the same handler, so in-flight accrual and future
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
//     0.1.5-bound block above.
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
//     - Dwell banked while the writer is dark (Rung 2 pending,
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
//   session.opened-interim beacon — the integrity recorder silencing
//   the session record. Fold: ONE read, ONE report, one channel.
//
// Consequence: data.json carries shared knobs only. Per-device state
// lives in sync-excluded lanes (origin.txt) or it isn't safe.
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
import { startupChecks } from './eventlog/reader.ts';
import { verifyChain } from './eventlog/checkpoint.ts';
import { healScan } from './eventlog/heal.ts';
import { DwellGate } from './dwell/gate.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const EVENTS_DIR = '_vault-index/events';
const ORIGIN_FILE = 'origin.txt';

// The dwell gate's threshold (10s) and all gate semantics live in
// src/dwell/gate.ts. Promoting it to a shared data.json knob is future
// icing (it only tunes behavior — the moment a setting changes WHAT
// gets logged, it moves to sync-excluded lanes).

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

// -----------------------------------------------------------------------------
// Adapter — Obsidian's DataAdapter behind the log's structural interface
// -----------------------------------------------------------------------------

/**
 * Thin wrapper: normalizes paths and maps list() to bare names. Satisfies
 * both the EventLog's LogAdapter and the reader's ByteSource — one
 * adapter, one filesystem view. Plugin-folder paths (origin.txt) also
 * route through here; the vault-relative path passed by the caller
 * already contains the plugin folder segment.
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
 * creating the sync-excluded identity lane. Called only from the
 * certification surface (Rung 2) — the only path that creates
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
    settings!: VaultOverseerSettings;

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

    // --- Dwell-gate adapter state (semantics live in src/dwell/gate.ts) ---

    /**
     * The pure gate, wired to this plugin's writer. Field initializer
     * is safe: the emit closure captures `this` lazily, so the gate
     * exists before onload but cannot emit into a dark writer.
     */
    private readonly dwellGate = new DwellGate({
        emit: (path, dwell) => this.emitDwell(path, dwell),
    });

    /** Sequential counter backing the TFile→noteId map. */
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

        const adapter = new VaultLogAdapter(this.app.vault.adapter);
        // manifest.dir is the vault-relative path to this plugin's
        // folder (obsidian.d.ts l.7378–7381). Typed optional; the
        // fallback is defensive only — dir is always set at runtime
        // for an installed plugin.
        const pluginFolder =
        this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

        const resolution = await resolveOrigin(adapter, pluginFolder);

        if (resolution.origin === null) {
            // Rung 2: no origin.txt — shards may or may not exist. Writer
            // stays DARK — no EventLog is constructed, so no shard is
            // touched while identity is uncertified. Certification
            // surface lives in the settings tab (also reachable
            // immediately).
            this.pendingCertification = resolution.foundOrigins;
            new Notice(
                'Vault Overseer: no origin.txt — open Settings → Vault ' +
                'Overseer to certify this machine\'s identity.',
                15000,
            );
        } else {
            await this.startWriter(adapter, resolution.origin, resolution.fromOriginFile);
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

        this.addSettingTab(new OverseerSettingTab(this.app, this));
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
            this.dwellGate.renamePrefix(oldPath, file.path);
            return;
        }

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
        // -----------------------------------------------------------------
        try {
            await healScan(this.log, adapter, EVENTS_DIR);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error('[vault-overseer] heal scan threw:', detail);
            await this.log.reportIntegrity(`heal scan threw: ${detail}`);
        }
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
     */
    async certifyOrigin(origin: string): Promise<void> {
        const trimmed = origin.trim();
        if (trimmed.length === 0) return;

        const adapter = new VaultLogAdapter(this.app.vault.adapter);
        const pluginFolder =
        this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

        await writeOriginFile(adapter, pluginFolder, trimmed);
        this.pendingCertification = null;
        await this.startWriter(adapter, trimmed, false);

        // Force the settings tab to redraw its certification surface away.
        this.app.setting?.activeTab?.display?.();
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
