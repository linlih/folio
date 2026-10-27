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

export interface JournalDay {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** One line per block; tabs mark outline depth. */
  text: string;
  updatedAt: number;
}

export interface Backlink {
  cardId: string;
  cardTitle: string;
  cardKind: string;
  bid: string;
  text: string;
  /** "link" ([[card]]), "ref" (((block)) of the card), "mention" (unlinked) or "tag" (a tag page). */
  via: "link" | "ref" | "mention" | "tag";
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
  errorKind: "network" | "unauthorized" | "removed" | "other" | null;
}

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
