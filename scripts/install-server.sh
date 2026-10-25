#!/usr/bin/env bash
# Installs or upgrades the Folio sync server on a Linux machine with systemd,
# behind Caddy for HTTPS (design/ARCHITECTURE.md §5.3):
#
#   curl -fsSL https://raw.githubusercontent.com/linlih/folio/main/scripts/install-server.sh | sudo bash -s -- --domain sync.example.com
#
# Point the domain's DNS (A / AAAA record) at the machine first. Everything
# goes under /opt/folio-sync (bin, etc, data, logs); the systemd service and
# the management command are both called folio-sync:
#
#   folio-sync status | start | stop | restart | logs [-f] | info | upgrade | uninstall
#
# Running the script again (or `folio-sync upgrade`) upgrades the server and
# keeps its token and data. Options:
#
#   --domain NAME     the address devices use (asked for when missing)
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
CADDY_SHA512_AMD64="a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7"
CADDY_SHA512_ARM64="3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e"
BEGIN_MARK="# >>> folio-sync (managed by install-server.sh)"
END_MARK="# <<< folio-sync"

domain=""; email=""; port=8787; https_port=443; version="latest"; binary=""; caddy=1; yes=0; uninstall=0; purge=0

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
    -h|--help) sed -n '2,35p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "不认识的参数：$1" "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（在命令前加 sudo）。" "run as root (prefix the command with sudo)."
command -v systemctl >/dev/null || die "需要 systemd。" "systemd is required."
[[ "$port" =~ ^[0-9]+$ ]] || die "端口不对：$port" "not a port: $port"
[[ "$https_port" =~ ^[0-9]+$ ]] || die "端口不对：$https_port" "not a port: $https_port"

caddy_managed() { command -v caddy >/dev/null && [[ -f "$CADDYFILE" ]] && systemctl cat caddy 2>/dev/null | grep -q "$CADDYFILE"; }

