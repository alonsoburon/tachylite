# Shared by scripts/smoke.sh and scripts/screenshot.sh: run the app fully isolated from the user's session.
# Source this file, then call `isolated_reexec "$0" "$@"` first thing, and `isolated_setup` after it.
#
# GTK follows GDK_BACKEND, and many Wayland sessions export GDK_BACKEND=wayland, which opens the window on the real
# desktop even with DISPLAY unset. So: a private X server (xvfb-run), GDK_BACKEND=x11, no Wayland socket, no session
# bus, private config/data/runtime dirs (the app records recent vaults in the real config dir), and single-instance
# forwarding off, so a Tachylite that is already running is never contacted.

isolated_reexec() {
  if [ -z "${ISOLATED_INNER:-}" ]; then
    unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
    exec env ISOLATED_INNER=1 GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 xvfb-run -a -s "-screen 0 1280x800x24" "$@"
  fi
}

# Sets $work (a fresh temp dir) and exports the isolated environment. Starts a window manager; call isolated_cleanup
# from your EXIT trap.
isolated_setup() {
  work="$(mktemp -d)"
  export XDG_RUNTIME_DIR="$work/run" XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache"
  mkdir -m 700 "$work/run"
  mkdir -p "$work/config" "$work/data" "$work/cache"
  export GDK_BACKEND=x11 TACHYLITE_SINGLE_INSTANCE=0 WEBKIT_DISABLE_COMPOSITING_MODE=1
  unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
  openbox >/dev/null 2>&1 &
  isolated_wm=$!
}

isolated_cleanup() {
  kill "${app:-0}" "${isolated_wm:-0}" 2>/dev/null || true
}
