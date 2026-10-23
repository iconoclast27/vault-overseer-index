// =============================================================================
// Vault Overseer — Plugin Entry (main)
// src/main.ts
//
// The Obsidian bootstrap: resolve machine identity, run startup checks,
// construct the EventLog writer, verify the checkpoint chain, and expose
// the Plugin 2 seam. Everything here is wiring; the spine's semantics
// live in src/eventlog/*.
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
//           from ferried state or from the OS. Certification is
//           logged as origin.migrated-interim.
//   Rung 4  data.json's origin field is NEVER read again. If present
//           it is scrubbed on load and the scrub is logged as a
//           settings.changed-interim event. It is NOT a migration
//           source — auto-lifting it gambles on a sync-conflict coin
//           toss.
//
// 0.1.2 — DWELL-GATE WIRING (v1, threshold-only):
//
//   note.opened fires when a note's accrued dwell crosses the 10s gate.
//   v1 semantics, ratified 2026-10-23 (Dan):
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
//       the farewell flush only.
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
//
//   API receipt: on('file-open', (file: TFile | null) => any, ctx?)
//   — obsidian.d.ts l.11041. Verified 2026-10-23.
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
    TFile,
    normalizePath,
} from 'obsidian';

import { EventLog, defaultLocalIso } from './eventlog/eventlog.ts';
import { startupChecks } from './eventlog/reader.ts';
import { verifyChain } from './eventlog/checkpoint.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const EVENTS_DIR = '_vault-index/events';
const ORIGIN_FILE = 'origin.txt';

// Dwell gate — 10s minimum before a note.opened emission. The value is
// a v1 constant; promoting it to a shared data.json knob is future
// icing (it only tunes behavior — the moment a setting changes WHAT
// gets logged, it moves to sync-excluded lanes).
const DWELL_GATE_S = 10;
const DWELL_GATE_MS = DWELL_GATE_S * 1000;

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

    // --- Dwell-gate state (v1 threshold-only) ---

    /** The note the user most recently opened, and when. */
    private activeNote: { path: string; openAt: number } | null = null;

    /**
     * Accrued dwell per path (ms) since that note's last note.opened
     * emission — or since first open, if it never emitted. This is the
     * accumulation lane: dwell banks across separate openings of the
     * same note within a session.
     */
    private readonly dwellAccrued = new Map<string, number>();

    /** Pending threshold timer for the active note. */
    private dwellTimer: ReturnType<typeof setTimeout> | null = null;

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

        this.addSettingTab(new OverseerSettingTab(this.app, this));
    }

    // ---------------------------------------------------------------------------
    // Dwell-gate internals (v1 threshold-only)
    // ---------------------------------------------------------------------------

    /**
     * file-open receipt (obsidian.d.ts l.11041): callback receives the
     * newly opened TFile, or null when no file is open. Switching notes
     * banks the outgoing note's dwell WITHOUT emitting — the gate, not
     * abandonment, is what earns an event.
     */
    private onFileOpen(file: TFile | null): void {
        const now = Date.now();

        if (this.activeNote !== null) {
            this.bankDwell(this.activeNote, now);
            this.activeNote = null;
        }
        if (this.dwellTimer !== null) {
            clearTimeout(this.dwellTimer);
            this.dwellTimer = null;
        }

        if (file === null) return; // empty workspace / no file open
        this.activeNote = { path: file.path, openAt: now };
        this.armDwellTimer(file.path);
    }

    /** Add the active note's elapsed dwell to its accrual lane. */
    private bankDwell(note: { path: string; openAt: number }, now: number): void {
        const elapsed = now - note.openAt;
        this.dwellAccrued.set(note.path, (this.dwellAccrued.get(note.path) ?? 0) + elapsed);
    }

    /**
     * Arm the threshold timer for the given remaining dwell: the gate
     * minus whatever this note has already banked this session.
     */
    private armDwellTimer(path: string): void {
        const accrued = this.dwellAccrued.get(path) ?? 0;
        const remaining = DWELL_GATE_MS - accrued;
        if (remaining <= 0) {
            // Accrued already crossed the gate without an intervening
            // emission. Unreachable in normal flow (emission resets the
            // accrual); emit immediately rather than spin.
            this.onDwellGateCrossed(path);
            return;
        }
        this.dwellTimer = setTimeout(() => {
            this.onDwellGateCrossed(path);
        }, remaining);
    }

    /**
     * The gate was crossed: emit one note.opened (dwell=10 flat, v1),
     * then reset that note's accrual. Continued dwelling after the
     * emission banks toward the farewell flush only — one event per
     * gate crossing, per the ratified semantics.
     */
    private onDwellGateCrossed(path: string): void {
        this.dwellTimer = null;
        this.dwellAccrued.set(path, 0);
        if (this.activeNote !== null && this.activeNote.path === path) {
            this.activeNote.openAt = Date.now(); // fresh baseline post-emission
        }
        void this.emitDwell(path, DWELL_GATE_S);
    }

    /** Tier-2 append through the writer's public API. Drops silently while dark. */
    private async emitDwell(path: string, dwell: number): Promise<void> {
        if (this.log === null) return; // writer dark: Rung 2 pending or foreign-origin
        await this.log.appendEvent('user', 'note.opened', { path, dwell });
    }

    // ---------------------------------------------------------------------------
    // Writer boot
    // ---------------------------------------------------------------------------

    /**
     * Construct the writer, run startup checks + chain verification,
     * and emit the session-opened beacon. Shared by the Rung-1 onload
     * path and the Rung-2 certification path.
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
        // Bank the active note's dwell up to this instant.
        if (this.activeNote !== null) {
            this.bankDwell(this.activeNote, Date.now());
            this.activeNote = null;
        }
        if (this.dwellTimer !== null) {
            clearTimeout(this.dwellTimer);
            this.dwellTimer = null;
        }

        // Farewell flush: over-gate accruals only. Emits with actual
        // dwell-so-far (floor seconds), which may exceed 10.
        for (const [path, accrued] of this.dwellAccrued) {
            if (accrued >= DWELL_GATE_MS) {
                void this.emitDwell(path, Math.floor(accrued / 1000));
            }
        }
        this.dwellAccrued.clear();

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
                text: '⚠ Writer BLOCKED: foreign origin detected in the shard tail. ' +
                'Resolve the mismatch, then reload the plugin.',
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
