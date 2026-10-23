// =============================================================================
// Vault Overseer — Plugin Entry (main)
// src/main.ts
//
// The Obsidian bootstrap: resolve machine identity, run startup checks,
// construct the EventLog writer, verify the checkpoint chain, and expose
// the Plugin 2 seam. Everything here is wiring; the spine's semantics
// live in src/eventlog/*.
//
// 0.1.1 — ORIGIN RESOLUTION LADDER (fixes the origin-identity flaw found
// and designed 2026-10-23):
//
//   Rung 1  origin.txt in the plugin folder. A non-canonical file, so
//           Obsidian Sync structurally excludes it from ferrying;
//           BRAT updates touch only the canonical quartet, so it
//           survives releases. If present, that's the origin, period.
//   Rung 2  No origin.txt + shards exist => the writer stays DARK. The
//           settings surface lists the found shards and demands HUMAN
//           certification (continue an existing shard or type a new
//           id). No machine ever infers identity from ferried state.
//           Certification is logged as origin.migrated-interim.
//   Rung 3  No origin.txt + no shards (virgin install) => os.hostname()
//           seeds a default, overridable. (Spike-verified in the
//           renderer 2026-10-23.)
//   Rung 4  data.json's origin field is NEVER read again. If present
//           it is scrubbed on load and the scrub is logged as a
//           settings.changed-interim event. It is NOT a migration
//           source — auto-lifting it gambles on a sync-conflict coin
//           toss.
//
// Consequence: data.json carries shared knobs only. Per-device state
// lives in sync-excluded lanes (origin.txt) or it isn't safe.
// =============================================================================

const os = require('os');

import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
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
// Origin resolution — the 0.1.1 ladder
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
        // through to Rungs 2/3 — an empty file certifies nothing.
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

    // Rung 2: shards exist, no origin.txt => human must certify. The
    // plugin cannot know which shard (if any) belongs to this machine,
    // and guessing is the flaw being fixed. Writer stays dark until
    // certified via the settings surface.
    if (foundOrigins.length > 0) {
        return {
            origin: null,
            foundShards,
            foundOrigins,
            fromOriginFile: false,
        };
    }

    // Rung 3: virgin install — hostname seeds a default, overridable.
    // (os.hostname() spike-verified in the renderer 2026-10-23.)
    return {
        origin: os.hostname(),
        foundShards: [],
        foundOrigins: [],
        fromOriginFile: false,
    };
}

/**
 * Rung completion for Rungs 2 and 3: persist the certified/chosen id to
 * origin.txt, creating the sync-excluded identity lane. Called only from
 * the certification surface (Rung 2) and first-boot seed (Rung 3).
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

    /** Rung 2 pending: shard names awaiting human certification. */
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
            // Rung 2: shards exist, no origin.txt. Writer stays DARK —
            // no EventLog is constructed, so no shard is touched while
            // identity is uncertified. Certification surface lives in
            // the settings tab (also reachable immediately).
            this.pendingCertification = resolution.foundOrigins;
            new Notice(
                'Vault Overseer: no origin.txt and shards exist — open ' +
                'Settings → Vault Overseer to certify this machine\'s identity.',
                15000,
            );
        } else {
            await this.startWriter(adapter, resolution.origin, resolution.fromOriginFile);
        }

        this.addSettingTab(new OverseerSettingTab(this.app, this));
    }

    /**
     * Construct the writer, run startup checks + chain verification,
     * and emit the session-opened beacon. Shared by the Rung-1/3 onload
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
        // (a) Rung 2/3 birth: origin.txt was created this boot — say so.
        // (b) Rung 4: data.json carried a legacy origin field — record
        //     the scrub. Silent scrubs are disqualifying.
        if (!fromOriginFile) {
            await this.log.reportIntegrity(
                `origin.migrated-interim: origin.txt created with id='${origin}' ` +
                '(hostname-seeded virgin install or human certification)',
            );
        }
        if (this.scrubbedLegacyOrigin !== null) {
            await this.log.reportIntegrity(
                `settings.changed-interim: keys=[origin], scrubbed_from_data_json=` +
                `'${this.scrubbedLegacyOrigin}' — field is dead in 0.1.1+, never read`,
            );
            this.scrubbedLegacyOrigin = null;
        }

        const shardPath = `${EVENTS_DIR}/${origin}.jsonl`;
        try {
            const chain = await verifyChain(adapter, shardPath, origin);
            if (!chain.valid) {
                this.chainBroken = true;
                const detail = chain.detail ?? 'unknown chain failure';
                console.error('[vault-overseer] chain verification FAILED:', detail);
                new Notice(
                    `Vault Overseer: checkpoint chain verification FAILED for '${origin}' ` +
                    '— shard integrity is compromised. Details recorded in the event log.',
                    15000,
                );
            }
        } catch (err) {
            this.chainBroken = true;
            const detail = err instanceof Error ? err.message : String(err);
            console.error('[vault-overseer] chain verification threw:', detail);
            await this.log.reportIntegrity(`chain verification threw: ${detail}`);
        }

        if (startup.integrity.length > 0) {
            await this.log.reportIntegrity(
                startup.integrity.map((r) => r.detail).join('; '),
            );
        }

        if (this.chainBroken) {
            const chain = await verifyChain(adapter, shardPath, origin);
            await this.log.reportIntegrity(
                `chain verification failed: ${chain.detail ?? 'unknown chain failure'}`,
            );
        }

        const settingsSha = await sha256Hex(JSON.stringify(this.settings));
        await this.log.reportIntegrity(
            `session.opened-interim: plugin_versions=vault-overseer-index@${this.manifest.version}, settings_sha=${settingsSha}`,
        );
    }

    onunload(): void {
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
     * through the same startWriter() path the automatic rungs use.
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
                'Shards exist in this vault but this machine has no origin.txt. ' +
                'Identity cannot be inferred from synced state — pick which shard ' +
                'this machine writes, or declare a new device id. Nothing is ' +
                'appended until this is answered.',
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
