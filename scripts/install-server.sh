#!/usr/bin/env bash
# Installs or upgrades the Folio sync server on a Linux machine with systemd,
# behind Caddy for HTTPS (design/ARCHITECTURE.md §5.3):
#
#   curl -fsSL https://raw.githubusercontent.com/linlih/folio/main/scripts/install-server.sh | sudo bash -s -- --domain sync.example.com
#
# Point the domain's DNS (A / AAAA record) at the machine first. Run without
# options on a terminal, it asks for the domain, the public HTTPS port (443,
# or another to avoid most scanning) and the local port, shows the plan and
# changes nothing until you agree; re-runs offer the earlier answers. Everything
# goes under /opt/folio-sync (bin, etc, data, logs); the systemd service and
# the management command are both called folio-sync:
#
#   folio-sync status | start | stop | restart | logs [-f] | info | upgrade | uninstall
#
# Running the script again (or `folio-sync upgrade`) upgrades the server and
# keeps its token and data. Options:
#
#   --domain NAME     the address devices use (asked for when missing)
#   (the three values below are asked for too, unless given or --yes)
#   --email ADDR      for Let's Encrypt notices (only when Caddy is set up new)
#   --port N          local port of the server (default 8787)
#   --https-port N    public HTTPS port (default 443; certificates still use 80)
#   --version vX.Y.Z  a release instead of the latest
#   --binary PATH     install this server file instead of downloading
#   --no-caddy        no HTTPS setup (put your own proxy in front)
#
# HTTPS comes from Caddy: the machine's own Caddy when it has one (a site is
# added to /etc/caddy/Caddyfile after asking), otherwise Caddy's official
# release, checksum-pinned, installed into /opt/folio-sync as the service
# folio-sync-caddy. No package manager is needed.
#   --yes             answer yes to every question
#   --uninstall       stop and remove the server (data kept; --purge too)
set -euo pipefail

REPO="linlih/folio"
SCRIPT_URL="https://raw.githubusercontent.com/$REPO/main/scripts/install-server.sh"
NAME="folio-sync"                     # the service, its user and the command
HOME_DIR="/opt/$NAME"
BIN="$HOME_DIR/bin/folio-server"
CTL="$HOME_DIR/bin/$NAME"
DATA="$HOME_DIR/data"
CONF_DIR="$HOME_DIR/etc"
ENV_FILE="$CONF_DIR/$NAME.env"
LOGS="$HOME_DIR/logs"
LOG_FILE="$LOGS/$NAME.log"
UNIT="/etc/systemd/system/$NAME.service"
LOGROTATE="/etc/logrotate.d/$NAME"
CADDYFILE="/etc/caddy/Caddyfile"          # the system's own Caddy, if any
CADDY_DIR="$HOME_DIR/caddy"               # the bundled Caddy: config and certificates
CADDY_BIN="$HOME_DIR/bin/caddy"
CADDY_USER="folio-caddy"
CADDY_UNIT="/etc/systemd/system/$NAME-caddy.service"
CADDY_VERSION="2.11.7"
CADDY_ADMIN_PORT=2029
CADDY_SHA512_AMD64="a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7"
CADDY_SHA512_ARM64="3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e"
BEGIN_MARK="# >>> folio-sync (managed by install-server.sh)"
END_MARK="# <<< folio-sync"

domain=""; email=""; port=""; https_port=""; version="latest"; binary=""; caddy=1; yes=0; uninstall=0; purge=0

# ---- messages, in Chinese when the system speaks it ----
case "${LC_ALL:-${LANG:-}}" in zh*) ZH=1 ;; *) ZH=0 ;; esac
msg() { if [[ $ZH -eq 1 ]]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$(msg "$1" "$2")"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$(msg "$1" "$2")" >&2; }
die() { printf '\033[31mx  %s\033[0m\n' "$(msg "$1" "$2")" >&2; exit 1; }

# A question; stdin may be the script itself (curl | bash), so ask the terminal.
ask() {
  local zh="$1" en="$2" default="${3:-y}" reply=""
  if [[ $yes -eq 1 ]]; then return 0; fi
  if [[ -r /dev/tty ]]; then
    printf '%s [%s] ' "$(msg "$zh" "$en")" "$([[ $default == y ]] && echo Y/n || echo y/N)" > /dev/tty
    read -r reply < /dev/tty || reply=""
  fi
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    --email) email="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --https-port) https_port="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --binary) binary="${2:-}"; shift 2 ;;
    --no-caddy) caddy=0; shift ;;
    --yes|-y) yes=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "不认识的参数：$1" "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（在命令前加 sudo）。" "run as root (prefix the command with sudo)."
command -v systemctl >/dev/null || die "需要 systemd。" "systemd is required."

caddy_managed() { command -v caddy >/dev/null && [[ -f "$CADDYFILE" ]] && systemctl cat caddy 2>/dev/null | grep -q "$CADDYFILE"; }

