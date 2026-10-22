// =============================================================================
// Vault Overseer — Plugin 1 entry point (vault-overseer-index)
// src/main.ts
// Generated: 2026-10-22T13:00:00+01:00
//
// Task: startup checks wiring. Integrates startupChecks() into the plugin
// bootstrap; passes initialSeq + hasTornTail to the EventLog constructor;
// rejects foreign-origin shards LOUDLY before any writer exists; verifies
// the checkpoint digest chain on every startup.
//
// 2026-10-22: verifyChain() wired into onload(). Detection is LOUD but
// NON-BLOCKING — see the rationale comment at the call site. The asymmetry
// with the foreign-origin guard is deliberate, not an oversight.
//
// Verified against eventlog.ts + types.ts (2026-10-21):
//   - Constructor accepts { adapter, origin, eventsDir?, initialSeq?,
//     now?, settings?, hasTornTail? }; dispose() drains the Tier-2 buffer;
//     reportIntegrity(detail) is public; lastSeq is a live getter.
//   - types.ts Phase 1 catalog covers note.*, chunk.*, log.integrity ONLY.
//     session.* and settings.* are NOT in the union yet — declaring them
//     "only when they gain fixture-loaded consumers" is house doctrine.
//
// INTERIM CARRIER RULING (Dan, 2026-10-21, Option B): session-opened and
// settings-changed facts ride log.integrity with a prefixed detail string
// until session-lifecycle events enter the catalog behind their own fixture.
// Not silent, not fabricated, fully auditable — but marked as interim so
// a future grep can find and promote them in one pass.
//
// This file is BUNDLED by esbuild into main.js — it never runs under plain
// Node, which is why fixtures can't cover it. The VaultLogAdapter shim is
// the seam: everything behind it is logic the fixtures already proved.
// HONEST LIMITATION: the wiring below is verified by inspection and manual
// smoke test in Obsidian, not by fixture. Moving the bootstrap logic behind
// a testable seam is owed work, not done work.
//
// Plugin 2 consumes this via:
//   const api = (app as any).plugins?.plugins?.['vault-overseer-index']?.getApi();
//   await api.appendEvent(actor, type, payload);
// Map v0.3 seam: Plugin 2 NEVER writes the log directly.
// =============================================================================

import { Plugin, PluginSettingTab, Setting, Notice, normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { EventLog, defaultLocalIso } from './eventlog/eventlog.ts';
import type { LogAdapter } from './eventlog/eventlog.ts';
import { startupChecks } from './eventlog/reader.ts';
import { verifyChain } from './eventlog/checkpoint.ts';

const EVENTS_DIR = '_vault-index/events';

// --- Zone 3 settings: origin only, nothing volatile (R8 discipline) ---------

interface OverseerSettings {
    /** Per-device shard id. mokka (RTX4070) / latitude (Dell). */
    origin: string;
}

const DEFAULT_SETTINGS: OverseerSettings = { origin: 'mokka' };

// --- Obsidian DataAdapter → LogAdapter/ByteSource shim ------------------------
// Faithful to the contract FakeAdapter proved. readBinary returns undefined
// (not throw) for absent paths, because reader.ts's ByteSource expects
// exactly that. LogAdapter needs append/write/mkdir/exists; ByteSource
// needs readBinary/listDir — one shim satisfies both interfaces.

class VaultLogAdapter implements LogAdapter {
    constructor(private inner: DataAdapter) {}

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
        // Obsidian's readBinary THROWS on missing paths; convert to undefined.
        if (!(await this.inner.exists(p))) return undefined;
        const buf = await this.inner.readBinary(p);
        return new Uint8Array(buf);
    }

    async listDir(path: string): Promise<string[]> {
        // adapter.list() returns full paths in .files; contract wants bare names.
        const listing = await this.inner.list(normalizePath(path));
        return listing.files
        .map((f) => f.slice(f.lastIndexOf('/') + 1))
        .sort();
    }
}

