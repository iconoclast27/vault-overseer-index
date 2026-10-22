// =============================================================================
// Vault Overseer — Checkpoint Digest Machinery
// src/eventlog/checkpoint.ts
// Generated: 2026-10-22T12:30:00+01:00
//
// Contract (Schema v0.2, Integrity Clause 3):
//   - Rolling digest over lines 1..last_seq (inclusive, bytes+newline).
//   - Genesis: sha256(label + origin).
//   - Step: sha256(prev_digest_bytes + 0x00 + line_bytes_including_newline).
//   - Coverage invariant: checkpoint at seq S covers 1..S−1.
//   - Positional witness: the checkpoint's last_seq must equal the highest
//     DATA seq (non-checkpoint) IMMEDIATELY PRECEDING it — not the shard's
//     overall max, which the checkpoint's own seq would mask.
//
// 2026-10-22 FIX: computeChain() now excludes `log.checkpoint` lines from
// `lastSeq` tracking, matching verifyChain()'s `dataMax` semantics. This
// prevents false-positive coverage violations when checkpoints fire
// back-to-back with zero data between them.
//
// Design choice: per-line chaining, precision over speed at single-digit
// MB/year. A corrupted byte anywhere in the covered range breaks the chain.
//
// Honest limitation (documented): a tail drop consuming the checkpoint
// line itself has no single-file witness; that detection is cross-machine
// (received-vs-sent), deferred deliberately.
// =============================================================================

import { createHash } from 'node:crypto';

/** Label prefix for genesis derivation — versioned to allow future migration. */
const CHECKPOINT_LABEL = 'vault-overseer-checkpoint-v1:';

/** Convert hex string (sha256 output) to Uint8Array for the rolling chain step. */
function hexToBytes(hex: string): Uint8Array {
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Derive the initial chain seed from the origin id. */
export function genesisDigest(origin: string): string {
    return createHash('sha256')
    .update(`${CHECKPOINT_LABEL}${origin}`)
    .digest('hex');
}

/**
 * Incremental chain update. Returns the new digest hex string.
 * prevDigestHex: the previous chain value (hex).
 * lineBytes: the raw bytes of the JSONL line INCLUDING the trailing newline.
 */
export function stepDigest(prevDigestHex: string, lineBytes: Uint8Array): string {
    const prevBytes = hexToBytes(prevDigestHex);
    const hasher = createHash('sha256');
    hasher.update(prevBytes);
    hasher.update(Buffer.from([0x00])); // separator
    hasher.update(lineBytes);
    return hasher.digest('hex');
}

/**
 * Verification result for a shard.
 */
export interface ChainVerification {
    valid: boolean;
    /** Last checkpoint's claimed last_seq (if one exists). */
    lastClaimedSeq?: number;
    /** Actual max seq in the shard (contiguous or not). */
    shardMaxSeq?: number;
    /** If invalid, the detail message. */
    detail?: string;
}

// -----------------------------------------------------------------------------
// Walk helpers — the single source of truth for chain stepping
// -----------------------------------------------------------------------------

/**
 * Split bytes into complete lines, EACH INCLUDING its trailing 0x0A.
 * Trailing bytes without a newline are a torn tail — excluded (F01's
 * lane, and the step contract's line bytes include the terminator).
 */
function completeLinesWithNewline(bytes: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x0a) {
            lines.push(bytes.subarray(start, i + 1));
            start = i + 1;
        }
    }
    return lines;
}

export interface ChainState {
    /** Digest over all complete lines in `bytes`. */
    chain: string;
    /** Highest DATA seq among parsable lines (excluding checkpoints). 0 if none. */
    lastSeq: number;
}

/**
 * Straight walk: recompute the digest chain over a shard's complete
 * lines from genesis. Shared by the writer (checkpoint emission) and
 * the verifier — one implementation, no drift.
 *
 * 2026-10-22 FIX: `lastSeq` now EXCLUDES `log.checkpoint` lines, matching
 * verifyChain()'s `dataMax` semantics. This prevents false-positive
 * coverage violations when checkpoints fire back-to-back.
 */
export function computeChain(bytes: Uint8Array, origin: string): ChainState {
    let chain = genesisDigest(origin);
    let lastSeq = 0;
    for (const raw of completeLinesWithNewline(bytes)) {
        try {
            const json = JSON.parse(Buffer.from(raw).toString('utf-8')) as Record<string, unknown>;
            const seq = typeof json.seq === 'number' ? json.seq : 0;
            // Exclude checkpoints from lastSeq — only track DATA lines
            const isCheckpoint = json.type === 'log.checkpoint';
            if (!isCheckpoint && seq > lastSeq) lastSeq = seq;
        } catch { /* unparsable lines still advance the chain */ }
        chain = stepDigest(chain, raw);
    }
    return { chain, lastSeq };
}

/**
 * Walk the shard, recomputing the chain, comparing against every
 * log.checkpoint event encountered — digest AND positional coverage.
 */
export async function verifyChain(
    source: { readBinary(path: string): Promise<Uint8Array | undefined>; },
                                  shardPath: string,
                                  origin: string,
): Promise<ChainVerification> {
    const bytes = await source.readBinary(shardPath);
    if (bytes === undefined) {
        return { valid: true };
    }

    let chain = genesisDigest(origin);
    let maxSeq = 0;
    /** Highest DATA seq among NON-checkpoint lines seen so far — the coverage witness. */
    let dataMax = 0;
    let lastClaim: { last_seq: number } | null = null;

    for (const raw of completeLinesWithNewline(bytes)) {
        let json: Record<string, unknown> | null = null;
        try {
            json = JSON.parse(Buffer.from(raw).toString('utf-8'));
        } catch { /* garbage in, garbage out — the chain still advances */ }
        const seq = json !== null && typeof json.seq === 'number' ? json.seq : 0;
        if (seq > maxSeq) maxSeq = seq;

        if (json !== null && json.type === 'log.checkpoint') {
            lastClaim = { last_seq: Number(json.last_seq) };
            // Chain first: a checkpoint at seq S carries the chain over 1..S-1.
            if (chain !== String(json.digest)) {
                return {
                    valid: false,
                    lastClaimedSeq: Number(json.last_seq),
                    shardMaxSeq: maxSeq,
                    detail: `checkpoint digest mismatch at seq ${seq}: ` +
                    `(origin: ${origin}, claimed ${String(json.digest).slice(0, 16)}…, ` +
                    `recomputed ${chain.slice(0, 16)}…)`,
                };
            }
            // Coverage witness, POSITIONAL: the claim must match the data
            // max seq immediately preceding this line — not the shard's
            // overall max (the checkpoint's own seq would mask the drop).
            if (dataMax !== Number(json.last_seq)) {
                return {
                    valid: false,
                    lastClaimedSeq: Number(json.last_seq),
                    shardMaxSeq: maxSeq,
                    detail: `checkpoint coverage violation at seq ${seq}: ` +
                    `claims last_seq ${Number(json.last_seq)}, ` +
                    `preceding data reaches ${dataMax} — ` +
                    `${dataMax < Number(json.last_seq)
                        ? 'covered lines vanished (sync drop / truncation)'
                        : 'checkpoint precedes history it claims (hostile merge)'}`,
                };
            }
        } else if (seq > dataMax) {
            dataMax = seq;
        }

        chain = stepDigest(chain, raw);
    }

    return { valid: true, lastClaimedSeq: lastClaim?.last_seq, shardMaxSeq: maxSeq };
}