# Removes our block (between the markers) from the Caddyfile on stdin.
strip_block() { awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{skip=1;next} $0==e{skip=0;next} !skip'; }

# Applies a changed Caddyfile to a Caddy we share (the machine's own, or one
# another program installed, like a self-hosted Logseq sync): through its
# systemd service when it has one, else through Caddy's admin endpoint.
reload_shared() {
  local config="$1" unit="$2" exe="$3"
  if [[ -n "$unit" ]] && systemctl cat "$unit" >/dev/null 2>&1; then
    if ! systemctl is-active --quiet "$unit"; then systemctl enable --now "$unit"; return; fi
    systemctl reload "$unit" 2>/dev/null && return
  fi
  "$exe" reload --config "$config" --adapter caddyfile --force > /dev/null 2>&1 && return
  [[ -n "$unit" ]] && systemctl restart "$unit"
}

# The Caddy we added our site to, as recorded at install.
shared_setting() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE"; return 0; }

# ---- uninstall ----
if [[ $uninstall -eq 1 ]]; then
  step "停止并移除 folio-sync" "Stopping and removing folio-sync"
  systemctl disable --now "$NAME" "$NAME-caddy" 2>/dev/null || true
  rm -f "$UNIT" "$CADDY_UNIT" "$LOGROTATE" "/usr/bin/$NAME" "/usr/local/bin/$NAME"
  rm -rf "$HOME_DIR/bin"
  systemctl daemon-reload
  systemctl reset-failed "$NAME" "$NAME-caddy" 2>/dev/null || true
  # Our site in a Caddy we share: as recorded, or in the machine's own.
  s_config="$(shared_setting FOLIO_CADDYFILE)"; s_unit="$(shared_setting FOLIO_CADDY_UNIT)"; s_exe="$(shared_setting FOLIO_CADDY_BIN)"
  if [[ -z "$s_config" ]] && caddy_managed; then s_config="$CADDYFILE"; s_unit=caddy.service; s_exe="$(command -v caddy)"; fi
  if [[ -n "$s_config" && -f "$s_config" ]] && grep -qxF "$BEGIN_MARK" "$s_config"; then
    if ask "从 $s_config 里删掉 folio-sync 的站点？" "Remove the folio-sync site from $s_config?"; then
      cp "$s_config" "$s_config.bak-$(date +%Y%m%d%H%M%S)"
      stripped="$(strip_block < "$s_config")"
      printf '%s\n' "$stripped" > "$s_config"
      reload_shared "$s_config" "$s_unit" "${s_exe:-caddy}"
    fi
  fi
  if [[ $purge -eq 1 ]]; then
    rm -rf "$HOME_DIR"
    userdel "$NAME" 2>/dev/null || true
    userdel "$CADDY_USER" 2>/dev/null || true
    msg "已删除，包括 $HOME_DIR 里的数据、令牌、日志和证书。" "Removed, including the data, token, logs and certificates in $HOME_DIR."
  else
    msg "已删除。数据、令牌、日志和证书留在 $HOME_DIR（--purge 一起删除）。" "Removed. The data, token, logs and certificates stay in $HOME_DIR (--purge removes them)."
  fi
  exit 0
fi

# ---- domain and ports, asked step by step ----
saved() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE"; return 0; }   # used in $(...) under set -e
# Defaults: what this machine was set up with before, else the usual ones.
saved_domain="$(saved FOLIO_DOMAIN)"
saved_https="$(saved FOLIO_HTTPS_PORT)"
saved_port="$(saved FOLIO_SERVER_ADDR | sed 's/.*://')"
interactive=0; [[ $yes -eq 0 && -r /dev/tty ]] && interactive=1

# Asks on the terminal, showing the default; Enter keeps it.
prompt() {
  local reply=""
  printf '%s%s ' "$(msg "$1" "$2")" "${3:+ [$3]}" > /dev/tty
  read -r reply < /dev/tty || true
  printf '%s' "${reply:-$3}"
}
if [[ $interactive -eq 1 ]]; then
  printf '\n'
  msg "Folio 同步服务安装：只需要一个域名、一个公网 HTTPS 端口和一个本机端口，回车使用括号里的值。" \
      "Folio sync server setup: a domain, a public HTTPS port and a local port. Press Enter to keep the value in brackets."
fi
if [[ -z "$domain" ]]; then
  if [[ $interactive -eq 1 ]]; then
    printf '\n'
    msg "  只填主机名，不带 https:// 和路径。它的 A / AAAA 记录要已经指向这台服务器。" \
        "  The host name only, without https:// or a path. Its A / AAAA record must already point at this server."
    domain="$(prompt "第 1/3 步 - 域名：" "Step 1/3 - Domain:" "$saved_domain")"
  else
    domain="$saved_domain"
  fi
fi
if [[ -z "$https_port" ]]; then
  if [[ $interactive -eq 1 ]]; then
    printf '\n'
    msg "  设备通过它连接（HTTPS 和 WebSocket）。换成 443 以外的端口可以避开大部分扫描，地址里会带上端口；记得在云服务商的安全组放行它。TCP 80 另外只用于申请和续期证书。" \
        "  Devices connect on it (HTTPS and WebSocket). A port other than 443 avoids most scanning; the address then carries the port. Allow it in your provider's security group. TCP 80 is used only to get and renew the certificate."
    https_port="$(prompt "第 2/3 步 - 公网 HTTPS 端口：" "Step 2/3 - Public HTTPS port:" "${saved_https:-443}")"
  else
    https_port="${saved_https:-443}"
  fi
fi
if [[ -z "$port" ]]; then
  if [[ $interactive -eq 1 ]]; then
    printf '\n'
    msg "  同步服务只在 127.0.0.1 上监听这个端口，由 Caddy 转发过去。不要对外开放。" \
        "  The sync server listens on this port on 127.0.0.1 only; Caddy forwards to it. Never open it to the internet."
    port="$(prompt "第 3/3 步 - 本机端口：" "Step 3/3 - Local port:" "${saved_port:-8787}")"
  else
    port="${saved_port:-8787}"
  fi
fi

domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%%/*}"
[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || die "需要一个域名（--domain sync.example.com）。" "a domain is needed (--domain sync.example.com)."
for p in "$port" "$https_port"; do
  [[ "$p" =~ ^[0-9]+$ && "$p" -ge 1 && "$p" -le 65535 ]] || die "端口不对：$p" "not a port: $p"
done
[[ "$https_port" != 80 && "$port" != 80 ]] || die "端口 80 留给证书申请，请换一个。" "port 80 is kept for certificates; choose another."
[[ "$https_port" != "$port" ]] || die "公网 HTTPS 端口和本机端口不能相同。" "the public HTTPS port and the local port must differ."
# The site address devices use: the domain, with the port when it is not 443.
site="$domain"; [[ "$https_port" != 443 ]] && site="$domain:$https_port"
url="https://$site"

# Caddy can only get a certificate when the name points here.
if [[ $caddy -eq 1 && "$domain" != *.localhost ]]; then
  resolved="$(getent ahosts "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  public="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$resolved" ]]; then
    warn "$domain 还解析不到任何地址。请先把它的 A 记录指向这台机器（$public），否则拿不到 HTTPS 证书。" \
         "$domain does not resolve yet. Point its A record at this machine ($public) first, or no HTTPS certificate can be issued."
    ask "仍然继续？" "Continue anyway?" n || exit 1
  elif [[ -n "$public" && " $resolved " != *" $public "* ]]; then
    warn "$domain 解析到 $resolved，但这台机器的公网地址是 $public。" "$domain resolves to $resolved, but this machine's public address is $public."
    ask "仍然继续？（用了 CDN 或代理时可以继续）" "Continue anyway? (fine behind a CDN or proxy)" n || exit 1
  fi
fi

# ---- how HTTPS is served, decided before anything changes ----
block() {
  cat <<EOF
$BEGIN_MARK
$site {
	reverse_proxy 127.0.0.1:$port
}
$END_MARK
EOF
}
# Who listens on a port (its pid), and what it is.
port_pid() { command -v ss >/dev/null || return 0; ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; }
proc_name() { cat "/proc/$1/comm" 2>/dev/null; }
# A running Caddy's Caddyfile, from its command line (or its directory).
caddy_config_of() {
  local args=() i
  mapfile -d '' args < "/proc/$1/cmdline"
  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in
      --config) readlink -f "${args[i+1]}"; return ;;
      --config=*) readlink -f "${args[i]#--config=}"; return ;;
    esac
  done
  [[ -f "/proc/$1/cwd/Caddyfile" ]] && readlink -f "/proc/$1/cwd/Caddyfile"
}
caddy_adapter_of() { tr '\0' '\n' < "/proc/$1/cmdline" | awk 'p{print; exit} $0=="--adapter"{p=1}'; }
unit_of() { sed -n 's#.*/\([^/]*\.service\)$#\1#p' "/proc/$1/cgroup" 2>/dev/null | head -1; }

caddy_mode=none          # bundled: our own Caddy; shared: a Caddy already here
shared_config=""; shared_unit=""; shared_exe=""
if [[ $caddy -eq 1 ]]; then
  ours="$(systemctl show -p MainPID --value "$NAME-caddy" 2>/dev/null || true)"
  holder=""; holder_port=""
  for p in "$https_port" 80; do
    pid="$(port_pid "$p")"
    if [[ -n "$pid" && "$pid" != "${ours:-0}" ]]; then holder="$pid"; holder_port="$p"; break; fi
  done
  if [[ -n "$holder" && "$(proc_name "$holder")" == caddy ]]; then
    # Another Caddy serves these ports (the machine's own, or one another
    # program installed): our site joins its configuration.
    shared_exe="$(readlink -f "/proc/$holder/exe")"
    shared_config="$(caddy_config_of "$holder")"
    shared_unit="$(unit_of "$holder")"
    adapter="$(caddy_adapter_of "$holder")"
    if [[ -z "$shared_config" || "$shared_config" == *.json || ( -n "$adapter" && "$adapter" != caddyfile ) || ! -f "$shared_config" ]]; then
      warn "端口 $holder_port 由另一个 Caddy（pid $holder）使用，但找不到它可以修改的 Caddyfile（可能跑在 Docker 里，或用 JSON 配置）。把下面的站点加到它的配置里，再用 --no-caddy 重新运行：" \
           "Port $holder_port is served by another Caddy (pid $holder), but it has no Caddyfile to edit (Docker or a JSON configuration, perhaps). Add this site to its configuration, then run again with --no-caddy:"
      block
      exit 1
    fi
    msg "端口 $holder_port 已经由另一个 Caddy 使用：" "Port $holder_port is already served by another Caddy:"
    msg "  程序  $shared_exe" "  program  $shared_exe"
    msg "  配置  $shared_config" "  config   $shared_config"
    msg "  服务  ${shared_unit:-（不是 systemd 服务）}" "  service  ${shared_unit:-(not a systemd service)}"
    caddy_mode=shared
    plan_https="$(msg "把站点加到这个 Caddy 的配置 $shared_config（先备份、检查通过才写入，原有站点不受影响）" "add a site to that Caddy's $shared_config (backed up and checked first; its other sites are untouched)")"
  elif [[ -n "$holder" ]]; then
    name="$(proc_name "$holder")"
    if [[ "$holder_port" == 80 ]]; then
      die "端口 80 被 $name（pid $holder）占用。申请 HTTPS 证书需要它：先停掉它，或者用 --no-caddy 让现有的代理转发到 127.0.0.1:$port。" \
          "port 80 is used by $name (pid $holder). Getting the HTTPS certificate needs it: stop that, or use --no-caddy and have your existing proxy forward to 127.0.0.1:$port."
    fi
    die "端口 $holder_port 被 $name（pid $holder）占用。用 --https-port 换一个（例如 8443），或者用 --no-caddy 让现有的代理转发到 127.0.0.1:$port。" \
        "port $holder_port is used by $name (pid $holder). Choose another with --https-port (8443, say), or use --no-caddy and have your existing proxy forward to 127.0.0.1:$port."
  elif [[ -f "$CADDY_UNIT" ]]; then
    caddy_mode=bundled
    plan_https="$(msg "Folio 自带的 Caddy（服务 $NAME-caddy），更新它的配置" "Folio's own Caddy (the service $NAME-caddy), its configuration updated")"
  elif command -v caddy >/dev/null && caddy_managed; then
    # The machine's own Caddy, installed but not running.
    shared_config="$CADDYFILE"; shared_unit=caddy.service; shared_exe="$(command -v caddy)"
    caddy_mode=shared
    plan_https="$(msg "这台机器的 Caddy：把站点加到 $CADDYFILE（先备份）并启动它" "this machine's Caddy: add a site to $CADDYFILE (backed up first) and start it")"
  elif command -v caddy >/dev/null; then
    caddy_mode=foreign
    plan_https="$(msg "不配置：这台机器的 Caddy 不是用 $CADDYFILE 管理的，装完后把打印的站点加进它的配置" "none: this machine's Caddy is not run from $CADDYFILE; add the printed site to its configuration afterwards")"
  else
    caddy_mode=bundled
    plan_https="$(msg "安装 Caddy $CADDY_VERSION（官方发布，校验 SHA-512）到 $HOME_DIR，作为服务 $NAME-caddy 运行，自动申请和续期证书" "install Caddy $CADDY_VERSION (official release, SHA-512 checked) into $HOME_DIR as the service $NAME-caddy, which gets and renews the certificate")"
  fi
else
  plan_https="$(msg "不配置（--no-caddy）：用你自己的代理把 $url 转发到 127.0.0.1:$port" "none (--no-caddy): have your own proxy forward $url to 127.0.0.1:$port")"
fi

# ---- the plan, before anything changes ----
step "安装计划" "The plan"
printf '  %-14s %s\n' "$(msg "服务器地址" "Server address")" "$url"
printf '  %-14s %s\n' "$(msg "公网端口" "Public ports")" "$(msg "TCP $https_port（HTTPS），TCP 80（只用于证书）" "TCP $https_port (HTTPS), TCP 80 (certificates only)")"
printf '  %-14s %s\n' "$(msg "本机端口" "Local port")" "$(msg "127.0.0.1:$port（不对外开放）" "127.0.0.1:$port (not open to the internet)")"
printf '  %-14s %s\n' "HTTPS" "$plan_https"
printf '  %-14s %s\n' "$(msg "安装位置" "Installed in")" "$(msg "$HOME_DIR（服务和命令都叫 $NAME）" "$HOME_DIR (the service and the command are both $NAME)")"
msg "  云服务商的安全组需要放行 TCP 80 和 TCP $https_port。" "  Your provider's security group must allow TCP 80 and TCP $https_port."
if [[ $interactive -eq 1 ]]; then
  ask "按这个计划开始？" "Go ahead with this plan?" || { msg "没有做任何改动。" "Nothing was changed."; exit 0; }
fi

# ---- the binary ----
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) die "暂不支持这种处理器：$arch" "unsupported processor: $arch" ;;
esac
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [[ -n "$binary" ]]; then
  step "使用本地的 $binary" "Using the local $binary"
  cp "$binary" "$tmp/server"
  release="local"
