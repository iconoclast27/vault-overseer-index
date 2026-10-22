"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VaultOverseerIndex
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// src/eventlog/types.ts
var SCHEMA_VERSION = 1;
function payloadInOrder(event) {
  const p = event.payload;
  switch (event.type) {
    case "note.created":
      return { path: p.path, mtime: p.mtime, bytes: p.bytes, content_sha: p.content_sha };
    case "note.modified":
      return { path: p.path, mtime: p.mtime, bytes: p.bytes, content_sha: p.content_sha };
    case "note.deleted":
      return { path: p.path, last_content_sha: p.last_content_sha };
    case "note.renamed":
      return { from: p.from, to: p.to };
    case "note.conflicted":
      return { path: p.path, conflict_copy_path: p.conflict_copy_path };
    case "note.opened":
      return { path: p.path, dwell: p.dwell };
    case "chunk.indexed":
      return { path: p.path, ord: p.ord, bs: p.bs, be: p.be, vh: p.vh, cp: p.cp };
    case "chunk.evicted":
      return { vh: p.vh, path: p.path };
    case "log.integrity":
      return { detail: p.detail };
    case "log.checkpoint":
      return { last_seq: p.last_seq, events: p.events, digest: p.digest };
    default: {
      const unreachable = event;
      return { detail: `unreachable: ${JSON.stringify(unreachable)}` };
    }
  }
}
function serializeEvent(event) {
  const payload = payloadInOrder(event);
  const line = {
    v: event.v,
    seq: event.seq,
    ts: event.ts,
    origin: event.origin,
    actor: event.actor,
    type: event.type,
    ...payload
  };
  return JSON.stringify(line) + "\n";
}