// --- settings_sha helper (16-hex truncation, matches content_sha discipline) --

async function sha256Hex(text: string, len = 16): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, len);
}

// --- Plugin --------------------------------------------------------------------

export default class VaultOverseerIndex extends Plugin {
    settings!: OverseerSettings;
    private log: EventLog | null = null;

    /** True after onload when the foreign-origin guard fired — writer refused. */
    writerBlocked = false;

    /**
     * True if startup chain verification failed: the shard's checkpoint digest
     * does not match its contents. The writer STILL RECORDS (see onload
     * rationale) — this flag drives the settings-tab warning only.
     */
    chainBroken = false;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new OverseerSettingTab(this.app, this));

        const adapter = new VaultLogAdapter(this.app.vault.adapter);
        const startup = await startupChecks(adapter, this.settings.origin, EVENTS_DIR);

        if (startup.foreignOrigin) {
            // Guard: LOUD, fail-safe, no writer constructed. Misconfigured
            // duplicate ids must not append to a foreign shard (schema
            // integrity clause 4; reader.ts sets foreignOrigin=true with
            // DO-NOT-CONSTRUCT semantics).
            const detail = startup.integrity.map((r) => r.detail).join('; ');
            const msg =
            `Vault Overseer: foreign origin in shard tail for ` +
            `'${this.settings.origin}' — writer DISABLED. Fix the origin ` +
            `setting or the shard, then reload.`;
            console.error('[vault-overseer]', msg, detail);
            new Notice(msg, 15000);
            this.writerBlocked = true;
            return;
        }

        this.log = new EventLog({
            adapter,
            origin: this.settings.origin,
            eventsDir: EVENTS_DIR,
            initialSeq: startup.recoveredThroughSeq,
            now: () => defaultLocalIso(),
                                hasTornTail: startup.tornTail,
        });

        // --- Chain verification (F11) — READ-ONLY, as-found -----------------
        //
        // Recompute the digest chain from genesis and compare against every
        // log.checkpoint on the shard. Catches tamper (covered byte mutated),
        // truncation (covered line deleted), and coverage violations (a
        // checkpoint claiming more history than precedes it).
        //
        // POLICY — loud, NON-BLOCKING, and deliberately asymmetric with the
        // foreign-origin guard above. That guard blocks because appending
        // there would be STRUCTURALLY wrong (single-writer violated). A digest
        // mismatch is HISTORICALLY wrong: something changed after the fact.
        // New facts appended now are still true facts, and refusing to record
        // them would trade a detectable integrity failure for silent data
        // loss. The witness reports; it does not govern. Ratified by Dan?
        // (flagged 2026-10-22 — policy call, not a technical one)
        //
        // Runs BEFORE any integrity reporting so the shard is judged as found,
        // not as modified by our own startup lines.
        const shardPath = `${EVENTS_DIR}/${this.settings.origin}.jsonl`;
        try {
            const chain = await verifyChain(adapter, shardPath, this.settings.origin);
            if (!chain.valid) {
                this.chainBroken = true;
                const detail = chain.detail ?? 'unknown chain failure';
                console.error('[vault-overseer] chain verification FAILED:', detail);
                new Notice(
                    `Vault Overseer: checkpoint chain verification FAILED for ` +
                    `'${this.settings.origin}' — shard integrity is compromised. ` +
                    `Details recorded in the event log.`,
                    15000,
                );
            }
        } catch (err) {
            // A throw here is itself a finding: verification must not be able
            // to fail silently. Record it and carry on.
            this.chainBroken = true;
            const detail = err instanceof Error ? err.message : String(err);
            console.error('[vault-overseer] chain verification threw:', detail);
            await this.log.reportIntegrity(`chain verification threw: ${detail}`);
        }

        // Startup integrity reports LAND in the log, not just stdout (f01
        // precedent: torn tail → log.integrity before any other append).
        if (startup.integrity.length > 0) {
            await this.log.reportIntegrity(
                startup.integrity.map((r) => r.detail).join('; '),
            );
        }

        // Chain failure lands in the log too — silence is disqualifying (R5).
        if (this.chainBroken) {
            const chain = await verifyChain(adapter, shardPath, this.settings.origin);
            await this.log.reportIntegrity(
                `chain verification failed: ${chain.detail ?? 'unknown chain failure'}`,
            );
        }

        // session.opened, INTERIM CARRIER (Option B, 2026-10-21): the fact
        // boots the read context; the event type awaits its fixture and
        // catalog entry. Greppable marker: "session.opened-interim".
        const settingsSha = await sha256Hex(JSON.stringify(this.settings));
        await this.log.reportIntegrity(
            `session.opened-interim: ` +
            `plugin_versions=vault-overseer-index@${this.manifest.version}, ` +
            `settings_sha=${settingsSha}`,
        );
    }

    onunload(): void {
        // Obsidian does NOT await unload. dispose() drains the Tier-2 buffer
        // (farewell flush); the promise is fire-and-forget by necessity. The
        // narrow window where a crash mid-flush loses a buffer window is
        // exactly F03's scenario — healable by design, facts unaffected.
        void this.log?.dispose();
        this.log = null;
    }

    /**
     * Public API surface for Plugin 2 (and anything else). Null while the
     * writer is blocked (foreign-origin) or unloaded — callers must handle it.
     */
    getApi(): {
        appendEvent: EventLog['appendEvent'];
        lastSeq: number;
    } | null {
        if (this.log === null) return null;
        const log = this.log;
        return {
            appendEvent: log.appendEvent.bind(log),
            get lastSeq() {
                return log.lastSeq;
            },
        };
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(next: Partial<OverseerSettings>): Promise<void> {
        const changed: string[] = Object.keys(next).filter(
            (k) =>
            (next as Record<string, unknown>)[k] !==
            (this.settings as Record<string, unknown>)[k],
        );
        this.settings = Object.assign({}, this.settings, next);
        await this.saveData(this.settings);

        // settings.changed, INTERIM CARRIER (Option B): the R8 fire alarm
        // stays loud — keys recorded, values never. Catalog entry awaits
        // its fixture. Greppable marker: "settings.changed-interim".
        if (changed.length > 0 && this.log !== null) {
            await this.log.reportIntegrity(
                `settings.changed-interim: keys=[${changed.join(', ')}]`,
            );
        }
    }
}

