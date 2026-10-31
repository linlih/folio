// A card's earlier versions (design/ARCHITECTURE.md §5.4): every edit stays
// in its document (compaction keeps whole history, §5.3), so a version is
// the state after some of them. Restoring writes the difference as one new
// edit: it syncs like any edit and Mod+Z undoes it.

import { VersionVector, type LoroDoc, type OpId, type PeerID } from "loro-crdt";
import type { DocHandle } from "./hub";
import { RESTORE_ORIGIN } from "./restore";

/** Edits closer together than this, on one device, are one version (a
 *  sitting). */
const SITTING_MS = 10 * 60_000;

export interface Version {
  /** Where to read it, or revert to it. */
  frontiers: OpId[];
  /** Its last edit's time (ms); null for edits made before times were kept. */
  at: number | null;
  /** Whether this device made its edits (otherwise another one did). */
  here: boolean;
  /** Edits it is made of (Loro changes). */
  changes: number;
}

/** Changes are dated from now on (Loro keeps no time unless asked). Set on
 *  every document this device edits; older edits stay undated. */
export function recordTimes(doc: LoroDoc) {
  doc.setRecordTimestamp(true);
}

/** The document's versions, newest first. The edits are taken in causal
 *  order (lamport, then peer), so the edits up to any point are a version
 *  some device could have seen; a version ends where the next edit comes
 *  more than a sitting later or from another device. The newest is the
 *  current state. `devicePeers`: this device's peer ids (the store's, the
 *  editor's and the API replica's, `appInfo`). */
export function versions(doc: LoroDoc, devicePeers: ReadonlySet<string> = new Set([doc.peerIdStr])): Version[] {
  const all = [...doc.getAllChanges().values()].flat();
  all.sort((a, b) => a.lamport - b.lamport || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0));
  const vv = new Map<PeerID, number>();
  const out: Version[] = [];
  // This device's peers are one author; each other peer is another.
  const author = (peer: PeerID) => (devicePeers.has(peer) ? "here" : peer);
  let open: { at: number | null; here: boolean; changes: number; author: string } | null = null;
  const close = () => {
    if (!open) return;
    const { at, here, changes } = open;
    out.push({ frontiers: doc.vvToFrontiers(new VersionVector(new Map(vv))), at, here, changes });
    open = null;
  };
  for (const c of all) {
    const at = c.timestamp > 0 ? c.timestamp * 1000 : null;
    if (open && (open.author !== author(c.peer) || (at !== null && open.at !== null && at - open.at > SITTING_MS))) close();
    vv.set(c.peer, Math.max(vv.get(c.peer) ?? 0, c.counter + c.length));
    open = open ?? { at: null, here: false, changes: 0, author: author(c.peer) };
    if (at !== null) open.at = Math.max(open.at ?? 0, at);
    open.here ||= devicePeers.has(c.peer);
    open.changes++;
  }
  close();
  return out.reverse();
}

/** A copy of the document as it was at `frontiers`, to look at. */
export function versionDoc(doc: LoroDoc, frontiers: OpId[]): LoroDoc {
  return doc.forkAt(frontiers);
}

/** Makes `handle`'s document what it was at `frontiers`, as one new edit. */
export function restoreTo(handle: DocHandle, frontiers: OpId[]) {
  const { doc } = handle;
  doc.setNextCommitOrigin(RESTORE_ORIGIN);
  doc.revertTo(frontiers);
  doc.commit({ origin: RESTORE_ORIGIN });
}
