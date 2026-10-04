#!/usr/bin/env bash
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/rakazo}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/rakazo /tmp/.X11-unix /tmp/fluxbox-home
export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"
# The home is a mount, so the image cannot ship ~/.zshrc. Seed one that loads the image defaults;
# it also keeps zsh from opening its first-run wizard. An existing ~/.zshrc is left as is.
[[ -e "$AGENT_HOME/.zshrc" ]] || printf '%s\n' 'source /etc/rakazo/zshrc' >"$AGENT_HOME/.zshrc"
# OpenCode reads global skills from ~/.config/opencode/skills/**/SKILL.md and follows symlinks
# (Glob.scan symlink: true), so one link to the read-only mount is enough. A user may replace it
# with a directory of their own; an existing entry is left as is.
mkdir -p "$AGENT_HOME/.config/opencode"
[[ -e "$AGENT_HOME/.config/opencode/skills" || -L "$AGENT_HOME/.config/opencode/skills" ]] \
  || ln -s /managed-skills/computer "$AGENT_HOME/.config/opencode/skills"

if [[ -n "${RAKAZO_COMPUTER_CONTROL_TOKEN:-}" ]]; then
  /usr/local/bin/rakazo-computer-control >/tmp/rakazo/control.log 2>&1 &
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb :1 -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >/tmp/rakazo/xvfb.log 2>&1 &
XVFB_PID=$!

ready=0
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Xvfb failed to start" >&2
  cat /tmp/rakazo/xvfb.log >&2 || true
  exit 1
fi

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
fi

xsetroot -solid "#111113" >/dev/null 2>&1 || true
mkdir -p /tmp/fluxbox-home/.fluxbox
cp /etc/rakazo/fluxbox/init /tmp/fluxbox-home/.fluxbox/init
cp /etc/rakazo/fluxbox/apps /tmp/fluxbox-home/.fluxbox/apps 2>/dev/null || true
cp /etc/rakazo/fluxbox/menu /tmp/fluxbox-home/.fluxbox/menu 2>/dev/null || true
cat > /tmp/fluxbox-home/.fluxbox/startup <<'EOF'
#!/bin/sh
xsetroot -solid "#111113"
mkdir -p "$HOME/.config/plank/dock1/launchers"
cp /etc/rakazo/plank/dock1/launchers/*.dockitem "$HOME/.config/plank/dock1/launchers/"
dconf write /net/launchpad/plank/docks/dock1/hide-mode 0
dconf write /net/launchpad/plank/docks/dock1/icon-size 48
dconf write /net/launchpad/plank/docks/dock1/dock-items "['rakazo-browser.dockitem', 'rakazo-files.dockitem', 'rakazo-terminal.dockitem']"
dconf write /net/launchpad/plank/docks/dock1/lock-items true
dconf write /net/launchpad/plank/docks/dock1/zoom-enabled true
dconf write /net/launchpad/plank/docks/dock1/zoom-percent 150
dconf write /net/launchpad/plank/docks/dock1/theme "'Default'"
plank &
exec fluxbox -rc /tmp/fluxbox-home/.fluxbox/init
EOF
chmod +x /tmp/fluxbox-home/.fluxbox/startup
HOME=/tmp/fluxbox-home /tmp/fluxbox-home/.fluxbox/startup >/tmp/rakazo/fluxbox.log 2>&1 &

register_browser_handler() {
  local mime="$1"
  if ! xdg-mime default rakazo-browser.desktop "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "rakazo-browser.desktop" ]]; then
    echo "failed to register rakazo-browser for $mime" >&2
    exit 1
  fi
}
register_browser_handler x-scheme-handler/http
register_browser_handler x-scheme-handler/https
register_browser_handler text/html
register_handler() {
  local desktop="$1" mime="$2"
  if [[ ! -f "/usr/share/applications/$desktop" ]] \
    || ! xdg-mime default "$desktop" "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "$desktop" ]]; then
    echo "failed to register $desktop for $mime" >&2
    exit 1
  fi
}
register_handler pcmanfm.desktop inode/directory
for mime in \
  application/vnd.openxmlformats-officedocument.wordprocessingml.document \
  application/msword application/vnd.oasis.opendocument.text application/rtf text/rtf; do
  register_handler libreoffice-writer.desktop "$mime"
done
for mime in \
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet \
  application/vnd.ms-excel application/vnd.oasis.opendocument.spreadsheet text/csv; do
  register_handler libreoffice-calc.desktop "$mime"
done
for mime in \
  application/vnd.openxmlformats-officedocument.presentationml.presentation \
  application/vnd.ms-powerpoint application/vnd.oasis.opendocument.presentation; do
  register_handler libreoffice-impress.desktop "$mime"
done
if ! xdg-settings set default-web-browser rakazo-browser.desktop >/dev/null 2>&1 \
  || [[ "$(xdg-settings get default-web-browser 2>/dev/null || true)" != "rakazo-browser.desktop" ]]; then
  echo "failed to set default web browser to rakazo-browser" >&2
  exit 1
fi

x11vnc -display :1 -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport 5900 -xkb -ncache 0 >/tmp/rakazo/x11vnc.log 2>&1 &

NOVNC_ROOT=/usr/share/novnc
if [[ ! -d "$NOVNC_ROOT" ]]; then
  echo "noVNC is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/embed.html" ]]; then
  echo "noVNC embed.html is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/clipboard-bridge.js" ]]; then
  echo "noVNC clipboard-bridge.js is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/mobile-keyboard.js" ]]; then
  echo "noVNC mobile-keyboard.js is missing from the computer image" >&2
  exit 1
fi
websockify --heartbeat=30 --web="$NOVNC_ROOT" --token-plugin=TokenFile --token-source=/tmp/rakazo/view-target-1 0.0.0.0:6080 >/tmp/rakazo/novnc.log 2>&1 &

while kill -0 "$XVFB_PID" 2>/dev/null; do
  sleep 2
done
echo "Xvfb exited" >&2
exit 1
