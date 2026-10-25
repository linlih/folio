#!/usr/bin/env bash
# Installs or upgrades the Folio sync server on a Linux machine with systemd,
# behind Caddy for HTTPS (design/ARCHITECTURE.md §5.3):
#
#   curl -fsSL https://raw.githubusercontent.com/linlih/folio/main/scripts/install-server.sh | sudo bash -s -- --domain sync.example.com
#
# Point the domain's DNS (A / AAAA record) at the machine first. Running it
# again upgrades the server and keeps its token and data. Options:
#
#   --domain NAME     the address devices use (asked for when missing)
#   --email ADDR      for Let's Encrypt notices (only when Caddy is set up new)
#   --port N          local port of the server (default 8787)
#   --version vX.Y.Z  a release instead of the latest
#   --binary PATH     install this folio-server file instead of downloading
#   --no-caddy        do not touch Caddy (put your own proxy in front)
#   --yes             answer yes to every question
#   --uninstall       stop and remove the server (data kept; --purge too)
set -euo pipefail

REPO="linlih/folio"
NAME="folio-server"
BIN="/usr/local/bin/$NAME"
DATA="/var/lib/$NAME"
CONF_DIR="/etc/$NAME"
ENV_FILE="$CONF_DIR/env"
UNIT="/etc/systemd/system/$NAME.service"
CADDYFILE="/etc/caddy/Caddyfile"
BEGIN_MARK="# >>> folio-server (managed by install-server.sh)"
END_MARK="# <<< folio-server"

domain=""; email=""; port=8787; version="latest"; binary=""; caddy=1; yes=0; uninstall=0; purge=0
installed_caddy=0

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
    --version) version="${2:-}"; shift 2 ;;
    --binary) binary="${2:-}"; shift 2 ;;
    --no-caddy) caddy=0; shift ;;
    --yes|-y) yes=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "不认识的参数：$1" "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（在命令前加 sudo）。" "run as root (prefix the command with sudo)."
command -v systemctl >/dev/null || die "需要 systemd。" "systemd is required."
[[ "$port" =~ ^[0-9]+$ ]] || die "端口不对：$port" "not a port: $port"

caddy_managed() { command -v caddy >/dev/null && [[ -f "$CADDYFILE" ]] && systemctl cat caddy 2>/dev/null | grep -q "$CADDYFILE"; }

# Removes our block (between the markers) from the Caddyfile on stdin.
strip_block() { awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{skip=1;next} $0==e{skip=0;next} !skip'; }

reload_caddy() {
  if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl enable --now caddy; fi
}

# ---- uninstall ----
if [[ $uninstall -eq 1 ]]; then
  step "停止并移除 folio-server" "Stopping and removing folio-server"
  systemctl disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT" "$BIN"
  systemctl daemon-reload
  if caddy_managed && grep -qxF "$BEGIN_MARK" "$CADDYFILE"; then
    if ask "从 Caddy 配置里删掉 folio-server 的站点？" "Remove the folio-server site from Caddy?"; then
      cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
      stripped="$(strip_block < "$CADDYFILE")"
      printf '%s\n' "$stripped" > "$CADDYFILE"
      reload_caddy
    fi
  fi
  if [[ $purge -eq 1 ]]; then
    rm -rf "$DATA" "$CONF_DIR"
    userdel "$NAME" 2>/dev/null || true
    msg "已删除，包括数据和令牌。" "Removed, including its data and token."
  else
    msg "已删除。数据在 $DATA，令牌在 $ENV_FILE（--purge 一起删除）。" "Removed. Data stays in $DATA and the token in $ENV_FILE (--purge removes them)."
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
  cp "$binary" "$tmp/$NAME"
else
  file="$NAME-$arch-linux"
  if [[ "$version" == latest ]]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$version"; fi
  step "下载 $file（$version）" "Downloading $file ($version)"
  curl -fL --retry 3 -o "$tmp/$file" "$base/$file" || die "下载失败：$base/$file" "download failed: $base/$file"
  curl -fsSL --retry 3 -o "$tmp/$file.sha256" "$base/$file.sha256" || die "下载校验文件失败" "could not download the checksum"
  (cd "$tmp" && sha256sum -c --quiet "$file.sha256") || die "校验和不对，已停止。" "checksum mismatch; stopped."
  mv "$tmp/$file" "$tmp/$NAME"
fi
chmod 0755 "$tmp/$NAME"

# ---- user, data, token ----
step "设置服务" "Setting up the service"
id "$NAME" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$NAME"
install -d -m 0750 -o "$NAME" -g "$NAME" "$DATA"
install -d -m 0750 -o root -g "$NAME" "$CONF_DIR"
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
# folio-server settings (scripts/install-server.sh). Devices need the token.
FOLIO_SERVER_TOKEN=$token
FOLIO_SERVER_ADDR=127.0.0.1:$port
FOLIO_SERVER_DB=$DATA/folio-server.db
FOLIO_DOMAIN=$domain
EOF
)
chown root:"$NAME" "$ENV_FILE"; chmod 0640 "$ENV_FILE"

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
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