// --- Settings tab ----------------------------------------------------------------

class OverseerSettingTab extends PluginSettingTab {
    plugin: VaultOverseerIndex;

    constructor(app: import('obsidian').App, plugin: VaultOverseerIndex) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
        .setName('Origin (device id)')
        .setDesc(
            'Per-device shard id — the spine file this machine writes. ' +
            'Changing it takes effect after a plugin reload (the startup ' +
            'guard re-runs). mokka / latitude on this setup.',
        )
        .addText((text) =>
        text.setPlaceholder('mokka')
        .setValue(this.plugin.settings.origin)
        .onChange(async (value) => {
            await this.plugin.saveSettings({ origin: value.trim() });
            new Notice(
                'Vault Overseer: origin changed — reload the plugin ' +
                '(or restart Obsidian) to re-run startup checks.');
        }),
        );

        if (this.plugin.writerBlocked) {
            containerEl.createEl('p', {
                text: '⚠ Writer BLOCKED: foreign origin detected in the shard ' +
                'tail. Resolve the mismatch, then reload the plugin.',
                cls: 'mod-warning',
            });
        }

        if (this.plugin.chainBroken) {
            containerEl.createEl('p', {
                text: '⚠ Chain verification FAILED at startup: the shard\'s ' +
                'checkpoint digest does not match its contents (tamper, ' +
                'truncation, or a sync drop). The writer is still recording — ' +
                'the failing checkpoint\'s seq is named in the event log.',
                cls: 'mod-warning',
            });
        }
    }
}
