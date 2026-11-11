#!/usr/bin/env bash
# ALWAYS-ON CLAUDE (Nirav, 2026-11-06): a small Ubuntu 24.04 server that keeps the review Claude listening, so @Claude,
# Go and Stop work while every Mac is closed. Run once, as root, on a fresh server:
#   curl -fsSL https://raw.githubusercontent.com/niravbhatt1317/review-mode/main/server/setup.sh | sudo bash
# It installs the tools and the `review-server` command, and needs no secret. Then:
#   sudo review-server secrets   (the Claude token and the GitHub token, typed in, never shown)
#   sudo review-server start     (clones the console, starts Claude; the first time, `review-server attach` once)
# server/README.md is the short page: checking, restarting, tokens, disk, cost.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it as root: sudo bash setup.sh"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
RAW="${REVIEW_RAW:-https://raw.githubusercontent.com/niravbhatt1317/review-mode/main/server}"
say() { printf '\n== %s\n' "$*"; }

say "System packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq git tmux curl ca-certificates gnupg jq ufw unattended-upgrades \
  fonts-noto-core fonts-noto-color-emoji fonts-liberation

say "Security updates by themselves, a restart at 03:30 India time when one needs it"
cat >/etc/apt/apt.conf.d/52review-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "22:00";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

say "Firewall: only SSH comes in"
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null

say "SSH: keys only, once a key is in place (never locks you out)"
if [ -s /home/ubuntu/.ssh/authorized_keys ] || [ -s /root/.ssh/authorized_keys ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/01-review-keys-only.conf # first: sshd keeps the first value it reads (cloud-init's 50-… may say yes)
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
else
  echo "No SSH key on this server yet: passwords still work. Add your key, then run this script again."
fi

say "Swap (2 GB), so a build never runs out of memory"
if ! swapon --show | grep -q /swapfile; then
  if { [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }; } && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  else
    echo "No swap here (fine: 8 GB is enough)."
  fi
fi

say "Node 24"
if ! node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -yq nodejs
fi

say "Google Chrome (the before and after pictures)"
if ! command -v google-chrome >/dev/null; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" >/etc/apt/sources.list.d/google-chrome.list
  apt-get update -q && apt-get install -yq google-chrome-stable
fi

say "GitHub CLI"
if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list
  apt-get update -q && apt-get install -yq gh
fi

say "The review user (Claude runs as it, never as root)"
id review >/dev/null 2>&1 || useradd -m -s /bin/bash review
install -d -o review -g review /home/review/.config # the review user's own: Chrome keeps its folder here (root-owned, it crashed)
install -d -m 700 -o review -g review /home/review/.config/review

say "Claude Code"
runuser -l review -c 'command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash' >/dev/null
grep -q '.local/bin' /home/review/.profile || echo 'export PATH="$HOME/.local/bin:$PATH"' >>/home/review/.profile

say "The review-server command"
curl -fsSL "$RAW/review-server" -o /usr/local/bin/review-server
chmod 755 /usr/local/bin/review-server

say "Claude as a service (inside tmux, so you can look in), and the nightly update"
cat >/etc/systemd/system/review-claude.service <<'EOF'
[Unit]
Description=Review mode Claude (always on)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=review
WorkingDirectory=/home/review
ExecStart=/usr/bin/tmux new-session -d -s claude -x 200 -y 50 /usr/local/bin/review-server run
ExecStop=/usr/bin/tmux kill-session -t claude
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/review-update.service <<'EOF'
[Unit]
Description=Review mode nightly update

[Service]
Type=oneshot
ExecStart=/usr/local/bin/review-server update --nightly
EOF
cat >/etc/systemd/system/review-update.timer <<'EOF'
[Unit]
Description=Review mode nightly update, 03:00 India time

[Timer]
OnCalendar=*-*-* 21:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable review-update.timer >/dev/null 2>&1
systemctl start review-update.timer

say "Done"
cat <<'EOF'
Next:
  sudo review-server secrets    the Claude token (claude setup-token on your Mac) and the GitHub token
  sudo review-server start      clones the console and starts Claude
  sudo review-server attach     the first time only: accept Claude's questions, then Ctrl-b d to leave it running
EOF
