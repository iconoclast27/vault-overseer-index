// =============================================================================
// Vault Overseer — Test Harness (FakeAdapter + spawnContext)
// vault-overseer-index/src/test-harness.ts
// Generated: 2026-10-22T12:15:00+01:00
//
// Fixture harness per Event Log Fixture Corpus v0.1 (rev. 2026-10-22):
//   - Runs in plain Node. No Obsidian, no vault runtime.
//   - Corruption is injected at the FILE level (hostile bytes on disk),
//     never by mocking EventLog internals.
//   - Two contexts on the same root = a converged vault (F04).
//
// Byte discipline: the in-memory filesystem stores Uint8Array, not strings.
// F01's mandatory multi-byte tear is byte-exact hostility; JS strings
// silently mangle partial UTF-8 into replacement characters. Hostile
// files deserve faithful bytes.
//
// 2026-10-22 fix: SpawnOverrides now forwards `hasTornTail` to the EventLog
// constructor (it was silently dropped, so the '\n'-burial path was
// unreachable from fixtures) and types `checkpointInterval` in settings.
//
// Node note: erasable TypeScript only (type-stripping safe); imports spell
// out .ts extensions. This file never runs inside Obsidian.
// =============================================================================

import type { LogAdapter } from './eventlog/eventlog.ts';
import { EventLog } from './eventlog/eventlog.ts';

export class FakeFileSystem {
    private store = new Map<string, Uint8Array>();

    exists(path: string): boolean {
        return this.store.has(path);
    }

    write(path: string, data: string | Uint8Array): void {
        this.store.set(
            path,
            typeof data === 'string' ? Buffer.from(data, 'utf-8') : data,
        );
    }

    append(path: string, data: string): void {
        const prev = this.store.get(path) ?? Buffer.alloc(0);
        this.store.set(path, Buffer.concat([prev, Buffer.from(data, 'utf-8')]));
    }

    read(path: string): string | undefined {
        const bytes = this.store.get(path);
        return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf-8');
    }

    getBytes(path: string): Uint8Array | undefined {
        return this.store.get(path);
    }

    size(path: string): number {
        return this.store.get(path)?.length ?? 0;
    }

    listDir(dir: string): string[] {
        const names: string[] = [];
        for (const key of this.store.keys()) {
            if (!key.startsWith(dir + '/')) continue;
            const rest = key.slice(dir.length + 1);
            if (!rest.includes('/')) names.push(rest);
        }
        return names.sort();
    }
}

export class FakeAdapter implements LogAdapter {
    private fs: FakeFileSystem;
    private root: string;

    constructor(fs: FakeFileSystem, root: string) {
        this.fs = fs;
        this.root = root;
    }

    private resolve(path: string): string {
        return path.startsWith(this.root) ? path : `${this.root}/${path}`;
    }

    async mkdir(_path: string): Promise<void> {}

    async write(path: string, data: string): Promise<void> {
        this.fs.write(this.resolve(path), data);
    }

    async append(path: string, data: string): Promise<void> {
        this.fs.append(this.resolve(path), data);
    }

    async exists(path: string): Promise<boolean> {
        return this.fs.exists(this.resolve(path));
    }

    async readBinary(path: string): Promise<Uint8Array | undefined> {
        const bytes = this.fs.getBytes(this.resolve(path));
        return bytes === undefined
        ? undefined
        : new Uint8Array(bytes);
    }

    async listDir(path: string): Promise<string[]> {
        return this.fs.listDir(this.resolve(path));
    }
}

export interface SpawnOverrides {
    settings?: {
        tier2FlushCount?: number;
        tier2IdleMs?: number;
        tier2HardCap?: number;
        /** Emit log.checkpoint after this many events since the last. */
        checkpointInterval?: number;
    };
    now?: () => string;
    initialSeq?: number;
    /**
     * TRUE if startupChecks() detected a torn tail. The writer prepends '\n'
     * on the first append so the torn fragment becomes a dead line.
     * (Added 2026-10-22 — previously dropped on the floor, which made the
     * burial path unreachable from fixtures.)
     */
    hasTornTail?: boolean;
    /**
     * Share an existing filesystem across contexts — F03's crash-and-restart
     * needs the fresh context to see the dead one's shard. Omit for a fresh
     * isolated store (F01/F02 behaviour, unchanged).
     */
    fs?: FakeFileSystem;
}

export function spawnContext(
    origin: string,
    root: string,
    overrides?: SpawnOverrides,
): { log: EventLog; adapter: FakeAdapter; fs: FakeFileSystem } {
    const fs = overrides?.fs ?? new FakeFileSystem();
    const adapter = new FakeAdapter(fs, root);
    const log = new EventLog({
        adapter,
        origin,
        initialSeq: overrides?.initialSeq,
        now: overrides?.now,
        settings: overrides?.settings,
        hasTornTail: overrides?.hasTornTail,
    });
    return { log, adapter, fs };
}

export function shardPath(root: string, origin: string): string {
    return `${root}/_vault-index/events/${origin}.jsonl`;
}

export function validLine(
    seq: number,
    type: string,
    payload: Record<string, unknown>,
    origin = 'mokka',
    actor = 'user',
): string {
    return (
        JSON.stringify({
            v: 1,
            seq,
            ts: '2026-10-20T21:04:11+01:00',
            origin,
            actor,
            type,
            ...payload,
        }) + '\n'
    );
}

export function tornTail(tailBytes = 140): Uint8Array {
    const head = Buffer.from(
        '{"v":1,"seq":51,"ts":"2026-10-20T21:04:11+01:00","origin":"mokka","actor":"plugin","type":"chunk.inde',
        'utf-8',
    );
    const cjk = Buffer.from('文'.repeat(256), 'utf-8');
    const raw = Buffer.concat([head, cjk]);

    let n = Math.min(tailBytes, raw.length);
    while (n > head.length && (raw[n - 1] & 0xc0) !== 0x80) {
        n--;
    }
    return raw.subarray(0, n);
}

export function shardWithTornTail(
    validCount = 50,
    tailBytes = 140,
): Uint8Array {
    const lines: string[] = [];
    for (let i = 1; i <= validCount; i++) {
        lines.push(
            validLine(i, 'note.modified', {
                path: `Notes/note-${i}.md`,
                mtime: 1763000000000 + i,
                bytes: 500,
                content_sha: 'e3b0c44219fb1639',
            }),
        );
    }
    return Buffer.concat([
        Buffer.from(lines.join(''), 'utf-8'),
                         tornTail(tailBytes),
    ]);
}