else
  file="folio-server-$arch-linux"
  if [[ "$version" == latest ]]; then
    # The tag "latest" stands for, to record which version is installed.
    release="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null | sed 's#.*/##')"
    base="https://github.com/$REPO/releases/latest/download"
  else
    release="$version"
    base="https://github.com/$REPO/releases/download/$version"
  fi
  step "下载 $file（$version）" "Downloading $file ($version)"
  curl -fL --retry 3 -o "$tmp/$file" "$base/$file" || die "下载失败：$base/$file" "download failed: $base/$file"
  curl -fsSL --retry 3 -o "$tmp/$file.sha256" "$base/$file.sha256" || die "下载校验文件失败" "could not download the checksum"
  (cd "$tmp" && sha256sum -c --quiet "$file.sha256") || die "校验和不对，已停止。" "checksum mismatch; stopped."
  mv "$tmp/$file" "$tmp/server"
fi
chmod 0755 "$tmp/server"

# ---- user, data, token ----
step "设置服务" "Setting up the service"
id "$NAME" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin "$NAME"
# Root owns the program and its settings; the service writes only data and logs.
install -d -m 0755 -o root -g root "$HOME_DIR" "$HOME_DIR/bin"
install -d -m 0750 -o root -g "$NAME" "$CONF_DIR"
install -d -m 0750 -o "$NAME" -g "$NAME" "$DATA" "$LOGS"
token=""
[[ -f "$ENV_FILE" ]] && token="$(sed -n 's/^FOLIO_SERVER_TOKEN=//p' "$ENV_FILE")"
if [[ ${#token} -lt 16 ]]; then
  token="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  new_token=1
else
  new_token=0
fi
( umask 027
cat > "$ENV_FILE" <<EOF
# folio-sync settings (scripts/install-server.sh). Devices need the token.
# Change them with care, then: folio-sync restart
FOLIO_SERVER_TOKEN=$token
FOLIO_SERVER_ADDR=127.0.0.1:$port
FOLIO_SERVER_DB=$DATA/folio-sync.db
FOLIO_DOMAIN=$domain
FOLIO_HTTPS_PORT=$https_port
FOLIO_PUBLIC_URL=$url
# The Caddy serving HTTPS, when it is one we share (empty: our own or none).
FOLIO_CADDYFILE=$([[ $caddy_mode == shared ]] && echo "$shared_config")
FOLIO_CADDY_UNIT=$([[ $caddy_mode == shared ]] && echo "$shared_unit")
FOLIO_CADDY_BIN=$([[ $caddy_mode == shared ]] && echo "$shared_exe")
EOF
)
chown root:"$NAME" "$ENV_FILE"; chmod 0640 "$ENV_FILE"

# The log goes to a file under $LOGS (systemd 240+), rotated daily below;
# older systemd keeps it in the journal.
logging="StandardOutput=journal"
if [[ "$(systemctl --version | awk 'NR==1{print $2}')" -ge 240 ]]; then
  touch "$LOG_FILE"; chown "$NAME:$NAME" "$LOG_FILE"; chmod 0640 "$LOG_FILE"
  logging="StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Folio sync server
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
User=$NAME
Group=$NAME
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
WorkingDirectory=$DATA
$logging
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=$DATA $LOGS

[Install]
WantedBy=multi-user.target
EOF

# Another program on the port would keep the server from starting.
if ! systemctl is-active --quiet "$NAME" && command -v ss >/dev/null && ss -ltnH "sport = :$port" | grep -q .; then
  die "端口 $port 已被占用，用 --port 换一个。" "port $port is taken; choose another with --port."
fi
install -m 0755 "$tmp/server" "$BIN.new" && mv -f "$BIN.new" "$BIN"
echo "$release" > "$HOME_DIR/VERSION"

if [[ -d /etc/logrotate.d ]]; then
  cat > "$LOGROTATE" <<EOF
$LOGS/*.log {
	daily
	rotate 14
	compress
	delaycompress
	missingok
	notifempty
	copytruncate
}
EOF
fi

# This script, kept for `folio-sync uninstall` (and offline upgrades).
if [[ -f "$0" ]] && grep -q "install-server.sh" "$0" 2>/dev/null; then
  install -m 0755 "$0" "$HOME_DIR/bin/install-server.sh"
else
  curl -fsSL --max-time 20 -o "$HOME_DIR/bin/install-server.sh" "$SCRIPT_URL" 2>/dev/null && chmod 0755 "$HOME_DIR/bin/install-server.sh" || true
fi

# ---- the management command ----
cat > "$CTL" <<'CTL_EOF'
#!/usr/bin/env bash
# folio-sync: manages the Folio sync server (installed by install-server.sh).
set -euo pipefail
HOME_DIR=/opt/folio-sync
ENV_FILE=$HOME_DIR/etc/folio-sync.env
LOGS=$HOME_DIR/logs
SCRIPT_URL=https://raw.githubusercontent.com/linlih/folio/main/scripts/install-server.sh
setting() { sed -n "s/^$1=//p" "$ENV_FILE"; }
# The services: the server, and the bundled Caddy when there is one.
services=(folio-sync)
[[ -f /etc/systemd/system/folio-sync-caddy.service ]] && services+=(folio-sync-caddy)
cmd="${1:-help}"
case "$cmd" in
  start|stop|restart|info|token|upgrade|uninstall)
    [[ $EUID -eq 0 ]] || exec sudo "$0" "$@" ;;
esac
case "$cmd" in
  start|stop|restart)
    systemctl "$cmd" "${services[@]}"
    systemctl --no-pager --lines=0 status "${services[@]}" || true ;;
  status)
    systemctl --no-pager --lines=3 status "${services[@]}" || true
    port="$(sed -n 's/^FOLIO_SERVER_ADDR=.*://p' "$ENV_FILE" 2>/dev/null || true)"
    if curl -fsS --max-time 3 "http://127.0.0.1:${port:-8787}/health" >/dev/null 2>&1; then echo "server health: ok"; else echo "server health: not answering"; fi
    url="$(sed -n 's/^FOLIO_PUBLIC_URL=//p' "$ENV_FILE" 2>/dev/null || true)"
    if [[ -n "$url" ]]; then
      # .localhost names have certificates from Caddy's own CA (tests).
      k=(); [[ "$url" == *.localhost* ]] && k=(-k)
      if curl -fsS "${k[@]}" --max-time 5 "$url/health" >/dev/null 2>&1; then echo "https health: ok ($url)"; else echo "https health: not answering ($url)"; fi
    fi ;;
  logs)
    shift
    which=folio-sync
    case "${1:-}" in caddy|proxy) which=caddy; shift ;; server) shift ;; esac
    file="$LOGS/$which.log"; unit=folio-sync
    # Caddy: our own (its log file), or the one we share (its journal).
    if [[ $which == caddy ]]; then unit="$(setting FOLIO_CADDY_UNIT 2>/dev/null || true)"; unit="${unit:-folio-sync-caddy}"; [[ $unit == folio-sync-caddy ]] || file=/nonexistent; fi
    if [[ -e "$file" ]] && [[ -s "$file" || "${1:-}" == -f ]]; then tail -n 100 "$@" "$file"; else journalctl -u "$unit" -n 100 --no-pager "$@"; fi ;;
  info|token)
    echo "version:  $(cat "$HOME_DIR/VERSION" 2>/dev/null || echo unknown)"
    echo "server:   $(setting FOLIO_PUBLIC_URL)"
    echo "token:    $(setting FOLIO_SERVER_TOKEN)"
    echo "listens:  $(setting FOLIO_SERVER_ADDR)"
    echo "data:     $(setting FOLIO_SERVER_DB)"
    echo "settings: $ENV_FILE"
    echo "logs:     $LOGS"
    if [[ -f $HOME_DIR/caddy/Caddyfile ]]; then echo "caddy:    $HOME_DIR/caddy/Caddyfile (Caddy $(cat $HOME_DIR/caddy/version 2>/dev/null))"; fi
    if [[ -n "$(setting FOLIO_CADDYFILE)" ]]; then echo "caddy:    $(setting FOLIO_CADDYFILE) (shared, service $(setting FOLIO_CADDY_UNIT))"; fi ;;
  upgrade)
    shift
    port="$(sed -n 's/^FOLIO_SERVER_ADDR=.*://p' "$ENV_FILE")"
    https_port="$(setting FOLIO_HTTPS_PORT)"
    script="$(mktemp)"; trap 'rm -f "$script"' EXIT
    curl -fsSL --max-time 30 -o "$script" "$SCRIPT_URL" || cp "$HOME_DIR/bin/install-server.sh" "$script"
    bash "$script" --domain "$(setting FOLIO_DOMAIN)" --port "${port:-8787}" --https-port "${https_port:-443}" --yes "$@" ;;
  uninstall)
    shift
    # A copy: the uninstall removes the original along with bin/.
    script="$(mktemp)"; trap 'rm -f "$script"' EXIT
    cp "$HOME_DIR/bin/install-server.sh" "$script" 2>/dev/null || curl -fsSL -o "$script" "$SCRIPT_URL"
    bash "$script" --uninstall "$@" ;;
  *)
    cat <<USAGE
Usage: folio-sync <command>
  status                 are the server and HTTPS running and answering
  start|stop|restart     the server (and the bundled Caddy)
  logs [caddy] [-f]      the last 100 lines of the server's (or Caddy's) log; -f follows
  info                   address, token, version and where things are
  upgrade [--version vX.Y.Z]
  uninstall [--purge]    remove (--purge: also the data, token, logs and certificates)
USAGE
    ;;
esac
CTL_EOF
chmod 0755 "$CTL"
# In /usr/bin: sudo's search path leaves out /usr/local/bin on some systems
# (OpenCloudOS, CentOS); earlier installs linked it there.
ln -sfn "$CTL" "/usr/bin/$NAME"
[[ -L "/usr/local/bin/$NAME" ]] && rm -f "/usr/local/bin/$NAME"

systemctl daemon-reload
systemctl enable --quiet "$NAME"
systemctl restart "$NAME"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 \
  || { tail -n 20 "$LOG_FILE" >&2 2>/dev/null || journalctl -u "$NAME" -n 20 --no-pager >&2 || true; die "服务没有启动，上面是日志。" "the server did not start; its log is above."; }
msg "folio-sync 已运行（127.0.0.1:$port），安装在 $HOME_DIR。" "folio-sync is running (127.0.0.1:$port), installed in $HOME_DIR."

# ---- Caddy (HTTPS) ----

caddy_arch() { case "$arch" in x86_64) echo amd64 ;; aarch64) echo arm64 ;; esac; }

# Caddy's own release, pinned and checked (no package manager needed).
install_bundled_caddy() {
  local a asset sum got
  a="$(caddy_arch)"
  asset="caddy_${CADDY_VERSION}_linux_${a}.tar.gz"
  case "$a" in
    amd64) sum="$CADDY_SHA512_AMD64" ;;
    arm64) sum="$CADDY_SHA512_ARM64" ;;
  esac
  if [[ -x "$CADDY_BIN" && "$(cat "$CADDY_DIR/version" 2>/dev/null)" == "$CADDY_VERSION" ]]; then
    msg "Caddy $CADDY_VERSION 已安装。" "Caddy $CADDY_VERSION is installed."
    return 0
  fi
  msg "下载 Caddy $CADDY_VERSION（官方发布，校验 SHA-512）…" "Downloading Caddy $CADDY_VERSION (official release, SHA-512 checked)…"
  curl -fL --retry 3 -o "$tmp/$asset" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$asset" \
    || die "下载 Caddy 失败（需要能访问 github.com）。" "could not download Caddy (github.com must be reachable)."
  got="$(sha512sum "$tmp/$asset" | awk '{print $1}')"
  [[ "$got" == "$sum" ]] || die "Caddy 的校验和不对，已停止。" "the Caddy checksum does not match; stopped."
  tar --no-same-owner -xzf "$tmp/$asset" -C "$tmp" caddy
  "$tmp/caddy" version >/dev/null 2>&1 || die "下载的 Caddy 不能在这台机器上运行。" "the downloaded Caddy does not run on this machine."
  install -m 0755 "$tmp/caddy" "$CADDY_BIN.new" && mv -f "$CADDY_BIN.new" "$CADDY_BIN"
  echo "$CADDY_VERSION" > "$CADDY_DIR/version"
}

setup_bundled_caddy() {
  id "$CADDY_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$CADDY_DIR" --shell /usr/sbin/nologin "$CADDY_USER"
  install -d -m 0750 -o root -g "$CADDY_USER" "$CADDY_DIR"
  install -d -m 0700 -o "$CADDY_USER" -g "$CADDY_USER" "$CADDY_DIR/data"

  install_bundled_caddy

  # With HTTPS on another port, a public certificate comes over port 80 only
  # (.localhost names get Caddy's own certificates either way).
  local tls=""
  if [[ "$https_port" != 443 && "$domain" != *.localhost ]]; then tls=$'\ttls {\n\t\tissuer acme {\n\t\t\tdisable_tlsalpn_challenge\n\t\t}\n\t}\n'; fi
  # Its own admin address: another Caddy on this machine keeps 2019.
  {
    printf '{\n\tadmin 127.0.0.1:%s\n' "$CADDY_ADMIN_PORT"
    [[ -n "$email" ]] && printf '\temail %s\n' "$email"
    printf '}\n\n%s {\n\treverse_proxy 127.0.0.1:%s\n%s}\n' "$site" "$port" "$tls"
  } > "$tmp/Caddyfile"
  # Checked by parsing (adapt): validate would also set up certificates.
  "$CADDY_BIN" adapt --config "$tmp/Caddyfile" --adapter caddyfile > "$tmp/validate.log" 2>&1 \
    || { cat "$tmp/validate.log" >&2; die "Caddy 配置没有通过检查。" "the Caddy configuration did not validate."; }
  install -m 0640 -o root -g "$CADDY_USER" "$tmp/Caddyfile" "$CADDY_DIR/Caddyfile"

  local caddy_logging="StandardOutput=journal"
  if [[ "$(systemctl --version | awk 'NR==1{print $2}')" -ge 240 ]]; then
    caddy_logging="StandardOutput=append:$LOGS/caddy.log
StandardError=append:$LOGS/caddy.log"
  fi
  cat > "$CADDY_UNIT" <<EOF
[Unit]
Description=HTTPS for the Folio sync server (Caddy)
After=network-online.target $NAME.service
Wants=network-online.target

[Service]
Type=notify
User=$CADDY_USER
Group=$CADDY_USER
Environment=XDG_DATA_HOME=$CADDY_DIR/data
Environment=XDG_CONFIG_HOME=$CADDY_DIR/data
ExecStart=$CADDY_BIN run --environ --config $CADDY_DIR/Caddyfile --adapter caddyfile
ExecReload=$CADDY_BIN reload --config $CADDY_DIR/Caddyfile --adapter caddyfile --force
$caddy_logging
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$CADDY_DIR/data

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --quiet "$NAME-caddy"
  systemctl restart "$NAME-caddy"
  msg "Caddy 已作为服务 $NAME-caddy 运行（配置：$CADDY_DIR/Caddyfile）。" "Caddy runs as the service $NAME-caddy (configuration: $CADDY_DIR/Caddyfile)."
}

# Adds or updates our site in a Caddy we share (found above).
setup_shared_caddy() {
  local current new do_write=1 backup
  current="$(cat "$shared_config")"
  if grep -qxF "$BEGIN_MARK" "$shared_config"; then
    new="$(printf '%s\n' "$current" | strip_block)"$'\n\n'"$(block)"
    if [[ "$(printf '%s\n' "$current" | awk -v b="$BEGIN_MARK" '$0==b{getline; print $1; exit}')" != "$site" ]]; then
      ask "把 $shared_config 里 folio-sync 的站点改为 $site？" "Change the folio-sync site in $shared_config to $site?" || do_write=0
    fi
  elif grep -Eq "(^|[[:space:],])(https?://)?${domain//./\\.}(:[0-9]+)?([[:space:],{]|$)" "$shared_config"; then
    warn "$shared_config 里已经有 $domain 的站点，没有改动。请确认它代理到 127.0.0.1:$port：" \
         "$shared_config already has a site for $domain; left as it is. Make sure it proxies to 127.0.0.1:$port:"
    block
    proxy_ready=1
    return 0
  else
    new="$current"$'\n\n'"$(block)"
  fi
  [[ $do_write -eq 1 ]] || return 0
  backup="$shared_config.bak-$(date +%Y%m%d%H%M%S)"
  cp "$shared_config" "$backup"
  printf '%s\n' "$new" > "$tmp/Caddyfile.shared"
  # Checked by parsing (adapt): validate would also set up certificates.
  if ! "$shared_exe" adapt --config "$tmp/Caddyfile.shared" --adapter caddyfile > "$tmp/validate.log" 2>&1; then
    cat "$tmp/validate.log" >&2
    die "加上站点后的 Caddy 配置没有通过检查，原文件没有改动。" "the Caddy configuration with our site did not validate; the file is unchanged."
  fi
  # Written over in place: the file keeps its owner and mode (Caddy runs
  # as its own user and must still read it).
  cat "$tmp/Caddyfile.shared" > "$shared_config"
  "$shared_exe" fmt --overwrite "$shared_config" 2>/dev/null || true
  reload_shared "$shared_config" "$shared_unit" "$shared_exe"
  proxy_ready=1
  msg "已把站点加到 $shared_config（备份：$backup）。" "Added the site to $shared_config (backup: $backup)."
}

# Our own Caddy, from a run when it had the ports to itself: it gives way to
# the Caddy that serves them now.
retire_bundled_caddy() {
  msg "停用并移除 Folio 自带的 Caddy（$NAME-caddy）。" "Stopping and removing Folio's own Caddy ($NAME-caddy)."
  systemctl disable --now "$NAME-caddy" 2>/dev/null || true
  rm -f "$CADDY_UNIT" "$CADDY_BIN"
  rm -rf "$CADDY_DIR"
  userdel "$CADDY_USER" 2>/dev/null || true
  systemctl daemon-reload
  systemctl reset-failed "$NAME-caddy" 2>/dev/null || true
}

proxy_ready=0
# Where Caddy's log stands now: progress is read from here on.
caddy_since="$(date '+%Y-%m-%d %H:%M:%S')"
caddy_log_offset="$(stat -c %s "$LOGS/caddy.log" 2>/dev/null || echo 0)"
if [[ $caddy -eq 1 ]]; then
  step "配置 HTTPS（Caddy）" "Setting up HTTPS (Caddy)"
  case "$caddy_mode" in
    bundled) setup_bundled_caddy; proxy_ready=1 ;;
    shared)
      [[ -f "$CADDY_UNIT" ]] && retire_bundled_caddy
      setup_shared_caddy ;;
    foreign)
      warn "这台机器的 Caddy 不是用 $CADDYFILE 管理的，请把下面的站点加到你的配置里：" \
           "This machine's Caddy is not run from $CADDYFILE; add this site to your configuration:"
      block ;;
    *) msg "没有配置 HTTPS。用你自己的代理把 $url 转发到 127.0.0.1:$port。" "HTTPS is not set up. Have your own proxy forward $url to 127.0.0.1:$port." ;;
  esac

  # Certificates need port 80, devices the HTTPS port.
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    if ask "ufw 防火墙已开启。放行 80 和 $https_port 端口？" "The ufw firewall is on. Allow ports 80 and $https_port?"; then ufw allow 80/tcp >/dev/null; ufw allow "$https_port"/tcp >/dev/null; fi
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    if ask "firewalld 已开启。放行 80 和 $https_port 端口？" "firewalld is on. Allow ports 80 and $https_port?"; then
      firewall-cmd --quiet --permanent --add-port=80/tcp --add-port="$https_port"/tcp && firewall-cmd --quiet --reload
    fi
  fi
fi

# ---- check from outside ----
# Caddy's own log tells what the certificate is waiting for; its lines about
# our domain are shown as they come, so a slow certificate does not look like
# a hang.
caddy_event() {
  local line="$1" m err type retry attempt
  m="$(sed -n 's/.*"msg":"\([^"]*\)".*/\1/p' <<<"$line")"
  err="$(sed -n 's/.*"error":"\([^"]*\).*/\1/p' <<<"$line" | cut -c1-200)"
  case "$m" in
    "obtaining certificate") msg "开始申请证书" "requesting a certificate" ;;
    "trying to solve challenge")
      type="$(sed -n 's/.*"challenge_type":"\([^"]*\)".*/\1/p' <<<"$line")"
      msg "正在验证域名归属（${type:-challenge}）" "proving the domain is ours (${type:-challenge})" ;;
    "served key authentication"*) msg "证书机构已访问到这台服务器" "the certificate authority reached this server" ;;
    "authorization finalized") msg "域名验证通过" "domain verified" ;;
    "validations succeeded; finalizing order") msg "验证通过，正在签发" "verified; issuing" ;;
    "certificate obtained successfully") msg "证书已签发" "certificate issued" ;;
    "challenge failed") msg "验证失败：$err" "challenge failed: $err" ;;
    "could not get certificate from issuer") msg "这个证书机构没有签发（会换一个或稍后重试）：$err" "this issuer did not issue (another one or a retry follows): $err" ;;
    "will retry")
      retry="$(sed -n 's/.*"retrying_in":\([0-9.]*\).*/\1/p' <<<"$line")"; attempt="$(sed -n 's/.*"attempt":\([0-9]*\).*/\1/p' <<<"$line")"
      msg "第 ${attempt:-?} 次没有成功，${retry%.*} 秒后重试" "attempt ${attempt:-?} failed; retrying in ${retry%.*} s" ;;
    "job failed") msg "申请失败：$err" "failed: $err" ;;
    *) [[ "$line" == *'"level":"error"'* ]] && msg "错误：$m $err" "error: $m $err" ;;
  esac
  return 0   # used in $(...) under set -e
}

