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
  switch (event.type) {
    case "note.created":
      return { path: event.payload.path, mtime: event.payload.mtime, bytes: event.payload.bytes, content_sha: event.payload.content_sha };
    case "note.modified":
      return { path: event.payload.path, mtime: event.payload.mtime, bytes: event.payload.bytes, content_sha: event.payload.content_sha };
    case "note.deleted":
      return { path: event.payload.path, last_content_sha: event.payload.last_content_sha };
    case "note.renamed":
      return { from: event.payload.from, to: event.payload.to };
    case "note.conflicted":
      return { path: event.payload.path, conflict_copy_path: event.payload.conflict_copy_path };
    case "note.opened":
      return { path: event.payload.path, dwell: event.payload.dwell };
    case "chunk.indexed":
      return { path: event.payload.path, ord: event.payload.ord, bs: event.payload.bs, be: event.payload.be, vh: event.payload.vh, cp: event.payload.cp };
    case "chunk.evicted":
      return { vh: event.payload.vh, path: event.payload.path };
    case "log.integrity":
      return { detail: event.payload.detail };
    case "log.checkpoint":
      return { last_seq: event.payload.last_seq, events: event.payload.events, digest: event.payload.digest };
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
  /** Subscriber seam — live taps on the serialized queue. */
  subscribers = [];
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
  /**
   * Subscriber seam: register a live tap on the serialized queue.
   * Callback fires after every successful appendEvent() commit.
   * @param name Optional identifier for error reporting
   * @returns Unsubscribe handle (idempotent)
   */
  subscribe(name, cb) {
    const subscriber = { name, cb };
    this.subscribers.push(subscriber);
    return () => {
      const idx = this.subscribers.indexOf(subscriber);
      if (idx !== -1) {
        this.subscribers.splice(idx, 1);
      }
    };
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
      this.buffer.push({ line, event });
      this.scheduleIdleFlush();
      if (this.buffer.length >= this.hardCap || this.buffer.length >= this.flushCount) {
        await this.flushLocked();
      }
      return;
    }
    const combined = this.buffer.length > 0 ? this.buffer.map((b) => b.line).join("") + line : line;
    try {
      const writeData = this.hasTornTail ? "\n" + combined : combined;
      this.hasTornTail = false;
      await this.adapter.append(this.shardPath, writeData);
      this.buffer = [];
      this.stopIdleFlush();
      this.notifySubscribers(event);
    } catch (err) {
      this.seq = seq - 1;
      throw err;
    }
  }
  async flushLocked() {
    if (this.buffer.length === 0) return;
    const combined = this.buffer.map((b) => b.line).join("");
    await this.adapter.append(this.shardPath, combined);
    for (const { event } of this.buffer) {
      this.notifySubscribers(event);
    }
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
      this.notifySubscribers(event);
    } catch (err) {
      this.seq = seq - 1;
      throw err;
    }
  }
  /**
   * Fire all registered subscribers. Errors are logged, never propagated.
   * Called only after successful disk append.
   *
   * HAZARD RULING (2026-10-29): a subscriber throwing on log.integrity
   * would create an unbounded self-loop (throw → reportIntegrity →
   * integrity event → fanout → throw → ...). The fix: skip fanout for
   * integrity events born of subscriber errors. Logs once to error
   * channel, no recursion. F13 certifies containment before and after.
   */
  notifySubscribers(event) {
    for (const { name, cb } of this.subscribers) {
      try {
        cb(event);
      } catch (err) {
        const who = name ?? "<anonymous>";
        if (event.type !== "log.integrity") {
          void this.reportIntegrity(
            `subscriber threw: ${who} \u2014 ${String(err)}`
          );
        } else {
          console.error(`[eventlog] subscriber threw on integrity event: ${who} \u2014 ${String(err)}`);
        }
      }
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
async function mergeScan(source, eventsDir) {
  const names = await source.listDir(eventsDir);
  const shards = names.filter((n) => n.endsWith(".jsonl")).sort();
  const originOrder = /* @__PURE__ */ new Map();
  shards.forEach((n, i) => originOrder.set(n.replace(/\.jsonl$/, ""), i));
  const events = [];
  const integrity = [];
  const gaps = [];
  for (const name of shards) {
    const origin = name.replace(/\.jsonl$/, "");
    const bytes = await source.readBinary(`${eventsDir}/${name}`);
    if (bytes === void 0) continue;
    const { lines, torn } = splitCompleteLines(bytes);
    if (torn !== null) {
      integrity.push({
        detail: `torn tail: (origin: ${origin}, bytes: ${torn.length})`
      });
    }
    let expected = 1;
    for (const raw of lines) {
      const line = parseLine(raw);
      if (line === null) {
        integrity.push({
          detail: `unreadable line: (origin: ${origin}, expected_seq: ${expected})`
        });
        continue;
      }
      const seq = typeof line.seq === "number" ? line.seq : -1;
      if (seq !== expected) {
        gaps.push({ origin, expected_seq: expected, got_seq: seq });
        integrity.push({
          detail: `gap: (origin: ${origin}, expected_seq: ${expected}, got_seq: ${seq})`
        });
        break;
      }
      events.push(line);
      expected++;
    }
  }
  events.sort((a, b) => {
    const oa = originOrder.get(String(a.origin)) ?? 999;
    const ob = originOrder.get(String(b.origin)) ?? 999;
    if (oa !== ob) return oa - ob;
    return (typeof a.seq === "number" ? a.seq : 0) - (typeof b.seq === "number" ? b.seq : 0);
  });
  return { events, integrity, gaps };
}

// src/eventlog/projection.ts
function projectPaths(events) {
  const livePaths = /* @__PURE__ */ new Set();
  const deadPaths = /* @__PURE__ */ new Set();
  for (const e of events) {
    const t = String(e.type);
    if (t === "note.created" || t === "note.modified") {
      if (typeof e.path === "string") {
        livePaths.add(e.path);
        deadPaths.delete(e.path);
      }
    } else if (t === "note.renamed") {
      if (typeof e.from === "string") {
        livePaths.delete(e.from);
        deadPaths.add(e.from);
      }
      if (typeof e.to === "string") {
        livePaths.add(e.to);
        deadPaths.delete(e.to);
      }
    } else if (t === "note.deleted") {
      if (typeof e.path === "string") {
        livePaths.delete(e.path);
        deadPaths.add(e.path);
      }
    }
  }
  return { livePaths, deadPaths };
}

// src/chunker/render.ts
var import_node_crypto2 = require("node:crypto");
function sha16(bytes) {
  return (0, import_node_crypto2.createHash)("sha256").update(bytes).digest("hex").slice(0, 16);
}
function contentSha(fileBytes) {
  return sha16(fileBytes);
}
function canonScalarOrList(v) {
  if (v === void 0) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  const items = v.map((s) => s.trim()).filter((s) => s !== "");
  return items.length === 0 ? null : items;
}
function serializeFmContext(fm) {
  if (fm === null) return null;
  const out = {};
  const aliases = canonScalarOrList(fm.aliases);
  if (aliases !== null) out.aliases = aliases;
  if (typeof fm.description === "string") {
    const t = fm.description.trim();
    if (t !== "") out.description = t;
  }
  const tags = canonScalarOrList(fm.tags);
  if (tags !== null) out.tags = tags;
  if (typeof fm.type === "string") {
    const t = fm.type.trim();
    if (t !== "") out.type = t;
  }
  if (Object.keys(out).length === 0) return null;
  return JSON.stringify(out);
}
function renderEmbedInput(taskPrefix, headingChain, fmContext, chunkText) {
  let out = taskPrefix;
  for (const heading of headingChain) out += heading + "\n";
  const fm = serializeFmContext(fmContext);
  if (fm !== null) out += fm + "\n";
  return out + chunkText;
}
function embedVh(embedInput) {
  return sha16(Buffer.from(embedInput, "utf-8"));
}
var SELECTED_KEYS = /* @__PURE__ */ new Set(["aliases", "description", "tags", "type"]);
var KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*:/;
var DASH_ITEM_RE = /^\s+-\s?(.*)$/;
function stripQuotes(s) {
  if (s.length >= 2 && (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}
function assign(fm, key, value) {
  if (key === "aliases") fm.aliases = value;
  else if (key === "tags") fm.tags = value;
  else if (key === "description" && typeof value === "string") {
    fm.description = value;
  } else if (key === "type" && typeof value === "string") {
    fm.type = value;
  }
}
function parseInlineValue(rest) {
  if (rest.startsWith("[") && rest.endsWith("]")) {
    const inner = rest.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => stripQuotes(s.trim())).filter((s) => s !== "");
  }
  return stripQuotes(rest);
}
function parseFmContext(blockText) {
  const fm = {};
  const lines = blockText.split("\n").map((l) => l.replace(/\r$/, ""));
  const seen = /* @__PURE__ */ new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!KEY_RE.test(line)) {
      i++;
      continue;
    }
    const colon = line.indexOf(":");
    const key = line.slice(0, colon);
    const rest = line.slice(colon + 1).trim();
    const isDashListHead = rest === "";
    const items = [];
    let j = i + 1;
    while (j < lines.length) {
      const dm = DASH_ITEM_RE.exec(lines[j]);
      if (dm === null) break;
      items.push(stripQuotes(dm[1].trim()));
      j++;
    }
    if (seen.has(key) || !SELECTED_KEYS.has(key)) {
      i = j;
      continue;
    }
    seen.add(key);
    if (isDashListHead) {
      if (items.length > 0) assign(fm, key, items);
    } else {
      assign(fm, key, parseInlineValue(rest));
    }
    i = j;
  }
  return fm;
}

// src/chunker/chunker.ts
var CHUNKER_CP = 2;
var TARGET_BYTES = 2048;
var CEILING_BYTES = 3072;
var BOM = [239, 187, 191];
function lineEnd(bytes, from) {
  const nl = bytes.indexOf(10, from);
  return nl === -1 ? bytes.length : nl + 1;
}
function decodeLine(bytes, bs, be) {
  return Buffer.from(bytes.subarray(bs, be)).toString("utf-8").replace(/\r$/, "");
}
function isWhitespaceByte(b) {
  return b === 32 || b === 9 || b === 10 || b === 13;
}
function partitionFrontmatter(bytes, start) {
  const firstLe = lineEnd(bytes, start);
  if (decodeLine(bytes, start, firstLe).trim() !== "---") {
    return { fm: null, bodyStart: start };
  }
  let i = firstLe;
  while (i < bytes.length) {
    const le = lineEnd(bytes, i);
    if (decodeLine(bytes, i, le).trim() === "---") {
      const blockText = Buffer.from(bytes.subarray(firstLe, i)).toString("utf-8");
      return { fm: parseFmContext(blockText), bodyStart: le };
    }
    i = le;
  }
  return { fm: null, bodyStart: start };
}
var HEADING_RE = /^(#{1,6})(?:\s+(.*))?$/;
function walkParagraphs(bytes, bodyStart) {
  const paras = [];
  let chain = [];
  let inFence = false;
  let afterHeading = true;
  let cur = null;
  const close = () => {
    if (cur !== null) {
      paras.push(cur);
      cur = null;
    }
  };
  let i = bodyStart;
  while (i < bytes.length) {
    const le = lineEnd(bytes, i);
    const t = decodeLine(bytes, i, le).trim();
    const startsFence = t.startsWith("```");
    if (inFence) {
      if (startsFence) inFence = false;
      cur.be = le;
    } else if (startsFence) {
      inFence = true;
      close();
      cur = { bs: i, be: le, chain: [...chain], afterHeading, kind: "atomic" };
      afterHeading = false;
    } else if (t === "") {
      close();
    } else {
      const h = HEADING_RE.exec(t);
      if (h !== null) {
        close();
        const level = h[1].length;
        chain = chain.slice(0, level - 1);
        chain.push((h[2] ?? "").trim());
        afterHeading = true;
      } else if (cur !== null) {
        cur.be = le;
      } else {
        const kind = t.startsWith("|") ? "atomic" : "text";
        cur = { bs: i, be: le, chain: [...chain], afterHeading, kind };
        afterHeading = false;
      }
    }
    i = le;
  }
  close();
  return paras;
}
function sentenceBoundaries(bytes, s, e) {
  const out = [];
  for (let i = s; i < e; i++) {
    const b = bytes[i];
    let termLen = 0;
    if (b === 46 || b === 33 || b === 63) termLen = 1;
    else if (b === 227 && bytes[i + 1] === 128 && bytes[i + 2] === 130) termLen = 3;
    else if (b === 239 && bytes[i + 1] === 188 && (bytes[i + 2] === 129 || bytes[i + 2] === 159)) termLen = 3;
    if (termLen === 0) continue;
    const after = i + termLen;
    if (after >= e || isWhitespaceByte(bytes[after])) {
      out.push(after);
      i = after - 1;
    }
  }
  return out;
}
function wordBoundaries(bytes, s, e) {
  const out = [];
  let i = s;
  while (i < e) {
    if (isWhitespaceByte(bytes[i])) {
      let j = i;
      while (j < e && isWhitespaceByte(bytes[j])) j++;
      if (j < e) out.push(j);
      i = j;
    } else {
      i++;
    }
  }
  return out;
}
function utf8SafeCut(bytes, limit) {
  while ((bytes[limit] & 192) === 128) limit--;
  return limit;
}
function splitRange(bytes, s, e, level, carves) {
  const lengths = [];
  if (level === "byte") {
    let pos = s;
    while (e - pos > CEILING_BYTES) {
      const cut = utf8SafeCut(bytes, pos + CEILING_BYTES);
      lengths.push(cut - pos);
      carves.push({ bs: pos, be: e, reason: "over-ceiling-byte-carved" });
      pos = cut;
    }
    if (e > pos) lengths.push(e - pos);
    return lengths;
  }
  const units = level === "sentence" ? sentenceBoundaries(bytes, s, e) : wordBoundaries(bytes, s, e);
  const all = [...units];
  if (all[all.length - 1] !== e) all.push(e);
  let pieceStart = s;
  let prev = s;
  for (const k of all) {
    const unitLen = k - prev;
    if (unitLen > CEILING_BYTES) {
      if (prev > pieceStart) lengths.push(prev - pieceStart);
      lengths.push(...splitRange(bytes, prev, k, level === "sentence" ? "word" : "byte", carves));
      pieceStart = k;
    } else if (k - pieceStart > TARGET_BYTES && prev > pieceStart) {
      lengths.push(prev - pieceStart);
      pieceStart = prev;
    }
    prev = k;
  }
  if (e > pieceStart) lengths.push(e - pieceStart);
  return lengths;
}
function chunkNote(fileBytes) {
  const hadBom = fileBytes.length >= 3 && fileBytes[0] === BOM[0] && fileBytes[1] === BOM[1] && fileBytes[2] === BOM[2];
  const start = hadBom ? 3 : 0;
  const { fm, bodyStart } = partitionFrontmatter(fileBytes, start);
  const paras = walkParagraphs(fileBytes, bodyStart);
  const carves = [];
  const drafts = [];
  let cur = null;
  for (const p of paras) {
    const plen = p.be - p.bs;
    if (plen > CEILING_BYTES) {
      if (cur !== null) {
        drafts.push(cur);
        cur = null;
      }
      let pos = p.bs;
      for (const len of splitRange(
        fileBytes,
        p.bs,
        p.be,
        p.kind === "atomic" ? "byte" : "sentence",
        carves
      )) {
        drafts.push({ bs: pos, be: pos + len, chain: p.chain });
        pos += len;
      }
      continue;
    }
    if (p.afterHeading && cur !== null) {
      drafts.push(cur);
      cur = null;
    }
    if (cur !== null && p.be - cur.bs <= TARGET_BYTES) {
      cur.be = p.be;
    } else {
      if (cur !== null) drafts.push(cur);
      cur = { bs: p.bs, be: p.be, chain: p.chain };
    }
  }
  if (cur !== null) drafts.push(cur);
  const chunks = drafts.map((d, ord) => {
    const text = Buffer.from(fileBytes.subarray(d.bs, d.be)).toString("utf-8");
    return {
      ord,
      bs: d.bs,
      be: d.be,
      vh: embedVh(renderEmbedInput("search_document:", d.chain, fm, text)),
      cp: CHUNKER_CP,
      chain: d.chain
    };
  });
  return { chunks, carves, hadBom, fm };
}

// src/eventlog/heal.ts
var HOME_CP = 2;
async function healScan(log, source, eventsDir) {
  const scan = await mergeScan(source, eventsDir);
  if (scan.gaps.length > 0) {
    for (const g of scan.gaps) {
      await log.reportIntegrity(
        `heal refused: seq gap (origin: ${g.origin}, expected_seq: ${g.expected_seq}, got_seq: ${g.got_seq}) \u2014 spine must be contiguous before re-derivation`
      );
    }
    return {
      pathsExamined: 0,
      chunksReemitted: 0,
      vhDeduped: 0,
      p1Failures: 0,
      p1Skipped: 0,
      refused: true
    };
  }
  const { livePaths: notePaths } = projectPaths(scan.events);
  const existingChunks = /* @__PURE__ */ new Map();
  for (const e of scan.events) {
    const t = String(e.type);
    if (t === "chunk.indexed" && typeof e.path === "string") {
      const list = existingChunks.get(e.path) ?? [];
      list.push(e);
      existingChunks.set(e.path, list);
    }
  }
  const result = {
    pathsExamined: notePaths.size,
    chunksReemitted: 0,
    vhDeduped: 0,
    p1Failures: 0,
    p1Skipped: 0,
    refused: false
  };
  for (const path of notePaths) {
    const bytes = await source.readBinary(path);
    if (bytes === void 0) {
      await log.reportIntegrity(
        `heal: file absent (path: ${path}) \u2014 chunk eviction owed to the real chunker, not improvised here`
      );
      continue;
    }
    const sha = contentSha(bytes);
    const derived = chunkNote(bytes);
    const haveVh = new Set(
      (existingChunks.get(path) ?? []).map((c) => String(c.vh))
    );
    let emitted = 0;
    for (const chunk of derived.chunks) {
      if (haveVh.has(chunk.vh)) {
        result.vhDeduped++;
        continue;
      }
      await log.appendEvent("plugin", "chunk.indexed", {
        path,
        ord: chunk.ord,
        bs: chunk.bs,
        be: chunk.be,
        vh: chunk.vh,
        cp: chunk.cp
      });
      haveVh.add(chunk.vh);
      emitted++;
      result.chunksReemitted++;
    }
    if (emitted > 0) {
      await log.reportIntegrity(
        `buffer window lost, ${emitted} events re-derived from sha (path: ${path}, content_sha: ${sha})`
      );
      for (const carve of derived.carves) {
        await log.reportIntegrity(
          `chunk.carve path="${path}" reason=${carve.reason} paragraph_end=${carve.be} pieces=${derived.chunks.length}`
        );
      }
    }
    for (const rec of existingChunks.get(path) ?? []) {
      const cp = Number(rec.cp);
      if (cp !== HOME_CP) {
        result.p1Skipped++;
        await log.reportIntegrity(
          `p1 skipped: unknown chunk policy (path: ${path}, ord: ${rec.ord}, cp: ${cp}) \u2014 verification owed to the policy's owner`
        );
        continue;
      }
      const derivable = derived.chunks.some(
        (c) => c.vh === String(rec.vh)
      );
      if (!derivable) {
        result.p1Failures++;
        await log.reportIntegrity(
          `p1 violation: recorded vh no longer derivable (path: ${path}, ord: ${rec.ord}, vh: ${rec.vh}) \u2014 chunk eviction owed to the real chunker, not improvised here`
        );
      }
    }
  }
  return result;
}

// src/dwell/gate.ts
var DwellGate = class {
  gateMs;
  gateSeconds;
  now;
  schedule;
  emit;
  activeNote = null;
  /**
   * Banked dwell per noteId, with last-known path. Session-scoped,
   * never persisted. Path refreshes on every open of that note AND
   * on renamePath/renamePrefix, so farewell emissions name where
   * the note was LAST seen.
   */
  lanes = /* @__PURE__ */ new Map();
  /**
   * noteIds that have crossed the gate this session. Survives the
   * activeNote lifecycle (the note may be switched away and back);
   * presence here suppresses timer re-arming for that note for the
   * rest of the session.
   */
  crossedThisSession = /* @__PURE__ */ new Set();
  timer = null;
  constructor(opts) {
    this.gateMs = opts.gateMs ?? 1e4;
    this.gateSeconds = Math.floor(this.gateMs / 1e3);
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((cb, ms) => {
      const t = setTimeout(() => cb(), ms);
      return { cancel: () => clearTimeout(t) };
    });
    this.emit = opts.emit;
  }
  // ---------------------------------------------------------------------------
  // Public surface — mirrors the plugin's actual events
  // ---------------------------------------------------------------------------
  /**
   * A file was opened. Banks the outgoing note's dwell (if any) into
   * its lane, cancels any pending timer, and arms a fresh timer for
   * the incoming note — unless that note has already crossed this
   * session, in which case its dwell simply banks.
   */
  open(noteId, path) {
    const now = this.now();
    this.bankActive(now);
    this.clearTimer();
    const emitted = this.crossedThisSession.has(noteId);
    this.activeNote = { noteId, path, openAt: now, emitted };
    const lane = this.lanes.get(noteId);
    if (lane !== void 0) lane.path = path;
    if (emitted) return;
    const banked = this.lanes.get(noteId)?.ms ?? 0;
    const remaining = this.gateMs - banked;
    if (remaining <= 0) {
      void this.fire();
      return;
    }
    this.armTimer(remaining);
  }
  /** file-open fired with null: the workspace holds no file. Bank, stand down. */
  noFileOpen() {
    this.bankActive(this.now());
    this.clearTimer();
  }
  /**
   * A note was renamed (FILE rename; exact path match). Rewrites the
   * note's last-known path in the active note and every accrual lane,
   * so any threshold or farewell emission from here forward names
   * where the note IS.
   *
   * A rename touching no known lane (fresh file, foreign path) is a
   * harmless no-op.
   */
  renamePath(from, to) {
    if (this.activeNote !== null && this.activeNote.path === from) {
      this.activeNote.path = to;
    }
    for (const lane of this.lanes.values()) {
      if (lane.path === from) lane.path = to;
    }
  }
  /**
   * A folder was renamed (PREFIX rewrite). Every known path under
   * `from/` is remapped to `to/...` — the active note and every
   * accrual lane. A folder rename invalidates the storage address of
   * everything beneath it; this keeps every path the gate holds
   * truthful in the same instant, so emissions and farewells never
   * name a dead address.
   *
   * Notes OUTSIDE the renamed prefix are untouched. A prefix touching
   * no known paths is a harmless no-op.
   */
  renamePrefix(from, to) {
    const fromPrefix = from.endsWith("/") ? from : `${from}/`;
    if (this.activeNote !== null && this.activeNote.path.startsWith(fromPrefix)) {
      this.activeNote.path = to.replace(/\/+$/, "") + this.activeNote.path.slice(from.length);
    }
    for (const lane of this.lanes.values()) {
      if (lane.path.startsWith(fromPrefix)) {
        lane.path = to.replace(/\/+$/, "") + lane.path.slice(from.length);
      }
    }
  }
  /**
   * Session end. Banks the active note, cancels any pending timer, and
   * RETURNS the over-gate accruals (actual dwell-so-far since the last
   * emission, floor seconds, with each lane's last-known path) for the
   * caller to emit before dispose(). Under-gate accruals are discarded
   * — silence is the v1 ruling. Clears all lanes.
   */
  sessionEnd() {
    this.bankActive(this.now());
    this.clearTimer();
    const farewells = [];
    for (const lane of this.lanes.values()) {
      if (lane.ms >= this.gateMs) {
        farewells.push({
          path: lane.path,
          dwellSeconds: Math.floor(lane.ms / 1e3)
        });
      }
    }
    this.lanes.clear();
    this.crossedThisSession.clear();
    return farewells;
  }
  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------
  /** Add the active note's elapsed dwell to its lane, then drop it. */
  bankActive(now) {
    if (this.activeNote === null) return;
    const elapsed = now - this.activeNote.openAt;
    if (elapsed > 0) {
      const existing = this.lanes.get(this.activeNote.noteId);
      if (existing !== void 0) {
        existing.path = this.activeNote.path;
        existing.ms += elapsed;
      } else {
        this.lanes.set(this.activeNote.noteId, {
          path: this.activeNote.path,
          ms: elapsed
        });
      }
    }
    this.activeNote = null;
  }
  clearTimer() {
    if (this.timer !== null) {
      this.timer.cancel();
      this.timer = null;
    }
  }
  armTimer(remainingMs) {
    const note = this.activeNote;
    if (note === null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.fire();
    }, remainingMs);
  }
  /**
   * The gate crossing. Emits flat gate seconds, resets the accrual,
   * rebaselines openAt, and marks the note crossed — its continued
   * dwell now banks toward the farewell flush only.
   *
   * Defensive: a late timer firing after the note switched away is
   * ignored (open/noFileOpen cancel the timer, but belt and braces —
   * a fire with no active note, or for a note already emitted, is a
   * no-op, never an orphan emission).
   */
  async fire() {
    const note = this.activeNote;
    if (note === null || note.emitted) return;
    this.clearTimer();
    note.emitted = true;
    this.crossedThisSession.add(note.noteId);
    this.lanes.set(note.noteId, { path: note.path, ms: 0 });
    note.openAt = this.now();
    await this.emit(note.path, this.gateSeconds);
  }
};

// src/watcher/watch.ts
function makeWatcherLane(deps, options = {}) {
  const cap = options.darkBufferCap ?? 500;
  const buffer = [];
  let live = false;
  let droppedDark = 0;
  const lastShaByPath = /* @__PURE__ */ new Map();
  function isEmittable(file) {
    if (file.isFolder) return false;
    return file.ext.toLowerCase() === "md";
  }
  async function emit(fact) {
    if (!live) {
      if (buffer.length >= cap) {
        buffer.shift();
        droppedDark++;
      }
      buffer.push(fact);
      return;
    }
    await append(fact);
  }
  async function append(fact) {
    if (fact.type === "note.deleted") {
      const payload = { path: fact.path };
      if (fact.last_content_sha !== void 0) {
        payload.last_content_sha = fact.last_content_sha;
      }
      await deps.appendEvent("user", fact.type, payload);
      return;
    }
    await deps.appendEvent("user", fact.type, {
      path: fact.path,
      mtime: fact.mtime,
      bytes: fact.bytes,
      content_sha: fact.content_sha
    });
  }
  async function onVaultCreate(file) {
    if (!isEmittable(file)) return;
    const stat = await deps.stat(file.path);
    const sha = await deps.contentSha(file.path);
    lastShaByPath.set(file.path, sha);
    await emit({
      type: "note.created",
      path: file.path,
      mtime: stat.mtime,
      bytes: stat.bytes,
      content_sha: sha
    });
  }
  async function onVaultDelete(file) {
    if (!isEmittable(file)) return;
    const lastSha = lastShaByPath.get(file.path);
    lastShaByPath.delete(file.path);
    await emit({ type: "note.deleted", path: file.path, last_content_sha: lastSha });
  }
  async function flushAfterAttach() {
    if (droppedDark > 0) {
      const n = droppedDark;
      droppedDark = 0;
      if (deps.reportIntegrity !== void 0) {
        await deps.reportIntegrity(
          `watcher dark-buffer overflow: ${n} file facts dropped (oldest) \u2014 writer attach delayed beyond cap`
        );
      }
    }
    while (buffer.length > 0) {
      const fact = buffer.shift();
      if (fact === void 0) break;
      await append(fact);
    }
    live = true;
  }
  async function reconcilePaths(vaultPaths, knownPaths) {
    if (!live) return -1;
    const missing = vaultPaths.filter((p) => !knownPaths.has(p)).sort();
    for (const path of missing) {
      await onVaultCreate({ path, isFolder: false, ext: "md" });
    }
    return missing.length;
  }
  return {
    onVaultCreate,
    onVaultDelete,
    flushAfterAttach,
    reconcilePaths,
    get pendingCount() {
      return buffer.length;
    }
  };
}

// src/planner/planner.ts
function lastStateByPath(events) {
  const state = /* @__PURE__ */ new Map();
  for (const e of events) {
    const t = String(e.type);
    if (t === "note.created" || t === "note.modified") {
      if (typeof e.path === "string" && typeof e.mtime === "number" && typeof e.bytes === "number" && typeof e.content_sha === "string") {
        state.set(e.path, {
          mtime: e.mtime,
          bytes: e.bytes,
          content_sha: e.content_sha
        });
      }
    } else if (t === "note.renamed") {
      const from = e.from;
      const to = e.to;
      if (typeof from === "string" && typeof to === "string") {
        const carried = state.get(from);
        state.delete(from);
        if (carried !== void 0) {
          state.set(to, carried);
        }
      }
    } else if (t === "note.deleted") {
      if (typeof e.path === "string") {
        state.delete(e.path);
      }
    }
  }
  return state;
}
function makePlanner(deps, ctx, options = {}) {
  const windowMs = options.windowMs ?? 3e4;
  const maxPending = options.maxPending ?? 500;
  const pending = /* @__PURE__ */ new Map();
  let armed = false;
  let droppedOverflow = 0;
  let timerHandle = null;
  let inFlight = null;
  async function integrity(detail) {
    if (deps.reportIntegrity !== void 0) {
      await deps.reportIntegrity(detail);
    }
  }
  function isEmittable(file) {
    if (file.isFolder) return false;
    return file.ext.toLowerCase() === "md";
  }
  function scheduleWindow() {
    if (deps.scheduler === void 0) return;
    if (timerHandle !== null) return;
    timerHandle = deps.scheduler.setTimer(() => {
      timerHandle = null;
      void flush();
    }, windowMs);
  }
  function cancelWindow() {
    if (deps.scheduler !== void 0 && timerHandle !== null) {
      deps.scheduler.clearTimer(timerHandle);
      timerHandle = null;
    }
  }
  async function onVaultModify(file) {
    if (!armed) return;
    if (!isEmittable(file)) return;
    const stat = await deps.stat(file.path);
    const sha = await deps.contentSha(file.path);
    if (!pending.has(file.path) && pending.size >= maxPending) {
      const oldest = pending.keys().next().value;
      if (oldest !== void 0) {
        pending.delete(oldest);
        droppedOverflow++;
      }
    }
    pending.set(file.path, {
      path: file.path,
      mtime: stat.mtime,
      bytes: stat.bytes,
      content_sha: sha
    });
    scheduleWindow();
  }
  async function runFlush() {
    if (pending.size === 0) {
      return { emitted: 0, suppressed: 0, routedCreate: 0, routedRestore: 0, refused: false };
    }
    cancelWindow();
    const batch = [...pending.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    pending.clear();
    if (droppedOverflow > 0) {
      const n = droppedOverflow;
      droppedOverflow = 0;
      await integrity(
        `planner coalescing overflow: ${n} pending modify observations dropped (oldest) \u2014 window exceeded distinct-path cap`
      );
    }
    const scan = await mergeScan(ctx.source, ctx.eventsDir);
    if (scan.gaps.length > 0) {
      for (const g of scan.gaps) {
        await integrity(
          `planner refused: seq gap (origin: ${g.origin}, expected_seq: ${g.expected_seq}, got_seq: ${g.got_seq}) \u2014 spine must be contiguous before modification emission; ${batch.length} pending observations dropped, heal is the recovery path`
        );
      }
      return { emitted: 0, suppressed: 0, routedCreate: 0, routedRestore: 0, refused: true };
    }
    const { livePaths, deadPaths } = projectPaths(scan.events);
    const stateByPath = lastStateByPath(scan.events);
    let emitted = 0;
    let suppressed = 0;
    let routedCreate = 0;
    let routedRestore = 0;
    for (const [, fact] of batch) {
      if (!livePaths.has(fact.path)) {
        if (deadPaths.has(fact.path)) {
          if (deps.routeRestore !== void 0) {
            await deps.routeRestore(fact.path);
            routedRestore++;
          } else {
            await integrity(
              `planner: spine-dead path with pending modify (path: ${fact.path}) \u2014 routeRestore unwired, observation dropped (heal-covered)`
            );
          }
        } else {
          if (deps.routeCreate !== void 0) {
            await deps.routeCreate(fact.path);
            routedCreate++;
          } else {
            await integrity(
              `planner: spine-unknown path with pending modify (path: ${fact.path}) \u2014 routeCreate unwired, observation dropped (heal-covered)`
            );
          }
        }
        continue;
      }
      const recorded = stateByPath.get(fact.path);
      if (recorded !== void 0 && recorded.mtime === fact.mtime && recorded.content_sha === fact.content_sha) {
        suppressed++;
        continue;
      }
      await deps.appendEvent("user", "note.modified", {
        path: fact.path,
        mtime: fact.mtime,
        bytes: fact.bytes,
        content_sha: fact.content_sha
      });
      emitted++;
    }
    return { emitted, suppressed, routedCreate, routedRestore, refused: false };
  }
  function flush() {
    if (inFlight !== null) return inFlight;
    inFlight = runFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  return {
    onVaultModify,
    cancelPending(path) {
      pending.delete(path);
      if (pending.size === 0) cancelWindow();
    },
    arm() {
      armed = true;
    },
    flush,
    get pendingCount() {
      return pending.size;
    }
  };
}

// src/main.ts
var EVENTS_DIR = "_vault-index/events";
var ORIGIN_FILE = "origin.txt";
var RECONCILE_REFUSED_DARK = -1;
var RECONCILE_REFUSED_GAP = -2;
var DEFAULT_SETTINGS = {};
function asTypedPayload(p) {
  return p;
}
function asModifiedPayload(p) {
  return p;
}
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
  async readUtf8(path) {
    const p = (0, import_obsidian.normalizePath)(path);
    if (!await this.inner.exists(p)) return void 0;
    const bytes = new Uint8Array(await this.inner.readBinary(p));
    return new TextDecoder("utf-8").decode(bytes);
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
async function resolveOrigin(adapter, pluginFolder) {
  const originPath = `${pluginFolder}/${ORIGIN_FILE}`;
  if (await adapter.exists(originPath)) {
    const raw = await adapter.readUtf8(originPath);
    const candidate = raw?.trim() ?? "";
    if (candidate.length > 0) {
      return {
        origin: candidate,
        foundShards: [],
        foundOrigins: [],
        fromOriginFile: true
      };
    }
  }
  let foundShards = [];
  if (await adapter.exists(EVENTS_DIR)) {
    foundShards = (await adapter.listDir(EVENTS_DIR)).filter(
      (n) => n.endsWith(".jsonl")
    );
  }
  const foundOrigins = foundShards.map((n) => n.replace(/\.jsonl$/, "")).sort();
  return {
    origin: null,
    foundShards,
    foundOrigins,
    fromOriginFile: false
  };
}
async function writeOriginFile(adapter, pluginFolder, origin) {
  const originPath = `${pluginFolder}/${ORIGIN_FILE}`;
  await adapter.write(originPath, `${origin}
`);
}
var VaultOverseerIndex = class extends import_obsidian.Plugin {
  log = null;
  /** The resolved machine identity — never sourced from data.json. */
  originId = null;
  /**
   * Rung 2 pending: origin ids awaiting human certification. Empty
   * (but non-null) for a virgin install — no shards, no candidates.
   */
  pendingCertification = null;
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
  scrubbedLegacyOrigin = null;
  /**
   * The vault-facing adapter (B3, 2026-10-25). Promoted from a local in
   * onload/certifyOrigin so reconcile can reach mergeScan's ByteSource
   * door. Set first thing in onload; null only before that.
   */
  adapter = null;
  // --- Dwell-gate adapter state (semantics live in src/dwell/gate.ts) ---
  /**
   * The pure gate, wired to this plugin's writer. Field initializer
   * is safe: the emit closure captures `this` lazily, so the gate
   * exists before onload but cannot emit into a dark writer.
   */
  dwellGate = new DwellGate({
    emit: (path, dwell) => this.emitDwell(path, dwell)
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
  watcherLane = makeWatcherLane(
    {
      stat: (path) => this.statSnapshot(path),
      contentSha: (path) => this.contentShaOf(path),
      appendEvent: async (actor, type, payload) => {
        if (this.log === null) return;
        await this.log.appendEvent(actor, type, asTypedPayload(payload));
      },
      reportIntegrity: async (detail) => {
        if (this.log === null) return;
        await this.log.reportIntegrity(detail);
      }
    },
    { darkBufferCap: 500 }
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
  plannerLane = null;
  /** Sequential counter backing the TFile->noteId map. */
  noteIdCounter = 0;
  /**
   * Opaque note-id per TFile (collision fix, 2026-10-24). Obsidian
   * reuses `Notes/Untitled.md` across successive creations; keying
   * accrual by PATH let a new creation inherit a dead predecessor's
   * banked dwell. WeakMap<TFile, string> gives every distinct file
   * object its own id for the session — same path, different note,
   * different lane. The map itself is session-scoped and garbage
   * collects with the TFiles.
   */
  noteIdMap = /* @__PURE__ */ new WeakMap();
  async onload() {
    await this.loadSettings();
    this.adapter = new VaultLogAdapter(this.app.vault.adapter);
    this.plannerLane = makePlanner(
      {
        stat: (path) => this.statSnapshot(path),
        contentSha: (path) => this.contentShaOf(path),
        appendEvent: async (actor, type, payload) => {
          if (this.log === null) return;
          await this.log.appendEvent(actor, type, asModifiedPayload(payload));
        },
        reportIntegrity: async (detail) => {
          if (this.log === null) return;
          await this.log.reportIntegrity(detail);
        },
        // Routing (ruled 2026-10-29): both hooks forward through
        // the create lane, guarded — see routeToCreateLane.
        routeCreate: (path) => this.routeToCreateLane(path, "spine-unknown"),
        routeRestore: (path) => this.routeToCreateLane(path, "spine-dead"),
        scheduler: {
          setTimer: (cb, ms) => window.setTimeout(cb, ms),
          clearTimer: (handle) => window.clearTimeout(handle)
        }
      },
      {
        source: this.adapter,
        eventsDir: EVENTS_DIR
      },
      {
        windowMs: 3e4,
        // the map's debouncer figure
        maxPending: 500
        // dark-buffer precedent
      }
    );
    const pluginFolder = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    const resolution = await resolveOrigin(this.adapter, pluginFolder);
    if (resolution.origin === null) {
      this.pendingCertification = resolution.foundOrigins;
      new import_obsidian.Notice(
        "Vault Overseer: no origin.txt \u2014 open Settings -> Vault Overseer to certify this machine's identity.",
        15e3
      );
    } else {
      await this.startWriter(this.adapter, resolution.origin, resolution.fromOriginFile);
    }
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.onFileOpen(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath))
    );
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => this.onVaultCreate(file))
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => this.onVaultDelete(file))
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => this.onVaultModify(file))
      );
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
  async runReconcileWithVault() {
    if (this.log === null || this.adapter === null || this.originId === null) {
      return RECONCILE_REFUSED_DARK;
    }
    const scan = await mergeScan(this.adapter, EVENTS_DIR);
    if (scan.gaps.length > 0) {
      const first = scan.gaps[0];
      if (first === void 0) return RECONCILE_REFUSED_GAP;
      const detail = `reconcile refused: seq gap in spine (origin=${first.origin}, expected_seq=${first.expected_seq}, got_seq=${first.got_seq}) \u2014 fix the gap before reconciling`;
      console.error("[vault-overseer]", detail);
      new import_obsidian.Notice(`Vault Overseer: ${detail}`, 15e3);
      await this.log.reportIntegrity(detail);
      return RECONCILE_REFUSED_GAP;
    }
    if (scan.integrity.length > 0) {
      await this.log.reportIntegrity(
        `reconcile scan: ${scan.integrity.map((r) => r.detail).join("; ")}`
      );
    }
    const proj = projectPaths(scan.events);
    const knownSet = proj.livePaths;
    const vaultPaths = this.app.vault.getMarkdownFiles().map((f) => f.path);
    const emitted = await this.watcherLane.reconcilePaths(vaultPaths, knownSet);
    if (emitted > 0) {
      new import_obsidian.Notice(`Vault Overseer: reconciled ${emitted} paths`, 15e3);
      await this.log.reportIntegrity(
        `reconcile: backfilled ${emitted} first-contact paths (origin=${this.originId})`
      );
    }
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
  onFileOpen(file) {
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
  getNoteId(file) {
    let id = this.noteIdMap.get(file);
    if (id === void 0) {
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
  async emitDwell(path, dwell) {
    if (this.log === null) return;
    await this.log.appendEvent("user", "note.opened", { path, dwell });
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
  onVaultRename(file, oldPath) {
    if (file instanceof import_obsidian.TFolder) {
      this.dwellGate.renamePrefix(oldPath, file.path);
      return;
    }
    this.plannerLane?.cancelPending(oldPath);
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
  async emitRename(from, to) {
    if (this.log === null) return;
    await this.log.appendEvent("user", "note.renamed", { from, to });
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
  async statSnapshot(path) {
    const stat = await this.app.vault.adapter.stat(path);
    if (stat === null || stat.type !== "file") {
      throw new Error(`Watcher stat: file absent (${path})`);
    }
    return { mtime: stat.mtime, bytes: stat.size };
  }
  /**
   * Shared content sha (slot-4 extraction, 2026-10-29): SHA-256,
   * 16 hex chars — the shard convention. One implementation, two
   * lanes (watcher + planner), zero drift between them.
   */
  async contentShaOf(path) {
    const bytes = await this.app.vault.adapter.readBinary(path);
    if (bytes === void 0) {
      throw new Error(`Watcher sha: file absent (${path})`);
    }
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(bytes)
    );
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }
  /**
   * Vault create receipt: filter to md files, forward to the lane.
   * Registered at layout-ready (Option A) — see onload. The lane
   * stats at observation time (mtime/bytes/sha frozen then, even if
   * the file changes before flush — stat-drift trap avoided).
   */
  async onVaultCreate(file) {
    if (!(file instanceof import_obsidian.TFile)) return;
    await this.watcherLane.onVaultCreate({
      path: file.path,
      isFolder: false,
      ext: file.extension
    });
  }
  /**
   * Vault delete receipt: filter to md files, forward to the lane.
   * The lane consumes the last-known sha as a tombstone; absent when
   * the path was never observed (pre-watcher file, rename victim).
   * The delete also CANCELS any pending planner modify for the path
   * (tombstone wins — planner ruling 2026-10-28).
   */
  async onVaultDelete(file) {
    if (!(file instanceof import_obsidian.TFile)) return;
    this.plannerLane?.cancelPending(file.path);
    await this.watcherLane.onVaultDelete({
      path: file.path,
      isFolder: false,
      ext: file.extension
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
  async onVaultModify(file) {
    if (!(file instanceof import_obsidian.TFile)) return;
    await this.plannerLane?.onVaultModify({
      path: file.path,
      isFolder: false,
      ext: file.extension
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
  async routeToCreateLane(path, reason) {
    try {
      await this.watcherLane.onVaultCreate({ path, isFolder: false, ext: "md" });
    } catch (err) {
      const detail = `planner routing (${reason}) failed for '${path}': ${err instanceof Error ? err.message : String(err)} \u2014 observation dropped, heal-covered`;
      console.error("[vault-overseer]", detail);
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
  async startWriter(adapter, origin, fromOriginFile) {
    this.originId = origin;
    const startup = await startupChecks(adapter, origin, EVENTS_DIR);
    if (startup.foreignOrigin) {
      const detail = startup.integrity.map((r) => r.detail).join("; ");
      const msg = `Vault Overseer: foreign origin in shard tail for '${origin}' \u2014 writer DISABLED. Fix the origin or the shard, then reload.`;
      console.error("[vault-overseer]", msg, detail);
      new import_obsidian.Notice(msg, 15e3);
      this.writerBlocked = true;
      return;
    }
    this.log = new EventLog({
      adapter,
      origin,
      eventsDir: EVENTS_DIR,
      initialSeq: startup.recoveredThroughSeq,
      now: () => defaultLocalIso(),
      hasTornTail: startup.tornTail
    });
    if (!fromOriginFile) {
      await this.log.reportIntegrity(
        `origin.migrated-interim: origin.txt created with id='${origin}' via human certification (settings surface)`
      );
    }
    if (this.scrubbedLegacyOrigin !== null) {
      await this.log.reportIntegrity(
        `settings.changed-interim: keys=[origin], scrubbed_from_data_json='${this.scrubbedLegacyOrigin}' \u2014 field is dead in 0.1.1+, never read`
      );
      this.scrubbedLegacyOrigin = null;
    }
    let chainDetail = null;
    try {
      const chain = await verifyChain(adapter, `${EVENTS_DIR}/${origin}.jsonl`, origin);
      if (!chain.valid) {
        chainDetail = chain.detail ?? "unknown chain failure";
      }
    } catch (err) {
      chainDetail = `chain verification threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (chainDetail !== null) {
      this.chainBroken = true;
      console.error("[vault-overseer] chain verification FAILED:", chainDetail);
      new import_obsidian.Notice(
        `Vault Overseer: checkpoint chain verification FAILED for '${origin}' \u2014 shard integrity is compromised. Details recorded in the event log.`,
        15e3
      );
      await this.log.reportIntegrity(`chain verification failed: ${chainDetail}`);
    }
    if (startup.integrity.length > 0) {
      await this.log.reportIntegrity(
        startup.integrity.map((r) => r.detail).join("; ")
      );
    }
    const settingsSha = await sha256Hex(JSON.stringify(this.settings));
    await this.log.reportIntegrity(
      `session.opened-interim: plugin_versions=vault-overseer-index@${this.manifest.version}, settings_sha=${settingsSha}`
    );
    try {
      await healScan(this.log, adapter, EVENTS_DIR);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[vault-overseer] heal scan threw:", detail);
      await this.log.reportIntegrity(`heal scan threw: ${detail}`);
    }
    await this.watcherLane.flushAfterAttach();
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
  onunload() {
    const farewells = this.dwellGate.sessionEnd();
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
  /**
   * Rung 4 enforcement + shared-knob load. The legacy `origin` field,
   * if ferried in by Sync, is scrubbed from disk immediately —
   * whatever data.json wins the sync race, it cannot lie about
   * identity because nobody ever reads the field again.
   */
  async loadSettings() {
    const persisted = await this.loadData();
    if (persisted !== null && "origin" in persisted) {
      this.scrubbedLegacyOrigin = typeof persisted.origin === "string" ? persisted.origin : null;
      delete persisted.origin;
      await this.saveData(persisted);
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, persisted ?? {});
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
  async certifyOrigin(origin) {
    const trimmed = origin.trim();
    if (trimmed.length === 0) return;
    if (this.adapter === null) {
      console.error("[vault-overseer] certifyOrigin: adapter not initialized");
      return;
    }
    const pluginFolder = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    await writeOriginFile(this.adapter, pluginFolder, trimmed);
    this.pendingCertification = null;
    await this.startWriter(this.adapter, trimmed, false);
    await this.runReconcileWithVault();
    const settingsApp = this.app;
    settingsApp.setting?.activeTab?.display?.();
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
      "Per-device shard id. Identity lives in origin.txt inside the plugin folder \u2014 sync-excluded, BRAT-proof. Edit that file (or certify below) to change it; the origin setting itself is gone from data.json."
    ).addText(
      (text) => text.setPlaceholder("uncertified").setValue(this.plugin.originId ?? "").setDisabled(true)
    );
    new import_obsidian.Setting(containerEl).setName("Reconcile with vault").setDesc(
      "Backfill first-contact paths into the spine. Safe to click repeatedly \u2014 idempotent: if the spine already knows everything, nothing is emitted. Refuses (loudly) across a seq gap rather than fabricate facts from a truncated scan."
    ).addButton(
      (btn) => btn.setButtonText("Reconcile now").setCta().onClick(async () => {
        const emitted = await this.plugin.runReconcileWithVault();
        if (emitted === 0) {
          new import_obsidian.Notice("Vault Overseer: vault and index agree", 6e3);
        }
      })
    );
    if (this.plugin.pendingCertification !== null) {
      containerEl.createEl("h3", { text: "Certify this machine's identity" });
      containerEl.createEl("p", {
        text: "This machine has no origin.txt \u2014 identity cannot be inferred from synced state or from the OS. Pick which shard this machine writes, or declare a new device id (a virgin install offers only the new-id option). Nothing is appended until this is answered.",
        cls: "mod-info"
      });
      for (const candidate of this.plugin.pendingCertification) {
        new import_obsidian.Setting(containerEl).setName(candidate).setDesc(`Continue writing the existing ${candidate}.jsonl shard.`).addButton(
          (btn) => btn.setButtonText(`Certify as '${candidate}'`).onClick(() => void this.plugin.certifyOrigin(candidate))
        );
      }
      const newIdSetting = new import_obsidian.Setting(containerEl).setName("New device id").setDesc("Start a brand-new shard for a machine not listed above.");
      let newValue = "";
      newIdSetting.addText(
        (text) => text.setPlaceholder("e.g. phone-1").onChange((value) => {
          newValue = value;
          newIdSetting.setTooltip(value);
        })
      );
      newIdSetting.addButton(
        (btn) => btn.setButtonText("Create new origin").onClick(() => {
          if (newValue.trim().length > 0) {
            void this.plugin.certifyOrigin(newValue.trim());
          }
        })
      );
    }
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
