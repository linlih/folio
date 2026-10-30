import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AppInfo, AssetInfo, BackupInfo, Backlink, BlockText, CardRow, JournalDay, McpStatus, SearchHit, SyncDevice, SyncStatus, TagInfo, TopicCount, CardText } from "../bindings/commands";
import type { Backend, ExportResult } from "./backend";
import type { LatestRelease, LibraryLocation, PickedFolder } from "../bindings/commands";
import type { InboxItem, LinkPreview, TagCard } from "../bindings/commands";

const ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

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
    // Android has no raw IPC body: Tauri sends JSON there, where a plain
    // array is half the size of a Uint8Array's JSON object.
    applyUpdate: (id, kind, bytes) =>
      invoke<void>("apply_update", ANDROID ? Array.from(bytes) : bytes, { headers: { "x-doc-id": id, "x-doc-kind": kind } }),
    trashCard: (id) => invoke<void>("trash_card", { id }),
    restoreCard: (id) => invoke<void>("restore_card", { id }),
    listTrash: (limit) => invoke<CardRow[]>("list_trash", { limit }),
    emptyTrash: () => invoke<string[]>("empty_trash"),
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
    downloadUpdate: (url, onProgress) => {
      const progress = new Channel<number>();
      progress.onmessage = onProgress;
      return invoke<string>("download_update", { url, progress });
    },
    installUpdate: (path) => invoke<boolean>("install_update", { path }),
    openReleaseDownload: (url) => invoke<void>("open_release_download", { url }),
    setAppearance: (theme) => invoke<void>("set_appearance", { theme }),
    mcpStatus: () => invoke<McpStatus>("mcp_status"),
    setMcpEnabled: (enabled) => invoke<McpStatus>("set_mcp_enabled", { enabled }),
    regenerateMcpToken: () => invoke<McpStatus>("regenerate_mcp_token"),
    revokeMcpClient: (client) => invoke<McpStatus>("revoke_mcp_client", { client }),
    answerMcpApproval: (id, allow) => invoke<void>("answer_mcp_approval", { id, allow }),
    openLink: (url) => invoke<void>("open_link", { url }),
    clipPreview: (url) => invoke<LinkPreview>("clip_preview", { url }),
    clipCreate: (title, clip, note) => invoke<string>("clip_create", { title, clip, note }),
    inbox: () => invoke<InboxItem[]>("inbox"),
    setInbox: (id, inbox) => invoke<void>("set_inbox", { id, inbox }),
    takeShared: () => invoke<string | null>("take_shared"),
    tagCards: (tag) => invoke<TagCard[]>("tag_cards", { tag }),
    syncStatus: () => invoke<SyncStatus>("sync_status"),
    syncCreate: (server, token, passphrase) => invoke<SyncStatus>("sync_create", { server, token, passphrase }),
    syncJoin: (code, passphrase) => invoke<SyncStatus>("sync_join", { code, passphrase }),
    syncJoinRecovery: (code, recovery, passphrase) =>
      invoke<SyncStatus>("sync_join_recovery", { code, recovery, passphrase }),
    syncRecoveryCreate: () => invoke<string>("sync_recovery_create"),
    syncRecoveryExists: () => invoke<boolean>("sync_recovery_exists"),
    syncChangePassphrase: (passphrase) => invoke<void>("sync_change_passphrase", { passphrase }),
    syncNow: () => invoke<void>("sync_now"),
    syncDisable: () => invoke<SyncStatus>("sync_disable"),
    syncDevices: () => invoke<SyncDevice[]>("sync_devices"),
    syncRenameDevice: (name) => invoke<SyncDevice[]>("sync_rename_device", { name }),
    syncRemoveDevice: (id) => invoke<SyncDevice[]>("sync_remove_device", { id }),
    // In pieces: a whole photo as one Android JSON body would be slow.
    addAsset: async (file) => {
      const id = await invoke<string>("asset_begin");
      try {
        const piece = ANDROID ? 1 << 20 : 4 << 20;
        for (let at = 0; at < file.size; at += piece) {
          const bytes = new Uint8Array(await file.slice(at, at + piece).arrayBuffer());
          await invoke<void>("asset_write", ANDROID ? Array.from(bytes) : bytes, { headers: { "x-asset-id": id } });
        }
        return await invoke<AssetInfo>("asset_finish", { id, name: file.name, mime: file.type });
      } catch (e) {
        void invoke("asset_cancel", { id }).catch(() => {});
        throw e;
      }
    },
    assetUrl: (sha256) => convertFileSrc(sha256, "folio-asset"),
    openAsset: (sha256, name) => invoke<void>("asset_open", { sha256, name }),
    assetsHere: (sha256s) => invoke<string[]>("asset_have", { sha256s }),
    fetchAssets: (sha256s) => invoke<void>("asset_fetch", { sha256s }),
    onAssetEvent: (listener) => {
      let gone = false;
      const unlisten: (() => void)[] = [];
      void import("@tauri-apps/api/event").then(({ listen }) => {
        const keep = (u: () => void) => (gone ? u() : unlisten.push(u));
        void listen<string>("asset-ready", (e) => listener({ sha256: e.payload, ready: true })).then(keep);
        void listen<{ sha256: string; reason: "elsewhere" | "damaged" | "offline" | "no-sync" }>("asset-missing", (e) =>
          listener({ sha256: e.payload.sha256, ready: false, reason: e.payload.reason }),
        ).then(keep);
      });
      return () => {
        gone = true;
        unlisten.forEach((u) => u());
      };
    },
  };
}
