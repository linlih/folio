// Types of the Tauri commands in src-tauri/src/lib.rs, written by hand for now.
// tauri-specta is still a release candidate; switch to generated bindings once
// it is stable (design/ARCHITECTURE.md §7). Keep this file in step with Rust.

/** Where the library is (§5.7). */
export interface LibraryLocation {
  path: string;
  isDefault: boolean;
  /** FOLIO_DATA_DIR chose it; it cannot be changed in the app. */
  fixed: boolean;
  cloudSynced: boolean;
  /** A chosen library that was not found at start. */
  missing: string | null;
  defaultPath: string | null;
}

/** A folder picked to move the library to or open a library from. */
export interface PickedFolder {
  path: string;
  kind: "library" | "empty" | "other";
  cloudSynced: boolean;
  /** For a move: where the library would go. */
  target: string | null;
  problem: "same" | "intoItself" | "occupied" | "notEmpty" | null;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  /** u64 as a decimal string: it does not fit a JavaScript number. */
  frontendPeer: string;
  /** Peer id of the API replica (web/src/api). */
  apiPeer: string;
  /** Rust's own peer id; with the two above, every edit this device makes. */
  storePeer: string;
  /** "macos", "windows", "linux", "android" or "ios" ("web" in a browser). */
  platform: string;
}

/** The newest release as latest.json describes it (phones). */
export interface LatestRelease {
  version: string;
  notes: string;
  date: string | null;
  apk: string;
}

export type DocKind = "workspace" | "card" | "board";

export interface CardRow {
  id: string;
  kind: string;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number;
}

/** A link clipped into the inbox (folio_core::card::Clip). */
export interface ClipInfo {
  url: string;
  site: string;
  excerpt: string;
  author: string;
}

/** What a link's page says of itself; `fetched` false: the page could not
 *  be read and this is the bare link. */
export interface LinkPreview extends ClipInfo {
  title: string;
  fetched: boolean;
}

export interface InboxItem {
  id: string;
  title: string;
  /** The notes on it, or the page's summary. */
  preview: string;
  clip: ClipInfo | null;
  inboxAt: number;
  updatedAt: number;
}

/** A row of a tag's database. */
export interface TagCard {
  id: string;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number;
  /** Field values by field id, a JSON object. */
  props: string;
  url: string | null;
}

export interface JournalDay {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** One line per block; tabs mark outline depth. */
  text: string;
  /** The same lines with their links and tags. */
  lines: DayLine[];
  updatedAt: number;
}

/** A line of a journal day as the read-only view draws it. */
export interface DayLine {
  /** Outline depth; left out when 0. */
  depth?: number;
  parts: DayPart[];
}

/** Text, or a card link (`card`, with the title it was made with), a block
 *  reference (`block`), a #tag (`tag`) or text linked to a web address. */
export interface DayPart {
  /** Left out when empty. */
  text?: string;
  card?: string;
  block?: string;
  tag?: string;
  href?: string;
}

export interface Backlink {
  cardId: string;
  cardTitle: string;
  cardKind: string;
  bid: string;
  text: string;
  /** "link" ([[card]]), "ref" (((block)) of the card), "mention" (unlinked) or "tag" (a tag page). */
  via: "link" | "ref" | "mention" | "tag";
  /** The blocks nested under it, in document order (tag pages only). */
  children?: ChildBlock[];
}

/** A block nested under another; `depth` 1 is directly under it. */
export interface ChildBlock {
  bid: string;
  depth: number;
  text: string;
}

export interface SearchHit {
  cardId: string;
  cardTitle: string;
  cardKind: string;
  /** null for a match on the card's title. */
  bid: string | null;
  text: string;
}

export interface BlockText {
  bid: string;
  cardId: string;
  text: string;
}

/** A local backup of the library (§5.4). */
export interface BackupInfo {
  /** File name; also the backup's id. */
  name: string;
  createdAt: number;
  size: number;
  /** Made automatically before the library was replaced or rewritten. */
  safety: boolean;
  /** Why: "restore" or "upgrade" (a new storage layout). */
  reason: string | null;
}


/** The MCP server for AI tools (§0.3). */
export interface McpStatus {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  /** Approved clients, by name. */
  clients: string[];
  error: string | null;
}

/** Sync on this device (src-tauri/src/sync.rs). */
export interface SyncStatus {
  enabled: boolean;
  server: string;
  device: string;
  /** For another device to join, with the passphrase. */
  code: string;
  syncing: boolean;
  /** The live channel is connected. */
  live: boolean;
  lastSync: number | null;
  /** Local changes not yet on the server. */
  pending: number;
  error: string | null;
  /** What went wrong, to word it in the interface's language. */
  errorKind: "network" | "unauthorized" | "removed" | "key-missing" | "wrong-passphrase" | "other" | null;
  /** Files waiting to go up; files cards use that are not on this device. */
  filesUp: number;
  filesDown: number;
  /** True on computers (every file is downloaded); phones download what
   *  is looked at. */
  filesAll: boolean;
  /** The sync space's files on the server, in bytes. */
  serverFileBytes: number | null;
  /** The last file transfer that failed. */
  filesError: string | null;
  filesErrorKind: "network" | "unauthorized" | "removed" | "too-large" | "server-full" | "other" | null;
}

/** A file asked for arrived, or why it cannot (src-tauri/src/sync.rs). */
export type AssetEvent =
  | { sha256: string; ready: true }
  | { sha256: string; ready: false; reason: "elsewhere" | "damaged" | "offline" | "no-sync" };

/** A device of the sync workspace (src-tauri/src/sync.rs). */
export interface SyncDevice {
  id: string;
  /** Null when it never sent one (or it cannot be opened). */
  name: string | null;
  thisDevice: boolean;
  firstSeen: number;
  /** Its last request to the server. */
  lastSeen: number;
}

/** A #tag in use. */
export interface TagInfo {
  /** Lower case: what tags are matched by. */
  key: string;
  /** As most recently written. */
  name: string;
  blocks: number;
  cards: number;
  lastUsed: number | null;
}

/** A card's title and body text for a whiteboard (§4.3). */
export interface CardText {
  id: string;
  title: string;
  /** One line per block; tabs for depth below the outermost list. */
  text: string;
  deleted: boolean;
}

/** A topic's number of cards (§4.7). */
export interface TopicCount {
  id: string;
  cards: number;
}

/** A file added to the library (folio_store::AssetInfo). */
export interface AssetInfo {
  sha256: string;
  name: string;
  mime: string;
  size: number;
}