# Why it failed, from Caddy's errors.
certificate_hint() {
  local errors="$1"
  case "$errors" in
    *"Timeout during connect"*|*"connection refused"*|*"Connection refused"*|*"timeout"*)
      msg "证书机构连不上这台服务器的 80 端口：检查云服务商的安全组 / 防火墙是否放行 TCP 80。" \
          "The certificate authority cannot reach port 80 on this server: check that your provider's security group / firewall allows TCP 80." ;;
    *"NXDOMAIN"*|*"DNS problem"*|*"no valid A records"*)
      msg "证书机构查不到域名的解析：等 DNS 生效，或检查 A / AAAA 记录（AAAA 记录指错也会失败）。" \
          "The certificate authority cannot resolve the domain: wait for DNS, or check the A / AAAA records (a wrong AAAA record fails too)." ;;
    *"rateLimited"*|*"too many"*)
      msg "达到了证书机构的频率限制，需要等一段时间（通常一小时以内）再试。" \
          "The certificate authority's rate limit was hit; wait a while (usually under an hour) and try again." ;;
    *"unauthorized"*|*"Invalid response"*|*"403"*|*"404"*)
      msg "证书机构访问到的不是这台 Caddy：可能有 CDN / 代理挡在前面，或者服务器在中国大陆而域名没有 ICP 备案（云服务商会拦截 80/443）。" \
          "The certificate authority did not reach this Caddy: a CDN / proxy may sit in front, or the server is in mainland China and the domain has no ICP filing (providers block ports 80/443)." ;;
  esac
}

