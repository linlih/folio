import { HistoryDialog } from "../card/HistoryDialog";
import { McpApprovalDialog } from "../mcp/McpDialogs";
import { SettingsDialog } from "../settings/SettingsDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useShell } from "./tabs";

/** The dialog the shell's dialog slot asks for. */
export function ShellDialogs() {
  const dialog = useShell((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "settings":
      return <SettingsDialog section={dialog.section} />;
    case "shortcuts":
      return <ShortcutsDialog />;
    case "history":
      return <HistoryDialog cardId={dialog.cardId} />;
    case "mcpApproval":
      return <McpApprovalDialog key={dialog.id} id={dialog.id} client={dialog.client} />;
  }
}
