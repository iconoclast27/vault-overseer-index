// =============================================================================
// Vault Overseer — Spine Projection (live path set)
// src/eventlog/projection.ts
// Created: 2026-10-25
//
// Single-implementation extraction from heal.ts (rev 2026-10-25), per the
// renderEmbedInput precedent: two consumers of the same event-walk would
// drift. Consumers:
//   - healScan (every boot — which paths to re-chunk)
//   - reconcile (first-contact backfill + manual settings button, planned)
//   - the future index's projection seam (Plugin 2)
//
// Semantics (LIVE-SET, subtractive — the fix heal.ts owed):
//   note.created / note.modified   => path is live
//   note.renamed                   => 'from' dies, 'to' is live
//   folder.renamed                 => every path under 'from/' is
//                                     re-addressed under 'to/'
//   note.deleted                   => path dies
//
// The fold is ORDERED (seq order); the caller supplies scan.events in
// spine order. Resurrection is honored by construction: a created path
// that died can re-enter the live set via a later created/modified/
// renamed-to — the set is state, not history.
//
// OUT OF SCOPE (visible, owed):
//   - Restored-file divergence (spine says dead, disk says alive) is
//     reconcile's ruling, not the projection's — the projection only
//     reports spine truth.
//   - chunk coverage maps stay with their consumer until a second
//     consumer exists.
//
// F14 ADDITION (2026-10-30): the folder.renamed prefix-fold lives HERE,
//   inside the ordered fold — not in the subscriber callback. Session
//   ruling 2026-10-30: one implementation serves both the cold-replay
//   path (this fold) and the future incremental subscriber path (which
//   replays the same case against its live set). Splitting them would
//   recreate the two-drifting-copies defect the renderEmbedInput
//   precedent exists to prevent.
//
//   Boundary discipline mirrors gate.renamePrefix exactly: matching is
//   prefix + '/' (so 'Area' never captures 'Area 2/x'), and the
//   destination is normalized of trailing slashes before concatenation.
//   A folder rename re-addresses its whole subtree at once with no
//   collisions — the vault guarantees disjoint new paths.
//
//   ORDERING NOTE: this case is order-sensitive in the same way
//   note.renamed is. A folder.renamed followed by a later note.created
//   at the new address is fine (the create is a fresh fact); a
//   folder.renamed that arrives BEFORE the creates of the paths it
//   covers simply folds nothing for those paths, and the later creates
//   land them live under their real (post-rename) addresses. The fold
//   reports spine truth in spine order, nothing more.
//
// Node note: erasable TypeScript only; imports spell out .ts extensions.
// =============================================================================

import type { ParsedLine } from './reader.ts';

export interface PathProjection {
    /** Paths the spine declares LIVE after the full ordered fold. */
    livePaths: Set<string>;
    /** Paths that lived and died — autopsy count, for receipts. */
    deadPaths: Set<string>;
}

/**
 * Normalize a folder path for prefix matching: strip trailing slashes and
 * append exactly one. 'Projects/A' and 'Projects/A/' both yield
 * 'Projects/A/'. Mirrors gate.renamePrefix's boundary discipline.
 */
function asPrefix(folder: string): string {
    return folder.replace(/\/+$/, '') + '/';
}

/**
 * Re-address one path from `fromPrefix` to `toPrefix`, or return null if
 * the path does not live under the prefix. Boundary-matched: 'Area/' never
 * captures 'Area 2/x'.
 */
function reAddress(path: string, fromPrefix: string, toPrefix: string): string | null {
    if (!path.startsWith(fromPrefix)) return null;
    return toPrefix + path.slice(fromPrefix.length);
}

/**
 * Ordered fold over spine events producing the live path set.
 * Unknown event types are ignored (forward-compat: foreign types must
 * not crash the projection; heal's own refusal lane polices gaps).
 */
export function projectPaths(events: ParsedLine[]): PathProjection {
    const livePaths = new Set<string>();
    const deadPaths = new Set<string>();

    for (const e of events) {
        const t = String(e.type);
        if (t === 'note.created' || t === 'note.modified') {
            if (typeof e.path === 'string') {
                livePaths.add(e.path);
                deadPaths.delete(e.path); // resurrection
            }
        } else if (t === 'note.renamed') {
            if (typeof e.from === 'string') {
                livePaths.delete(e.from);
                deadPaths.add(e.from);
            }
            if (typeof e.to === 'string') {
                livePaths.add(e.to);
                deadPaths.delete(e.to); // destination is born live
            }
        } else if (t === 'folder.renamed') {
            // Mass re-addressing: every live path under from/ moves to
            // to/. One event, N paths re-addressed — the O(1)-to-record
            // fact resolving to its consequences here, at fold time.
            //
            // Snapshot the live set before mutating: we cannot iterate a
            // Set while adding to it. Deterministic order (insertion) is
            // irrelevant to the result — the mapping is a bijection on
            // the matched subset.
            if (typeof e.from === 'string' && typeof e.to === 'string') {
                const fromPrefix = asPrefix(e.from);
                const toPrefix = asPrefix(e.to);
                for (const path of [...livePaths]) {
                    const moved = reAddress(path, fromPrefix, toPrefix);
                    if (moved === null) continue;
                    livePaths.delete(path);
                    livePaths.add(moved);
                    deadPaths.delete(moved); // destination is born live
                }
                // Dead paths under the old prefix keep their old addresses:
                // history is not rewritten (append-only doctrine). A dead
                // path's tombstone names where it died, and that is the
                // truth the spine owes.
            }
        } else if (t === 'note.deleted') {
            if (typeof e.path === 'string') {
                livePaths.delete(e.path);
                deadPaths.add(e.path);
            }
        }
    }

    return { livePaths, deadPaths };
}
