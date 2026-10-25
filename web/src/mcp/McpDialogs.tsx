import { Copy, Eye, EyeOff, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpStatus } from "../bindings/commands";
import { backend } from "../platform";
import { DialogFrame } from "../shell/Dialog";
import { useShell } from "../shell/tabs";
import "./mcp.css";

/** How each AI tool is told about the server: a command or a config file,
 *  and where it goes. Formats as each tool documents them (2026-10). */
export const CLIENTS = ["claudeCode", "codex", "cursor", "gemini", "vscode", "claudeDesktop", "other"] as const;
type Client = (typeof CLIENTS)[number];

export function setup(client: Client, s: McpStatus): string {
  const auth = `Bearer ${s.token}`;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  switch (client) {
    case "claudeCode":
      return `claude mcp add --transport http folio ${s.url} --header "Authorization: ${auth}"`;
    case "codex":
      return `[mcp_servers.folio]\nurl = "${s.url}"\nhttp_headers = { "Authorization" = "${auth}" }`;
    case "cursor":
      return json({ mcpServers: { folio: { url: s.url, headers: { Authorization: auth } } } });
    case "gemini":
      return `gemini mcp add --transport http --header "Authorization: ${auth}" folio ${s.url}`;
    case "vscode":
      return json({ servers: { folio: { type: "http", url: s.url, headers: { Authorization: auth } } } });
    case "claudeDesktop":
      // Its config starts local programs only: the mcp-remote bridge.
      return json({ mcpServers: { folio: { command: "npx", args: ["-y", "mcp-remote", s.url, "--header", "Authorization:${FOLIO_AUTH}"], env: { FOLIO_AUTH: auth } } } });
    case "other":
      return `URL: ${s.url}\nAuthorization: ${auth}`;
  }
}

export function CopyBlock({ label, text, secret }: { label: string; text: string; secret?: string }) {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const shown = secret ? text.replaceAll(secret, "•".repeat(12)) : text;
  return (
    <div className="mcp-copy">
      <div className="mcp-copy-head">
        <span>{label}</span>
        <button
          className="icon-button"
          title={t("mcp.copy")}
          aria-label={t("mcp.copy")}
          onClick={() => void navigator.clipboard.writeText(text).then(() => setNotice(t("mcp.copied")))}
        >
          <Copy size={14} />
        </button>
      </div>
      <pre>{shown}</pre>
    </div>
  );
}

/** Settings → AI access (MCP): turn the server on, the address and token
 *  to give an AI tool, approved clients (design/ARCHITECTURE.md §0.3). */
export function McpPanel() {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [status, setStatus] = useState<McpStatus | null | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  const [client, setClient] = useState<Client>("claudeCode");

  useEffect(() => {
    backend.mcpStatus().then(setStatus, (e) => setNotice(t("error.generic", { message: String(e) })));
  }, [setNotice, t]);

  const run = (f: () => Promise<McpStatus>) => f().then(setStatus, (e) => setNotice(t("error.generic", { message: String(e) })));

  return (
    <>
      {status === null && <p className="dialog-empty">{t("settings.diagnosticsUnavailable")}</p>}
      {status && (
        <div className="mcp">
          <label className="mcp-switch">
            <input type="checkbox" checked={status.enabled} onChange={(e) => void run(() => backend.setMcpEnabled(e.target.checked))} />
            <span>{t("mcp.enable")}</span>
            <span className={`mcp-state${status.running ? " on" : ""}`}>{status.running ? t("mcp.running") : t("mcp.off")}</span>
          </label>
          {status.error && <p className="mcp-error">{t("mcp.failed", { message: status.error })}</p>}
          {status.enabled && (
            <>
              <div className="mcp-field">
                <span>{t("mcp.url")}</span>
                <code>{status.url}</code>
              </div>
              <div className="mcp-field">
                <span>{t("mcp.token")}</span>
                <code>{reveal ? status.token : "•".repeat(24)}</code>
                <button className="icon-button" aria-label={t(reveal ? "mcp.hide" : "mcp.show")} title={t(reveal ? "mcp.hide" : "mcp.show")} onClick={() => setReveal((r) => !r)}>
                  {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button className="icon-button" aria-label={t("mcp.regenerate")} title={t("mcp.regenerate")} onClick={() => void run(() => backend.regenerateMcpToken())}>
                  <RefreshCw size={14} />
                </button>
              </div>
              <div className="mcp-clients-pick" role="tablist" aria-label={t("mcp.client")}>
                {CLIENTS.map((c) => (
                  <button key={c} role="tab" aria-selected={client === c} className={`mcp-client${client === c ? " on" : ""}`} onClick={() => setClient(c)}>
                    {t(`mcp.agents.${c}.name`)}
                  </button>
                ))}
              </div>
              <CopyBlock label={t(`mcp.agents.${client}.where`)} text={setup(client, status)} secret={reveal ? undefined : status.token} />
              <h3 className="mcp-subtitle">{t("mcp.clients")}</h3>
              {status.clients.length === 0 ? (
                <p className="dialog-empty">{t("mcp.noClients")}</p>
              ) : (
                <ul className="mcp-clients">
                  {status.clients.map((c) => (
                    <li key={c}>
                      <span>{c}</span>
                      <button className="button" onClick={() => void run(() => backend.revokeMcpClient(c))}>
                        <X size={13} />
                        {t("mcp.revoke")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** A new AI tool wants to connect: allow or decline. Closing the dialog
 *  declines; the dialog leaving the screen does not (React mounts it twice
 *  in development, which used to decline every request at once). */
export function McpApprovalDialog({ id, client }: { id: string; client: string }) {
  const { t } = useTranslation();
  const setDialog = useShell((s) => s.setDialog);
  const answered = useRef(false);
  const answer = (allow: boolean) => {
    if (answered.current) return;
    answered.current = true;
    void backend.answerMcpApproval(id, allow);
    setDialog(null);
  };
  return (
    <DialogFrame title={t("mcp.approvalTitle")} description={t("mcp.approvalText", { client })} onClose={() => answer(false)}>
      <div className="dialog-actions mcp-approval-actions">
        <button className="button" onClick={() => answer(false)}>
          {t("mcp.decline")}
        </button>
        <button className="button primary" onClick={() => answer(true)}>
          {t("mcp.allow")}
        </button>
      </div>
    </DialogFrame>
  );
}

/** Desktop: approval requests from the MCP server open the dialog. */
export function useMcpApprovals() {
  useEffect(() => {
    if (backend.kind !== "tauri") return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ id: string; client: string }>("mcp-approval", (e) => useShell.getState().setDialog({ kind: "mcpApproval", id: e.payload.id, client: e.payload.client })),
      )
      .then((u) => (gone ? u() : (unlisten = u)));
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
}
