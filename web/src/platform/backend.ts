import type { AssetEvent, AssetInfo, BackupInfo, McpStatus, SyncDevice, SyncStatus, TagInfo, TopicCount, CardText } from "../bindings/commands";
import type { LatestRelease, LibraryLocation, PickedFolder } from "../bindings/commands";
import type { AppInfo, Backlink, BlockText, CardRow, DocKind, JournalDay, SearchHit } from "../bindings/commands";

/** Everything the UI may ask of the host. The Tauri app and web mode each
 *  implement it; UI code never imports `@tauri-apps/api` directly. */
export interface Backend {
  readonly kind: "tauri" | "memory";
  appInfo(): Promise<AppInfo>;
  listCards(limit?: number): Promise<CardRow[]>;
  /** Creates an empty note on the host and returns its id. */
  createCard(title: string): Promise<string>;
  /** The document as a Loro snapshot; null when it was never written (an
   *  untouched journal day). */
  docSnapshot(id: string): Promise<Uint8Array | null>;
  /** A Loro update made by this device's frontend replica. Creates the
   *  document if it does not exist yet. */
  applyUpdate(id: string, kind: DocKind, bytes: Uint8Array): Promise<void>;
  trashCard(id: string): Promise<void>;
  restoreCard(id: string): Promise<void>;
  listTrash(limit?: number): Promise<CardRow[]>;
  /** Pins a card to the sidebar, or unpins it (a card field: it syncs). */
  pinCard(id: string, pinned: boolean): Promise<void>;
  /** Pinned cards not in the trash, in the order they were pinned. */
  pinnedCards(): Promise<CardRow[]>;
  /** Written journal days between two dates (inclusive), newest first. */
  journalDays(from: string, to: string): Promise<JournalDay[]>;
  /** Blocks in other cards that link to this card or reference its blocks. */
  backlinks(id: string): Promise<Backlink[]>;
  /** Blocks in other cards that mention this card's title without a link. */
  unlinkedReferences(id: string, limit?: number): Promise<Backlink[]>;
  /** Cards by title and blocks by text, title matches first. */
  search(query: string, limit?: number): Promise<SearchHit[]>;
  /** Current text of blocks (for block references). */
  blockTexts(bids: string[]): Promise<BlockText[]>;
  /** #tags in use, most recently used first. */
  tags(limit?: number): Promise<TagInfo[]>;
  /** Cards in a topic (§4.7, by id), most recently changed first. */
  topicCards(topic: string): Promise<CardRow[]>;
  /** How many cards each topic has. */
  topicCounts(): Promise<TopicCount[]>;
  /** Titles and body text of cards (trashed ones too). */
  cardTexts(ids: string[]): Promise<CardText[]>;
  /** Every [card, topic] pair (cards not in the trash). */
  cardTopicPairs(): Promise<[string, string][]>;
  /** Blocks with a tag (any case), newest cards first; `via` is "tag". */
  tagged(tag: string, limit?: number): Promise<Backlink[]>;
  /** Current titles of cards (card links show them). */
  titles(ids: string[]): Promise<[string, string][]>;
  /** Settings that stay on this device (§4.4 `local_settings`). */
  getLocalSetting<T>(key: string): Promise<T | null>;
  setLocalSetting(key: string, value: unknown): Promise<void>;
  /** Writes a diagnostics file and returns its path; null where unsupported. */
  exportDiagnostics(): Promise<string | null>;
  /** Asks for a folder and exports every card as Markdown into a new
   *  subfolder `folderName`; null when cancelled or unsupported. */
  exportMarkdown(folderName: string, untitled: string): Promise<ExportResult | null>;
  /** One card as Markdown with its title as a heading; null where unsupported. */
  cardMarkdown(id: string): Promise<string | null>;
  /** Saves one card as a Markdown file (asks where); the path, or null. */
  exportCard(id: string, fileName: string): Promise<string | null>;
  /** Saves a whiteboard as a .canvas file (asks where); the path, or null. */
  saveTextFile(fileName: string, content: string): Promise<string | null>;
  /** Local backups, newest first (§5.4). */
  listBackups(): Promise<BackupInfo[]>;
  backupNow(): Promise<BackupInfo>;
  /** Replaces the whole library with a backup (the page must reload after). */
  restoreLibrary(backup: string): Promise<void>;
  revealBackups(): Promise<void>;
  /** The library folder (§5.7): where it is, moving it, opening another.
   *  Moving and opening swap the open library; the window reloads after. */
  libraryLocation(): Promise<LibraryLocation>;
  pickLibraryFolder(purpose: "move" | "open"): Promise<PickedFolder | null>;
  moveLibrary(to: string): Promise<string>;
  openLibrary(path: string): Promise<string>;
  revealLibrary(): Promise<void>;
  /** Updates on phones (desktop uses the updater plugin): the newest
   *  release, and opening its download. */
  latestRelease(): Promise<LatestRelease>;
  openReleaseDownload(url: string): Promise<void>;
  /** The theme of the phone's system bars and keyboard: "system", "light" or "dark". */
  setAppearance(theme: string): Promise<void>;
  /** The read-only MCP server for AI tools (§0.3); desktop only. */
  mcpStatus(): Promise<McpStatus | null>;
  setMcpEnabled(enabled: boolean): Promise<McpStatus>;
  regenerateMcpToken(): Promise<McpStatus>;
  revokeMcpClient(client: string): Promise<McpStatus>;
  answerMcpApproval(id: string, allow: boolean): Promise<void>;
  /** Sync with the self-hosted server (§5.3); null where unsupported. */
  syncStatus(): Promise<SyncStatus | null>;
  /** The first device: creates the workspace on the server. */
  syncCreate(server: string, token: string, passphrase: string): Promise<SyncStatus>;
  /** Another device: joins with the sync code and passphrase. */
  syncJoin(code: string, passphrase: string): Promise<SyncStatus>;
  syncNow(): Promise<void>;
  syncDisable(): Promise<SyncStatus>;
  /** The workspace's devices, most recently seen first (asks the server). */
  syncDevices(): Promise<SyncDevice[]>;
  /** Names this device; empty goes back to the system's name. */
  syncRenameDevice(name: string): Promise<SyncDevice[]>;
  /** Removes another device from the workspace. */
  syncRemoveDevice(id: string): Promise<SyncDevice[]>;
  /** Adds a file to the library (design/attachments.md §3); the same
   *  content is stored once. HEIC photos come back as JPEG. */
  addAsset(file: File): Promise<AssetInfo>;
  /** Where the web view reads a file the library holds. */
  assetUrl(sha256: string): string;
  /** Opens a file with the system's app for it. Fails with "[not-here]"
   *  when this device does not have it. */
  openAsset(sha256: string, name: string): Promise<void>;
  /** Which of these files this device has. */
  assetsHere(sha256s: string[]): Promise<string[]>;
  /** Asks for files this device does not have (design/attachments.md §5.4);
   *  each comes as an `onAssetEvent` ready, or not with the reason. */
  fetchAssets(sha256s: string[]): Promise<void>;
  /** Listens for files arriving or found missing; returns the unlisten. */
  onAssetEvent(listener: (e: AssetEvent) => void): () => void;
}

export interface ExportResult {
  dir: string;
  cards: number;
  journals: number;
}