reachable=0
if [[ $proxy_ready -eq 1 ]]; then
  step "等待 HTTPS 生效" "Waiting for HTTPS"
  msg "首次申请证书通常需要 10–60 秒，下面是 Caddy 的进度。证书签发后会保存下来，以后不用再申请。" \
      "The first certificate usually takes 10–60 seconds; Caddy's progress follows. Once issued it is kept, so this happens only once."
  events="$tmp/caddy-events"; : > "$events"
  if [[ $caddy_mode == bundled && -f "$LOGS/caddy.log" ]]; then
    tail -c +"$((caddy_log_offset + 1))" -F "$LOGS/caddy.log" > "$events" 2>/dev/null &
  else
    unit="$shared_unit"; [[ $caddy_mode == bundled ]] && unit="$NAME-caddy"
    [[ -n "$unit" ]] && journalctl -u "$unit" --since "$caddy_since" -f -o cat > "$events" 2>/dev/null &
  fi
  follower=$!
  curl_opts=(-fsS --max-time 10)
  [[ "$domain" == *.localhost ]] && curl_opts+=(-k)
  seen=0; quiet=0; started=$SECONDS; errors=""
  while (( SECONDS - started < 180 )); do
    if curl "${curl_opts[@]}" "$url/health" >/dev/null 2>&1; then reachable=1; break; fi
    new=0
    while IFS= read -r line; do
      seen=$((seen + 1))
      [[ "$line" == *"$domain"* ]] || continue
      said="$(caddy_event "$line")"
      [[ -n "$said" ]] || continue
      printf '  [%3ss] %s\n' "$((SECONDS - started))" "$said"
      [[ "$line" == *'"error"'* ]] && errors+="$line"$'\n'
      new=1
    done < <(tail -n +"$((seen + 1))" "$events")
    if (( new )); then quiet=0; else quiet=$((quiet + 1)); fi
    if (( quiet > 0 && quiet % 5 == 0 )); then
      printf '  [%3ss] %s\n' "$((SECONDS - started))" "$(msg "仍在等待…（随时可以 Ctrl-C，Caddy 会在后台继续申请）" "still waiting… (Ctrl-C is fine; Caddy keeps trying in the background)")"
    fi
    sleep 3
  done
  kill "$follower" 2>/dev/null || true
  if [[ $reachable -eq 1 ]]; then
    msg "HTTPS 已可用：$url" "HTTPS works: $url"
  else
    warn "3 分钟内还没能访问 $url/health。Caddy 会在后台继续重试，可以用 folio-sync logs caddy -f 查看。" \
         "$url/health is still not reachable after 3 minutes. Caddy keeps retrying in the background; watch it with folio-sync logs caddy -f."
    [[ -n "$errors" ]] && certificate_hint "$errors"
    msg "也请确认：域名解析到这台服务器，云服务商安全组放行 TCP 80 和 $https_port。" \
        "Also check: the domain resolves to this server, and your provider's security group allows TCP 80 and $https_port."
  fi