# Removes our block (between the markers) from the Caddyfile on stdin.
strip_block() { awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{skip=1;next} $0==e{skip=0;next} !skip'; }

reload_caddy() {
  if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl enable --now caddy; fi
}

# ---- uninstall ----
if [[ $uninstall -eq 1 ]]; then
  step "停止并移除 folio-sync" "Stopping and removing folio-sync"
  systemctl disable --now "$NAME" "$NAME-caddy" 2>/dev/null || true
  rm -f "$UNIT" "$CADDY_UNIT" "$LOGROTATE" "/usr/local/bin/$NAME"
  rm -rf "$HOME_DIR/bin"
  systemctl daemon-reload
  if caddy_managed && grep -qxF "$BEGIN_MARK" "$CADDYFILE"; then
    if ask "从 Caddy 配置里删掉 folio-sync 的站点？" "Remove the folio-sync site from Caddy?"; then
      cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
      stripped="$(strip_block < "$CADDYFILE")"
      printf '%s\n' "$stripped" > "$CADDYFILE"
      reload_caddy
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

# ---- the domain ----
if [[ -z "$domain" && -f "$ENV_FILE" ]]; then domain="$(sed -n 's/^FOLIO_DOMAIN=//p' "$ENV_FILE")"; fi
if [[ -z "$domain" && -r /dev/tty ]]; then
  printf '%s ' "$(msg "同步服务用的域名（例如 sync.example.com）：" "Domain for the sync server (for example sync.example.com):")" > /dev/tty
  read -r domain < /dev/tty || true
fi
domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%%/*}"
[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || die "需要一个域名（--domain sync.example.com）。" "a domain is needed (--domain sync.example.com)."
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
# Who has a port, as "name (pid)", or nothing when it is free.
port_owner() {
  command -v ss >/dev/null || return 0
  ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1 (\2)/p' | head -1
}
caddy_mode=none
if [[ $caddy -eq 1 ]]; then
  if [[ -f "$CADDY_UNIT" ]]; then
    caddy_mode=bundled
  elif command -v caddy >/dev/null && caddy_managed; then
    caddy_mode=system
  elif command -v caddy >/dev/null; then
    caddy_mode=foreign
  elif ask "没有找到 Caddy。安装 Folio 自带的 Caddy（官方 $CADDY_VERSION）到 $HOME_DIR，作为服务 $NAME-caddy 运行，自动申请和续期 HTTPS 证书？" \
           "No Caddy found. Install Caddy $CADDY_VERSION (the official release) into $HOME_DIR as the service $NAME-caddy, which gets and renews the HTTPS certificate?"; then
    caddy_mode=bundled
  fi
  if [[ $caddy_mode == bundled ]]; then
    # Certificates need port 80; devices come in on the HTTPS port. Our own
    # Caddy may hold them already (a re-run).
    for p in 80 "$https_port"; do
      owner="$(port_owner "$p")"
      [[ -z "$owner" || "$owner" == caddy* ]] && continue
      if [[ "$p" == 80 ]]; then
        die "端口 80 被 $owner 占用。申请 HTTPS 证书需要它：先停掉它，或者用 --no-caddy 让现有的代理转发到 127.0.0.1:$port。" \
            "port 80 is used by $owner. Getting the HTTPS certificate needs it: stop that, or use --no-caddy and have your existing proxy forward to 127.0.0.1:$port."
      fi
      die "端口 $p 被 $owner 占用。用 --https-port 换一个（例如 8443），或者用 --no-caddy 让现有的代理转发到 127.0.0.1:$port。" \
          "port $p is used by $owner. Choose another with --https-port (8443, say), or use --no-caddy and have your existing proxy forward to 127.0.0.1:$port."
    done
  fi
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
    file="$LOGS/$which.log"; unit=folio-sync; [[ $which == caddy ]] && unit=folio-sync-caddy
    if [[ -e "$file" ]] && [[ -s "$file" || "${1:-}" == -f ]]; then tail -n 100 "$@" "$file"; else journalctl -u "$unit" -n 100 --no-pager "$@"; fi ;;
  info|token)
    echo "version:  $(cat "$HOME_DIR/VERSION" 2>/dev/null || echo unknown)"
    echo "server:   $(setting FOLIO_PUBLIC_URL)"
    echo "token:    $(setting FOLIO_SERVER_TOKEN)"
    echo "listens:  $(setting FOLIO_SERVER_ADDR)"
    echo "data:     $(setting FOLIO_SERVER_DB)"
    echo "settings: $ENV_FILE"
    echo "logs:     $LOGS"
    if [[ -f $HOME_DIR/caddy/Caddyfile ]]; then echo "caddy:    $HOME_DIR/caddy/Caddyfile (Caddy $(cat $HOME_DIR/caddy/version 2>/dev/null))"; fi ;;
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
ln -sfn "$CTL" "/usr/local/bin/$NAME"

systemctl daemon-reload
systemctl enable --quiet "$NAME"
systemctl restart "$NAME"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 \
  || { tail -n 20 "$LOG_FILE" >&2 2>/dev/null || journalctl -u "$NAME" -n 20 --no-pager >&2 || true; die "服务没有启动，上面是日志。" "the server did not start; its log is above."; }
msg "folio-sync 已运行（127.0.0.1:$port），安装在 $HOME_DIR。" "folio-sync is running (127.0.0.1:$port), installed in $HOME_DIR."

# ---- Caddy (HTTPS) ----
block() {
  cat <<EOF
$BEGIN_MARK
$site {
	reverse_proxy 127.0.0.1:$port
}
$END_MARK
EOF
}

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

  # With HTTPS on another port, the certificate comes over port 80 only.
  local tls=""
  if [[ "$https_port" != 443 ]]; then tls=$'\ttls {\n\t\tissuer acme {\n\t\t\tdisable_tlsalpn_challenge\n\t\t}\n\t}\n'; fi
  {
    [[ -n "$email" ]] && printf '{\n\temail %s\n}\n\n' "$email"
    printf '%s {\n\treverse_proxy 127.0.0.1:%s\n%s}\n' "$site" "$port" "$tls"
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

# Adds or updates our site in the system's own Caddy (/etc/caddy/Caddyfile).
setup_system_caddy() {
  local current new do_write=0 backup
  current="$(cat "$CADDYFILE")"
  if grep -qxF "$BEGIN_MARK" "$CADDYFILE"; then
    new="$(printf '%s\n' "$current" | strip_block)"$'\n\n'"$(block)"
    do_write=1
    if [[ "$(printf '%s\n' "$current" | awk -v b="$BEGIN_MARK" '$0==b{getline; print $1; exit}')" != "$site" ]]; then
      ask "把 Caddy 里 folio-sync 的站点改为 $site？" "Change the folio-sync site in Caddy to $site?" || do_write=0
    fi
  elif grep -Eq "(^|[[:space:],])(https?://)?${domain//./\\.}([[:space:],:{]|$)" "$CADDYFILE"; then
    warn "$CADDYFILE 里已经有 $domain 的站点，没有改动。请确认它代理到 127.0.0.1:$port：" \
         "$CADDYFILE already has a site for $domain; left as it is. Make sure it proxies to 127.0.0.1:$port:"
    block
    proxy_ready=1
    return 0
  elif ask "这台机器已经装了 Caddy。在 $CADDYFILE 里为 $site 添加站点？（原文件会备份）" "Caddy is already installed here. Add a site for $site to $CADDYFILE? (the file is backed up first)"; then
    new="$current"$'\n\n'"$(block)"
    do_write=1
  else
    msg "没有改动 Caddy。需要时把这段加进去：" "Caddy left alone. When you want it, add:"
    block
  fi
  [[ $do_write -eq 1 ]] || return 0
  backup="$CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
  cp "$CADDYFILE" "$backup"
  printf '%s\n' "$new" > "$CADDYFILE.new"
  if caddy validate --config "$CADDYFILE.new" --adapter caddyfile > "$tmp/validate.log" 2>&1; then
    # Written over in place: the file keeps its owner and mode (Caddy runs
    # as its own user and must still read it).
    cat "$CADDYFILE.new" > "$CADDYFILE"; rm -f "$CADDYFILE.new"
    caddy fmt --overwrite "$CADDYFILE" 2>/dev/null || true
    if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl enable --now caddy; fi
    proxy_ready=1
    msg "已更新 $CADDYFILE（备份：$backup）。" "Updated $CADDYFILE (backup: $backup)."
  else
    rm -f "$CADDYFILE.new"
    cat "$tmp/validate.log" >&2
    die "新的 Caddy 配置没有通过检查，原文件没有改动。" "the new Caddy configuration did not validate; the file is unchanged."
  fi
}

proxy_ready=0
if [[ $caddy -eq 1 ]]; then
  step "配置 HTTPS（Caddy）" "Setting up HTTPS (Caddy)"
  case "$caddy_mode" in
    bundled) setup_bundled_caddy; proxy_ready=1 ;;
    system) setup_system_caddy ;;
    foreign)
      warn "这台机器的 Caddy 不是用 $CADDYFILE 管理的（比如跑在 Docker 里），请把下面的站点加到你的配置里：" \
           "This machine's Caddy is not run from $CADDYFILE (Docker, perhaps); add this site to your configuration:"
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
reachable=0
if [[ $proxy_ready -eq 1 ]]; then
  step "等待 HTTPS 生效（首次申请证书可能要一分钟）" "Waiting for HTTPS (the first certificate can take a minute)"
  curl_opts=(-fsS --max-time 10)
  [[ "$domain" == *.localhost ]] && curl_opts+=(-k)
  for _ in $(seq 1 30); do
    if curl "${curl_opts[@]}" "$url/health" >/dev/null 2>&1; then reachable=1; break; fi
    sleep 3
  done
  if [[ $reachable -eq 0 ]]; then
    warn "还访问不到 $url/health。检查域名解析，云服务商安全组是否放行 80 和 $https_port 端口，以及 folio-sync logs caddy。" \
         "$url/health is not reachable yet. Check the DNS record, that your provider's firewall allows ports 80 and $https_port, and folio-sync logs caddy."
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