// src/eventlog/checkpoint.ts
var import_node_crypto = require("node:crypto");
var CHECKPOINT_LABEL = "vault-overseer-checkpoint-v1:";
function hexToBytes(hex) {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
function genesisDigest(origin) {
  return (0, import_node_crypto.createHash)("sha256").update(`${CHECKPOINT_LABEL}${origin}`).digest("hex");
}
function stepDigest(prevDigestHex, lineBytes) {
  const prevBytes = hexToBytes(prevDigestHex);
  const hasher = (0, import_node_crypto.createHash)("sha256");
  hasher.update(prevBytes);
  hasher.update(Buffer.from([0]));
  hasher.update(lineBytes);
  return hasher.digest("hex");
}
function completeLinesWithNewline(bytes) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) {
      lines.push(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  return lines;
}
function computeChain(bytes, origin) {
  let chain = genesisDigest(origin);
  let lastSeq = 0;
  for (const raw of completeLinesWithNewline(bytes)) {
    try {
      const json = JSON.parse(Buffer.from(raw).toString("utf-8"));
      const seq = typeof json.seq === "number" ? json.seq : 0;
      const isCheckpoint = json.type === "log.checkpoint";
      if (!isCheckpoint && seq > lastSeq) lastSeq = seq;
    } catch {
    }
    chain = stepDigest(chain, raw);
  }
  return { chain, lastSeq };
}
async function verifyChain(source, shardPath, origin) {
  const bytes = await source.readBinary(shardPath);
  if (bytes === void 0) {
    return { valid: true };
  }
  let chain = genesisDigest(origin);
  let maxSeq = 0;
  let dataMax = 0;
  let lastClaim = null;
  for (const raw of completeLinesWithNewline(bytes)) {
    let json = null;
    try {
      json = JSON.parse(Buffer.from(raw).toString("utf-8"));
    } catch {
    }
    const seq = json !== null && typeof json.seq === "number" ? json.seq : 0;
    if (seq > maxSeq) maxSeq = seq;
    if (json !== null && json.type === "log.checkpoint") {
      lastClaim = { last_seq: Number(json.last_seq) };
      if (chain !== String(json.digest)) {
        return {
          valid: false,
          lastClaimedSeq: Number(json.last_seq),
          shardMaxSeq: maxSeq,
          detail: `checkpoint digest mismatch at seq ${seq}: (origin: ${origin}, claimed ${String(json.digest).slice(0, 16)}\u2026, recomputed ${chain.slice(0, 16)}\u2026)`
        };
      }
      if (dataMax !== Number(json.last_seq)) {
        return {
          valid: false,
          lastClaimedSeq: Number(json.last_seq),
          shardMaxSeq: maxSeq,
          detail: `checkpoint coverage violation at seq ${seq}: claims last_seq ${Number(json.last_seq)}, preceding data reaches ${dataMax} \u2014 ${dataMax < Number(json.last_seq) ? "covered lines vanished (sync drop / truncation)" : "checkpoint precedes history it claims (hostile merge)"}`
        };
      }
    } else if (seq > dataMax) {
      dataMax = seq;
    }
    chain = stepDigest(chain, raw);
  }
  return { valid: true, lastClaimedSeq: lastClaim?.last_seq, shardMaxSeq: maxSeq };
}

// src/eventlog/eventlog.ts
var TIER2_TYPES = /* @__PURE__ */ new Set([
  "note.opened",
  "chunk.indexed",
  "chunk.evicted"
]);
var DEFAULT_EVENTS_DIR = "_vault-index/events";
var EventLog = class {
  adapter;
  origin;
  shardPath;
  eventsDir;
  now;
  flushCount;
  idleMs;
  hardCap;
  checkpointInterval;
  sinceCheckpoint = 0;
  seq;
  buffer = [];
  ready = false;
  idleTimer = null;
  hasTornTail;
  /** Serialized append queue: one write at a time, ever. */
  queueTail = Promise.resolve();
  constructor(opts) {
    this.adapter = opts.adapter;
    this.origin = opts.origin;
    this.eventsDir = opts.eventsDir ?? DEFAULT_EVENTS_DIR;
    this.shardPath = `${this.eventsDir}/${this.origin}.jsonl`;
    this.seq = opts.initialSeq ?? 0;
    this.now = opts.now ?? defaultLocalIso;
    const s = opts.settings ?? {};
    this.flushCount = s.tier2FlushCount ?? 64;
    this.idleMs = s.tier2IdleMs ?? 3e3;
    this.hardCap = s.tier2HardCap ?? 512;
    this.checkpointInterval = s.checkpointInterval ?? 1e4;
    this.hasTornTail = opts.hasTornTail ?? false;
  }
  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  /**
   * Append one event. The caller supplies actor, type, and payload —
   * nothing else. v, seq, ts, and origin are owned here: the writer
   * assigns them, so no caller can forge a sequence number or stamp a
   * foreign origin onto this shard.
   */
  async appendEvent(actor, type, payload) {
    return this.run(() => this.appendLocked(actor, type, payload));
  }
  /**
   * Shorthand for integrity reporting — tier 1, write-through, always.
   * Silence is disqualifying, so this is a public door, not an internal.
   */
  reportIntegrity(detail) {
    return this.appendEvent("plugin", "log.integrity", { detail });
  }
  /** Farewell flush: drains the Tier-2 buffer and stops the idle timer. */
  async dispose() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.run(async () => {
      await this.flushLocked();
      if (this.sinceCheckpoint > 0) await this.checkpointLocked();
    });
  }
  /** Manually emit a log.checkpoint now (Tier 1, write-through). */
  async checkpoint() {
    return this.run(() => this.checkpointLocked());
  }
  /** Current seq (highest assigned). Diagnostic/tests. */
  get lastSeq() {
    return this.seq;
  }
  /** Buffered-but-unwritten Tier-2 lines. Diagnostic/tests. */
  get pendingCount() {
    return this.buffer.length;
  }
  // ---------------------------------------------------------------------------
  // Internals — everything below runs inside the serialized queue
  // ---------------------------------------------------------------------------
  async appendLocked(actor, type, payload) {
    await this.ensureShardLocked();
    if (this.sinceCheckpoint >= this.checkpointInterval && type !== "log.checkpoint") {
      await this.checkpointLocked();
    }
    const seq = ++this.seq;
    this.sinceCheckpoint++;
    const event = {
      v: SCHEMA_VERSION,
      seq,
      ts: this.now(),
      origin: this.origin,
      actor,
      type,
      payload
    };
    const line = serializeEvent(event);
    if (TIER2_TYPES.has(type)) {
      this.buffer.push(line);
      this.scheduleIdleFlush();
      if (this.buffer.length >= this.hardCap || this.buffer.length >= this.flushCount) {
        await this.flushLocked();
      }
      return;
    }
    const combined = this.buffer.length > 0 ? this.buffer.join("") + line : line;
    try {
      const writeData = this.hasTornTail ? "\n" + combined : combined;
      this.hasTornTail = false;
      await this.adapter.append(this.shardPath, writeData);
      this.buffer = [];
      this.stopIdleFlush();
    } catch (err) {
      this.seq = seq - 1;
      throw err;
    }
  }
  async flushLocked() {
    if (this.buffer.length === 0) return;
    const combined = this.buffer.join("");
    await this.adapter.append(this.shardPath, combined);
    this.buffer = [];
    this.stopIdleFlush();
  }
  /**
   * Write one log.checkpoint line. The digest is computed by WALKING the
   * shard from genesis — O(file) per checkpoint, milliseconds at
   * single-digit MB/year. Walking rather than incrementally maintaining
   * chain state means the digest can never desync from disk: no rollback
   * hazards, no torn-tail special cases, no buffer-carry ordering traps.
   * Coverage invariant: last_seq == highest seq on disk == this line's
   * seq − 1 (asserted downstream by verifyChain, policed by F11).
   */
  async checkpointLocked() {
    await this.flushLocked();
    const bytes = await this.adapter.readBinary(this.shardPath);
    const { chain, lastSeq } = computeChain(bytes ?? new Uint8Array(0), this.origin);
    const seq = ++this.seq;
    this.sinceCheckpoint = 0;
    const event = {
      v: SCHEMA_VERSION,
      seq,
      ts: this.now(),
      origin: this.origin,
      actor: "plugin",
      type: "log.checkpoint",
      payload: { last_seq: lastSeq, events: lastSeq, digest: chain }
    };
    const line = serializeEvent(event);
    const writeData = this.hasTornTail ? "\n" + line : line;
    this.hasTornTail = false;
    try {
      await this.adapter.append(this.shardPath, writeData);
    } catch (err) {
      this.seq = seq - 1;
      throw err;
    }
  }
  async ensureShardLocked() {
    if (this.ready) return;
    if (!await this.adapter.exists(this.eventsDir)) {
      await this.adapter.mkdir(this.eventsDir);
    }
    if (!await this.adapter.exists(this.shardPath)) {
      await this.adapter.write(this.shardPath, "");
    }
    this.ready = true;
  }
  scheduleIdleFlush() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.run(() => this.flushLocked());
    }, this.idleMs);
  }
  stopIdleFlush() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  run(task) {
    const run = this.queueTail.then(() => task());
    this.queueTail = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
};
function defaultLocalIso(d = /* @__PURE__ */ new Date()) {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const local = new Date(d.getTime() + offsetMin * 6e4);
  const y = local.getFullYear();
  const mo = String(local.getMonth() + 1).padStart(2, "0");
  const da = String(local.getDate()).padStart(2, "0");
  const h = String(local.getHours()).padStart(2, "0");
  const mi = String(local.getMinutes()).padStart(2, "0");
  const se = String(local.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${da}T${h}:${mi}:${se}${sign}${hh}:${mm}`;
}

// src/eventlog/reader.ts
function splitCompleteLines(bytes) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) {
      lines.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  const torn = start < bytes.length ? bytes.subarray(start) : null;
  return { lines, torn };
}
function parseLine(raw) {
  try {
    const obj = JSON.parse(Buffer.from(raw).toString("utf-8"));
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}
async function startupChecks(source, origin, eventsDir) {
  const shard = `${eventsDir}/${origin}.jsonl`;
  const bytes = await source.readBinary(shard);
  if (bytes === void 0) {
    return {
      shardExists: false,
      foreignOrigin: false,
      tornTail: false,
      recoveredThroughSeq: 0,
      integrity: []
    };
  }
  const integrity = [];
  const { lines, torn } = splitCompleteLines(bytes);
  let last = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    last = parseLine(lines[i]);
    if (last !== null) break;
  }
  const recoveredThroughSeq = last !== null && typeof last.seq === "number" ? last.seq : 0;
  if (torn !== null) {
    integrity.push({
      detail: `torn tail: (origin: ${origin}, bytes: ${torn.length}, recovered_through: ${recoveredThroughSeq})`
    });
  }
  if (last !== null && last.origin !== origin) {
    integrity.push({
      detail: `foreign origin in shard tail: (local: ${origin}, shard_tail: ${String(last.origin)}, shard: ${shard}) \u2014 writer refused`
    });
    return {
      shardExists: true,
      foreignOrigin: true,
      tornTail: torn !== null,
      recoveredThroughSeq,
      integrity
    };
  }
  return {
    shardExists: true,
    foreignOrigin: false,
    tornTail: torn !== null,
    recoveredThroughSeq,
    integrity
  };
}

// src/main.ts
var EVENTS_DIR = "_vault-index/events";
var DEFAULT_SETTINGS = { origin: "mokka" };
var VaultLogAdapter = class {
  constructor(inner) {
    this.inner = inner;
  }
  inner;
  async mkdir(path) {
    await this.inner.mkdir((0, import_obsidian.normalizePath)(path));
  }
  async write(path, data) {
    await this.inner.write((0, import_obsidian.normalizePath)(path), data);
  }
  async append(path, data) {
    await this.inner.append((0, import_obsidian.normalizePath)(path), data);
  }
  async exists(path) {
    return await this.inner.exists((0, import_obsidian.normalizePath)(path));
  }
  async readBinary(path) {
    const p = (0, import_obsidian.normalizePath)(path);
    if (!await this.inner.exists(p)) return void 0;
    const buf = await this.inner.readBinary(p);
    return new Uint8Array(buf);
  }
  async listDir(path) {
    const listing = await this.inner.list((0, import_obsidian.normalizePath)(path));
    return listing.files.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort();
  }
};
async function sha256Hex(text, len = 16) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}
var VaultOverseerIndex = class extends import_obsidian.Plugin {
  settings;
  log = null;
  /** True after onload when the foreign-origin guard fired — writer refused. */
  writerBlocked = false;
  /**
   * True if startup chain verification failed: the shard's checkpoint digest
   * does not match its contents. The writer STILL RECORDS (see onload
   * rationale) — this flag drives the settings-tab warning only.
   */
  chainBroken = false;
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new OverseerSettingTab(this.app, this));
    const adapter = new VaultLogAdapter(this.app.vault.adapter);
    const startup = await startupChecks(adapter, this.settings.origin, EVENTS_DIR);
    if (startup.foreignOrigin) {
      const detail = startup.integrity.map((r) => r.detail).join("; ");
      const msg = `Vault Overseer: foreign origin in shard tail for '${this.settings.origin}' \u2014 writer DISABLED. Fix the origin setting or the shard, then reload.`;
      console.error("[vault-overseer]", msg, detail);
      new import_obsidian.Notice(msg, 15e3);
      this.writerBlocked = true;
      return;
    }
    this.log = new EventLog({
      adapter,
      origin: this.settings.origin,
      eventsDir: EVENTS_DIR,
      initialSeq: startup.recoveredThroughSeq,
      now: () => defaultLocalIso(),
      hasTornTail: startup.tornTail
    });
    const shardPath = `${EVENTS_DIR}/${this.settings.origin}.jsonl`;
    try {
      const chain = await verifyChain(adapter, shardPath, this.settings.origin);
      if (!chain.valid) {
        this.chainBroken = true;
        const detail = chain.detail ?? "unknown chain failure";
        console.error("[vault-overseer] chain verification FAILED:", detail);
        new import_obsidian.Notice(
          `Vault Overseer: checkpoint chain verification FAILED for '${this.settings.origin}' \u2014 shard integrity is compromised. Details recorded in the event log.`,
          15e3
        );
      }
    } catch (err) {
      this.chainBroken = true;
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[vault-overseer] chain verification threw:", detail);
      await this.log.reportIntegrity(`chain verification threw: ${detail}`);
    }
    if (startup.integrity.length > 0) {
      await this.log.reportIntegrity(
        startup.integrity.map((r) => r.detail).join("; ")
      );
    }
    if (this.chainBroken) {
      const chain = await verifyChain(adapter, shardPath, this.settings.origin);
      await this.log.reportIntegrity(
        `chain verification failed: ${chain.detail ?? "unknown chain failure"}`
      );
    }
    const settingsSha = await sha256Hex(JSON.stringify(this.settings));
    await this.log.reportIntegrity(
      `session.opened-interim: plugin_versions=vault-overseer-index@${this.manifest.version}, settings_sha=${settingsSha}`
    );
  }
  onunload() {
    void this.log?.dispose();
    this.log = null;
  }
  /**
   * Public API surface for Plugin 2 (and anything else). Null while the
   * writer is blocked (foreign-origin) or unloaded — callers must handle it.
   */
  getApi() {
    if (this.log === null) return null;
    const log = this.log;
    return {
      appendEvent: log.appendEvent.bind(log),
      get lastSeq() {
        return log.lastSeq;
      }
    };
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings(next) {
    const changed = Object.keys(next).filter(
      (k) => next[k] !== this.settings[k]
    );
    this.settings = Object.assign({}, this.settings, next);
    await this.saveData(this.settings);
    if (changed.length > 0 && this.log !== null) {
      await this.log.reportIntegrity(
        `settings.changed-interim: keys=[${changed.join(", ")}]`
      );
    }
  }
};
var OverseerSettingTab = class extends import_obsidian.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Origin (device id)").setDesc(
      "Per-device shard id \u2014 the spine file this machine writes. Changing it takes effect after a plugin reload (the startup guard re-runs). mokka / latitude on this setup."
    ).addText(
      (text) => text.setPlaceholder("mokka").setValue(this.plugin.settings.origin).onChange(async (value) => {
        await this.plugin.saveSettings({ origin: value.trim() });
        new import_obsidian.Notice(
          "Vault Overseer: origin changed \u2014 reload the plugin (or restart Obsidian) to re-run startup checks."
        );
      })
    );
    if (this.plugin.writerBlocked) {
      containerEl.createEl("p", {
        text: "\u26A0 Writer BLOCKED: foreign origin detected in the shard tail. Resolve the mismatch, then reload the plugin.",
        cls: "mod-warning"
      });
    }
    if (this.plugin.chainBroken) {
      containerEl.createEl("p", {
        text: "\u26A0 Chain verification FAILED at startup: the shard's checkpoint digest does not match its contents (tamper, truncation, or a sync drop). The writer is still recording \u2014 the failing checkpoint's seq is named in the event log.",
        cls: "mod-warning"
      });
    }
  }
};
