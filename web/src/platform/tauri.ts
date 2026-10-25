import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, BackupInfo, Backlink, BlockText, CardRow, JournalDay, McpStatus, SearchHit, SyncStatus, TagInfo, TopicCount, CardText } from "../bindings/commands";
import type { Backend, ExportResult } from "./backend";
import type { LatestRelease, LibraryLocation, PickedFolder } from "../bindings/commands";

export function tauriBackend(): Backend {
  return {
    kind: "tauri",
    appInfo: () => invoke<AppInfo>("app_info"),
    listCards: (limit) => invoke<CardRow[]>("list_cards", { limit }),
    createCard: (title) => invoke<string>("create_card", { title }),
    docSnapshot: async (id) => {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>("doc_snapshot", { id }));
      // Empty means "does not exist yet"; a Loro snapshot is never empty.
      return bytes.byteLength === 0 ? null : bytes;
    },
    // Raw body plus headers: no JSON number array for binary data (§7.1).
    applyUpdate: (id, kind, bytes) =>
      invoke<void>("apply_update", bytes, { headers: { "x-doc-id": id, "x-doc-kind": kind } }),
    trashCard: (id) => invoke<void>("trash_card", { id }),
    restoreCard: (id) => invoke<void>("restore_card", { id }),
    listTrash: (limit) => invoke<CardRow[]>("list_trash", { limit }),
    journalDays: (from, to) => invoke<JournalDay[]>("journal_days", { from, to }),
    backlinks: (id) => invoke<Backlink[]>("backlinks", { id }),
    unlinkedReferences: (id, limit) => invoke<Backlink[]>("unlinked_references", { id, limit }),
    search: (query, limit) => invoke<SearchHit[]>("search", { query, limit }),
    blockTexts: (bids) => invoke<BlockText[]>("block_texts", { bids }),
    titles: (ids) => invoke<[string, string][]>("titles", { ids }),
    getLocalSetting: <T,>(key: string) => invoke<T | null>("get_local_setting", { key }),
    setLocalSetting: (key, value) => invoke<void>("set_local_setting", { key, value }),
    exportDiagnostics: () => invoke<string>("export_diagnostics"),
    exportMarkdown: (folderName, untitled) => invoke<ExportResult | null>("export_markdown", { folderName, untitled }),
    tags: (limit) => invoke<TagInfo[]>("tags", { limit }),
    topicCards: (topic) => invoke<CardRow[]>("topic_cards", { topic }),
    topicCounts: () => invoke<TopicCount[]>("topic_counts"),
    cardTexts: (ids) => invoke<CardText[]>("card_texts", { ids }),
    cardTopicPairs: () => invoke<[string, string][]>("card_topic_pairs"),
    tagged: (tag, limit) => invoke<Backlink[]>("tagged", { tag, limit }),
    cardMarkdown: (id) => invoke<string>("card_markdown", { id }),
    exportCard: (id, fileName) => invoke<string | null>("export_card", { id, fileName }),
    saveTextFile: (fileName, content) => invoke<string | null>("save_canvas", { fileName, content }),
    pinCard: (id, pinned) => invoke<void>("pin_card", { id, pinned }),
    pinnedCards: () => invoke<CardRow[]>("pinned_cards"),
    listBackups: () => invoke<BackupInfo[]>("list_backups"),
    backupNow: () => invoke<BackupInfo>("backup_now"),
    restoreLibrary: (backup) => invoke<void>("restore_library", { backup }),
    revealBackups: () => invoke<void>("reveal_backups"),
    libraryLocation: () => invoke<LibraryLocation>("library_location"),
    pickLibraryFolder: (purpose) => invoke<PickedFolder | null>("pick_library_folder", { purpose }),
    moveLibrary: (to) => invoke<string>("move_library", { to }),
    openLibrary: (path) => invoke<string>("open_library", { path }),
    revealLibrary: () => invoke<void>("reveal_library"),
    latestRelease: () => invoke<LatestRelease>("latest_release"),
    openReleaseDownload: (url) => invoke<void>("open_release_download", { url }),
    mcpStatus: () => invoke<McpStatus>("mcp_status"),
    setMcpEnabled: (enabled) => invoke<McpStatus>("set_mcp_enabled", { enabled }),
    regenerateMcpToken: () => invoke<McpStatus>("regenerate_mcp_token"),
    revokeMcpClient: (client) => invoke<McpStatus>("revoke_mcp_client", { client }),
    answerMcpApproval: (id, allow) => invoke<void>("answer_mcp_approval", { id, allow }),
    syncStatus: () => invoke<SyncStatus>("sync_status"),
    syncCreate: (server, token, passphrase) => invoke<SyncStatus>("sync_create", { server, token, passphrase }),
    syncJoin: (code, passphrase) => invoke<SyncStatus>("sync_join", { code, passphrase }),
    syncNow: () => invoke<void>("sync_now"),
    syncDisable: () => invoke<SyncStatus>("sync_disable"),
  };
}
