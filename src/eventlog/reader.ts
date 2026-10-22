// =============================================================================
// Vault Overseer — Event Log Reader
// src/eventlog/reader.ts
//
// startupChecks() + mergeScan() — the read side of the spine.
//
//   startupChecks(): torn-tail detection (non-destructive discard + report),
//     foreign-origin guard (shard tail mismatch ⇒ loud rejection), seq
//     priming info for constructing the writer's initialSeq.
//
//   mergeScan(): read all shards, order by (origin, seq) — never by ts —
//     with per-shard seq-contiguity checking that HALTS at gaps and names
//     (origin, expected_seq, got_seq). Never skips, never pads, never
//     fabricates.
//
// Byte discipline: lines are split on raw bytes (0x0A) BEFORE decoding, so
// a torn multi-byte UTF-8 tail never round-trips through a JS string. This
// is F01's mandatory mid-character tear handled faithfully.
//
// The reader does not write. It returns integrity reports; the caller
// (plugin startup wiring, or a fixture) decides how they enter the log.
// =============================================================================

export interface ByteSource {
    /** Raw file bytes, or undefined if the path doesn't exist. */
    readBinary(path: string): Promise<Uint8Array | undefined>;
    /** Names (not paths) directly inside a directory. */
    listDir(path: string): Promise<string[]>;
}

export interface IntegrityReport {
    detail: string;
}

/** A parsed event line — loose by design: foreign/legacy lines pass through. */
export type ParsedLine = Record<string, unknown>;

export interface StartupResult {
    /** Shard file exists on disk. */
    shardExists: boolean;
    /** True ⇒ misconfigured duplicate id: DO NOT construct/start the writer. */
    foreignOrigin: boolean;
    /** True ⇒ last line was torn (no trailing newline). Reported, not repaired. */
    tornTail: boolean;
    /** Highest valid seq found; feed to EventLog as initialSeq. 0 = fresh. */
    recoveredThroughSeq: number;
    /** Reports to write into the log (or assert on in fixtures). */
    integrity: IntegrityReport[];
}

export interface GapReport {
    origin: string;
    expected_seq: number;
    got_seq: number;
}

export interface ScanResult {
    /** Consumed events, ordered by (origin, seq). */
    events: ParsedLine[];
    /** Integrity actions encountered. Silence is disqualifying. */
    integrity: IntegrityReport[];
    /** Gaps that halted a shard's scan. */
    gaps: GapReport[];
}

// -----------------------------------------------------------------------------
// Line splitting — bytes first, decode second
// -----------------------------------------------------------------------------

function splitCompleteLines(bytes: Uint8Array): {
    lines: Uint8Array[];
    torn: Uint8Array | null;
} {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x0a) {
            lines.push(bytes.subarray(start, i));
            start = i + 1;
        }
    }
    const torn = start < bytes.length ? bytes.subarray(start) : null;
    return { lines, torn };
}

function parseLine(raw: Uint8Array): ParsedLine | null {
    try {
        const obj = JSON.parse(Buffer.from(raw).toString('utf-8'));
        return typeof obj === 'object' && obj !== null ? obj : null;
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// startupChecks — per the Event Log Schema's integrity clauses 2 and 4
// -----------------------------------------------------------------------------

export async function startupChecks(
    source: ByteSource,
    origin: string,
    eventsDir: string,
): Promise<StartupResult> {
    const shard = `${eventsDir}/${origin}.jsonl`;
    const bytes = await source.readBinary(shard);
    if (bytes === undefined) {
        // Fresh shard — nothing to check, nothing to report.
        return {
            shardExists: false,
            foreignOrigin: false,
                tornTail: false,
                recoveredThroughSeq: 0,
                integrity: [],
        };
    }

    const integrity: IntegrityReport[] = [];
    const { lines, torn } = splitCompleteLines(bytes);

    // Last parsable complete line: the authority for seq priming and for
    // the foreign-origin guard. A torn fragment cannot testify (judgment
    // call: guard reads the last COMPLETE line, not the torn residue).
    let last: ParsedLine | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
        last = parseLine(lines[i]);
        if (last !== null) break;
    }

    const recoveredThroughSeq =
    last !== null && typeof last.seq === 'number' ? last.seq : 0;

    if (torn !== null) {
        integrity.push({
            detail: `torn tail: (origin: ${origin}, bytes: ${torn.length}, recovered_through: ${recoveredThroughSeq})`,
        });
    }

    if (last !== null && last.origin !== origin) {
        integrity.push({
            detail: `foreign origin in shard tail: (local: ${origin}, shard_tail: ${String(last.origin)}, shard: ${shard}) — writer refused`,
        });
        return {
            shardExists: true,
            foreignOrigin: true,
                tornTail: torn !== null,
                recoveredThroughSeq,
                integrity,
        };
    }

    return {
        shardExists: true,
        foreignOrigin: false,
            tornTail: torn !== null,
            recoveredThroughSeq,
            integrity,
    };
}

// -----------------------------------------------------------------------------
// mergeScan — order by (origin, seq); halt at gaps; report everything
// -----------------------------------------------------------------------------

export async function mergeScan(
    source: ByteSource,
    eventsDir: string,
): Promise<ScanResult> {
    const names = await source.listDir(eventsDir);
    const shards = names.filter((n) => n.endsWith('.jsonl')).sort();
    const originOrder = new Map<string, number>();
    shards.forEach((n, i) => originOrder.set(n.replace(/\.jsonl$/, ''), i));

    const events: ParsedLine[] = [];
    const integrity: IntegrityReport[] = [];
    const gaps: GapReport[] = [];

    for (const name of shards) {
        const origin = name.replace(/\.jsonl$/, '');
        const bytes = await source.readBinary(`${eventsDir}/${name}`);
        if (bytes === undefined) continue;

        const { lines, torn } = splitCompleteLines(bytes);

        if (torn !== null) {
            // Discard and report — non-destructive. The bytes stay on disk.
            integrity.push({
                detail: `torn tail: (origin: ${origin}, bytes: ${torn.length})`,
            });
        }

        let expected = 1; // v1: contiguity starts at 1. Compaction is future policy.
        for (const raw of lines) {
            const line = parseLine(raw);
            if (line === null) {
                // Complete-but-unparsable line: skipped LOUDLY (R5).
                integrity.push({
                    detail: `unreadable line: (origin: ${origin}, expected_seq: ${expected})`,
                });
                continue;
            }
            const seq = typeof line.seq === 'number' ? line.seq : -1;
            if (seq !== expected) {
                // Gap: HALT this shard. Never skip, never pad, never fabricate.
                gaps.push({ origin, expected_seq: expected, got_seq: seq });
                integrity.push({
                    detail: `gap: (origin: ${origin}, expected_seq: ${expected}, got_seq: ${seq})`,
                });
                break;
            }
            events.push(line);
            expected++;
        }
    }

    // Order by (origin, seq) — origin by shard-name sort, then seq ascending.
    // ts is never consulted for ordering (clock skew is real).
    events.sort((a, b) => {
        const oa = originOrder.get(String(a.origin)) ?? 999;
        const ob = originOrder.get(String(b.origin)) ?? 999;
        if (oa !== ob) return oa - ob;
        return (
            (typeof a.seq === 'number' ? a.seq : 0) -
            (typeof b.seq === 'number' ? b.seq : 0)
        );
    });

    return { events, integrity, gaps };
}