# Another program on the port would keep the server from starting.
if ! systemctl is-active --quiet "$NAME" && command -v ss >/dev/null && ss -ltnH "sport = :$port" | grep -q .; then
  die "端口 $port 已被占用，用 --port 换一个。" "port $port is taken; choose another with --port."
fi
install -m 0755 "$tmp/$NAME" "$BIN.new" && mv -f "$BIN.new" "$BIN"
systemctl daemon-reload
systemctl enable --quiet "$NAME"
systemctl restart "$NAME"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 \
  || { journalctl -u "$NAME" -n 20 --no-pager >&2 || true; die "服务没有启动，上面是日志。" "the server did not start; its log is above."; }
msg "folio-server 已运行（127.0.0.1:$port）。" "folio-server is running (127.0.0.1:$port)."

# ---- Caddy ----
block() {
  cat <<EOF
$BEGIN_MARK
$domain {
	reverse_proxy 127.0.0.1:$port
}
$END_MARK
EOF
}

install_caddy() {
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*)
      apt-get update -qq
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg > /dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy > /dev/null ;;
    *" fedora "*|*" rhel "*|*" centos "*)
      dnf install -y -q 'dnf-command(copr)' && dnf copr enable -y -q @caddy/caddy && dnf install -y -q caddy ;;
    *) return 1 ;;
  esac
}

