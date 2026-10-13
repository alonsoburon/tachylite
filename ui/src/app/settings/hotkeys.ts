// "Hotkeys" settings tab: searchable command list with chips, capture and reset.
import { Platform, SettingTab, Setting, type App, type Command, type Hotkey, type Modifier } from "../../obsidian";
import { normalizeKey } from "../../obsidian/events";

const KEY_NAMES: Record<string, string> = {
  " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc", Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
};

export function prettyHotkey(h: Hotkey): string {
  const mods = h.modifiers.map((m) => {
    switch (m) {
      case "Mod": return Platform.isMacOS ? "Cmd" : "Ctrl";
      case "Meta": return Platform.isMacOS ? "Cmd" : Platform.isWin ? "Win" : "Super";
      case "Alt": return Platform.isMacOS ? "Opt" : "Alt";
      default: return m;
    }
  });
  const k = KEY_NAMES[h.key] ?? (h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return [...mods, k].join("+");
}

/** Platform-independent identity of a hotkey, used to detect duplicates. */
export function hotkeyId(h: Hotkey): string {
  const mods = new Set<string>();
  for (const m of h.modifiers) mods.add(m === "Mod" ? (Platform.isMacOS ? "Meta" : "Ctrl") : m);
  return [...mods].sort().join(",") + "|" + normalizeKey(h.key);
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "Hyper", "Super"]);

/** Turn a keydown into a stored Hotkey (null for bare modifier presses). */
export function eventToHotkey(e: KeyboardEvent): Hotkey | null {
  if (MODIFIER_KEYS.has(e.key) || !e.key) return null;
  const modifiers: Modifier[] = [];
  if (Platform.isMacOS) { if (e.metaKey) modifiers.push("Mod"); if (e.ctrlKey) modifiers.push("Ctrl"); }
  else { if (e.ctrlKey) modifiers.push("Mod"); if (e.metaKey) modifiers.push("Meta"); }
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  let key = e.key;
  const code = (e as any).code as string | undefined;
  if (e.shiftKey && code && /^Digit\d$/.test(code)) key = code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  return { modifiers, key };
}

export class HotkeysSettingTab extends SettingTab {
  id = "hotkeys";
  name = "Hotkeys";
  icon = "lucide-keyboard";
  private query = "";
  private customizedOnly = false;
  private listEl: HTMLElement | null = null;
  private stopCapture: (() => void) | null = null;
  constructor(app: App) { super(app); }

  display(): void {
    const el = this.containerEl;
    el.empty();
    this.stopCapture?.();
    const bar = el.createDiv({ cls: "hotkey-search-container" });
    new Setting(bar).setName("Filter commands").addSearch((c) => c.setPlaceholder("Filter commands...").setValue(this.query).onChange((v) => { this.query = v.trim().toLowerCase(); this.renderList(); }));
    new Setting(bar).setName("Customized only").setDesc("Show only commands whose hotkeys you changed.").addToggle((t) => t.setValue(this.customizedOnly).onChange((v) => { this.customizedOnly = v; this.renderList(); }));
    this.listEl = el.createDiv({ cls: "hotkey-list-container" });
    this.renderList();
  }

  hide(): void { this.stopCapture?.(); this.stopCapture = null; }

  private conflicts(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    const hm = this.app.hotkeyManager;
    for (const c of this.app.commands.listCommands()) {
      for (const h of hm.getHotkeys(c.id)) {
        const k = hotkeyId(h);
        const arr = m.get(k) ?? [];
        if (!arr.includes(c.id)) arr.push(c.id);
        m.set(k, arr);
      }
    }
    return m;
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const hm = this.app.hotkeyManager;
    const conflicts = this.conflicts();
    const cmds = this.app.commands.listCommands().slice().sort((a, b) => a.name.localeCompare(b.name));
    let shown = 0;
    for (const cmd of cmds) {
      const custom = cmd.id in hm.customKeys;
      if (this.customizedOnly && !custom) continue;
      if (this.query && !(cmd.name.toLowerCase().includes(this.query) || cmd.id.toLowerCase().includes(this.query))) continue;
      this.row(list, cmd, custom, conflicts);
      shown++;
    }
    if (!shown) list.createDiv({ cls: "hotkey-empty-state", text: "No commands found." });
  }

  private row(list: HTMLElement, cmd: Command, custom: boolean, conflicts: Map<string, string[]>): void {
    const hm = this.app.hotkeyManager;
    const keys = hm.getHotkeys(cmd.id);
    const s = new Setting(list).setName(cmd.name).setClass("hotkey-list-item");
    s.settingEl.dataset.commandId = cmd.id;
    const clash = new Set<string>();
    for (const h of keys) for (const other of conflicts.get(hotkeyId(h)) ?? []) if (other !== cmd.id) clash.add(other);
    if (clash.size) {
      const names = [...clash].map((id) => this.app.commands.commands[id]?.name ?? id);
      s.setDesc(`Used by ${names.join(", ")}`);
      s.descEl.addClass("mod-warning");
    }
    const chips = s.controlEl.createDiv({ cls: "setting-command-hotkeys" });
    for (const h of keys) {
      const chip = chips.createSpan({ cls: "setting-hotkey" });
      chip.createSpan({ cls: "setting-hotkey-label", text: prettyHotkey(h) });
      const x = chip.createSpan({ cls: "setting-hotkey-icon setting-delete-hotkey", attr: { role: "button", "aria-label": "Delete hotkey", tabindex: 0 }, text: "×" });
      x.addEventListener("click", () => {
        hm.setHotkeys(cmd.id, keys.filter((k) => k !== h));
        this.renderList();
      });
    }
    if (!keys.length) chips.createSpan({ cls: "setting-hotkey mod-empty", text: "Blank" });
    s.addExtraButton((b) => b.setIcon("lucide-plus-circle").setTooltip("Customize this command").onClick(() => this.capture(cmd, chips, keys)));
    if (custom) s.addExtraButton((b) => b.setIcon("lucide-rotate-ccw").setTooltip("Restore default").onClick(() => { hm.removeHotkeys(cmd.id); this.renderList(); }));
  }

  /** Listen for the next key combination and add it to the command. Escape cancels. */
  private capture(cmd: Command, chips: HTMLElement, current: Hotkey[]): void {
    this.stopCapture?.();
    const prompt = chips.createSpan({ cls: "setting-hotkey mod-capturing", text: "Press a hotkey..." });
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { stop(); return; }
      const h = eventToHotkey(e);
      if (!h) return;
      stop();
      const id = hotkeyId(h);
      if (!current.some((k) => hotkeyId(k) === id)) this.app.hotkeyManager.setHotkeys(cmd.id, [...current, h]);
      this.renderList();
    };
    const stop = () => {
      prompt.doc.removeEventListener("keydown", onKey, true);
      prompt.remove();
      if (this.stopCapture === stop) this.stopCapture = null;
    };
    prompt.doc.addEventListener("keydown", onKey, true);
    this.stopCapture = stop;
  }
}