fi

# ---- what to enter in the app ----
printf '\n'
msg "完成。在 Folio 里打开 设置 → 同步 → 新建同步空间，填写：" "Done. In Folio, open Settings → Sync → New sync space and enter:"
printf '  %-12s %s\n' "$(msg "服务器" "Server")" "$url"
printf '  %-12s %s\n' "$(msg "服务器令牌" "Token")" "$token"
if [[ $new_token -eq 0 ]]; then msg "（令牌沿用之前的，已加入的设备不受影响）" "(the token is the same as before; devices already syncing keep working)"; fi
printf '\n'
msg "管理：folio-sync status | start | stop | restart | logs [caddy] -f | info | upgrade | uninstall" \
    "Manage it with: folio-sync status | start | stop | restart | logs [caddy] -f | info | upgrade | uninstall"
msg "全部文件在 $HOME_DIR：bin/ 程序，etc/ 设置和令牌，data/ 数据，logs/ 日志（每天轮转，保留 14 天），caddy/ HTTPS 证书和配置。" \
    "Everything is in $HOME_DIR: bin/ programs, etc/ settings and token, data/ data, logs/ logs (rotated daily, 14 days kept), caddy/ HTTPS certificates and configuration."
[[ $reachable -eq 1 || $proxy_ready -eq 0 ]] || exit 1