proxy_ready=0
if [[ $caddy -eq 1 ]]; then
  step "配置 Caddy（HTTPS）" "Setting up Caddy (HTTPS)"
  if ! command -v caddy >/dev/null; then
    if ask "没有安装 Caddy。现在安装吗？它会自动申请和续期 HTTPS 证书。" "Caddy is not installed. Install it now? It gets and renews the HTTPS certificate."; then
      install_caddy || die "不知道怎么在这个系统上装 Caddy，请按 https://caddyserver.com/docs/install 安装后重新运行。" \
                           "cannot install Caddy on this system; install it (https://caddyserver.com/docs/install) and run again."
      installed_caddy=1
    fi
  fi
  if command -v caddy >/dev/null; then
    if ! caddy_managed; then
      warn "Caddy 不是用 $CADDYFILE 管理的（比如跑在 Docker 里），请把下面的站点加到你的配置里：" \
           "Caddy is not run from $CADDYFILE (Docker, perhaps); add this site to your configuration:"
      block
    else
      current="$(cat "$CADDYFILE")"
      if [[ $installed_caddy -eq 1 ]]; then
        # A new Caddy only serves its welcome page: ours replaces it.
        new="$( { [[ -n "$email" ]] && printf '{\n\temail %s\n}\n\n' "$email"; block; } )"
        do_write=1
      elif grep -qxF "$BEGIN_MARK" "$CADDYFILE"; then
        new="$(printf '%s\n' "$current" | strip_block)"$'\n\n'"$(block)"
        do_write=1
        if [[ "$(printf '%s\n' "$current" | awk -v b="$BEGIN_MARK" '$0==b{getline; print $1; exit}')" != "$domain" ]]; then
          ask "把 Caddy 里 folio-server 的站点改为 $domain？" "Change the folio-server site in Caddy to $domain?" || do_write=0
        fi
      elif grep -Eq "(^|[[:space:],])(https?://)?${domain//./\\.}([[:space:],:{]|$)" "$CADDYFILE"; then
        warn "$CADDYFILE 里已经有 $domain 的站点，没有改动。请确认它代理到 127.0.0.1:$port：" \
             "$CADDYFILE already has a site for $domain; left as it is. Make sure it proxies to 127.0.0.1:$port:"
        block
        do_write=0; proxy_ready=1
      else
        do_write=0
        if ask "Caddy 已安装。在 $CADDYFILE 里为 $domain 添加站点？（原文件会备份）" "Caddy is installed. Add a site for $domain to $CADDYFILE? (the file is backed up first)"; then
          new="$current"$'\n\n'"$(block)"
          do_write=1
        else
          msg "没有改动 Caddy。需要时把这段加进去：" "Caddy left alone. When you want it, add:"
          block
        fi
      fi
      if [[ $do_write -eq 1 ]]; then
        backup="$CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
        cp "$CADDYFILE" "$backup"
        printf '%s\n' "$new" > "$CADDYFILE.new"
        if caddy validate --config "$CADDYFILE.new" --adapter caddyfile > "$tmp/validate.log" 2>&1; then
          # Written over in place: the file keeps its owner and mode (Caddy runs
          # as its own user and must still read it).
          cat "$CADDYFILE.new" > "$CADDYFILE"; rm -f "$CADDYFILE.new"
          caddy fmt --overwrite "$CADDYFILE" 2>/dev/null || true
          reload_caddy
          proxy_ready=1
          msg "已更新 $CADDYFILE（备份：$backup）。" "Updated $CADDYFILE (backup: $backup)."
        else
          rm -f "$CADDYFILE.new"
          cat "$tmp/validate.log" >&2
          die "新的 Caddy 配置没有通过检查，原文件没有改动。" "the new Caddy configuration did not validate; the file is unchanged."
        fi
      fi
    fi
  fi

  # Certificates need ports 80 and 443 open.
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    if ask "ufw 防火墙已开启。放行 80 和 443 端口？" "The ufw firewall is on. Allow ports 80 and 443?"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    if ask "firewalld 已开启。放行 http 和 https？" "firewalld is on. Allow http and https?"; then
      firewall-cmd --quiet --permanent --add-service=http --add-service=https && firewall-cmd --quiet --reload
    fi
  fi
fi

# ---- check from outside ----
url="https://$domain"
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
    warn "还访问不到 $url/health。检查域名解析、云服务商安全组的 80/443 端口，以及 journalctl -u caddy。" \
         "$url/health is not reachable yet. Check the DNS record, ports 80/443 in your provider's firewall, and journalctl -u caddy."
  fi
fi

# ---- what to enter in the app ----
printf '\n'
msg "完成。在 Folio 里打开 设置 → 同步 → 新建同步空间，填写：" "Done. In Folio, open Settings → Sync → New sync space and enter:"
printf '  %-12s %s\n' "$(msg "服务器" "Server")" "$url"
printf '  %-12s %s\n' "$(msg "服务器令牌" "Token")" "$token"
if [[ $new_token -eq 0 ]]; then msg "（令牌沿用之前的，已加入的设备不受影响）" "(the token is the same as before; devices already syncing keep working)"; fi
msg "令牌保存在 $ENV_FILE。再次运行本脚本即可升级。" "The token is kept in $ENV_FILE. Run this script again to upgrade."
[[ $reachable -eq 1 || $proxy_ready -eq 0 ]] || exit 1
