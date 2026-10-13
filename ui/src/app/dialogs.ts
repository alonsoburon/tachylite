// Small promise-based dialogs built on the public Modal class.
import { Modal, Setting, type App } from "../obsidian";

export interface PromptOptions {
  title: string;
  value?: string;
  placeholder?: string;
  cta?: string;
  /** Return an error message to block submission. */
  validate?: (value: string) => string | null;
  /** Select only the part of the value before the last dot (file renames). */
  selectBasename?: boolean;
}

/** Ask for one line of text. Resolves null when dismissed. */
export function promptText(app: App, o: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const m = new Modal(app);
    m.modalEl.addClass("mod-prompt-text");
    m.setTitle(o.title);
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; resolve(v); m.close(); };
    const input = m.contentEl.createEl("input", { type: "text", cls: "prompt-input-field", attr: { spellcheck: "false" } });
    input.value = o.value ?? "";
    if (o.placeholder) input.placeholder = o.placeholder;
    const err = m.contentEl.createDiv({ cls: "prompt-error mod-hidden" });
    const submit = () => {
      const v = input.value.trim();
      const bad = o.validate?.(v) ?? null;
      if (bad) { err.setText(bad); err.removeClass("mod-hidden"); return; }
      finish(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    });
    const bar = m.contentEl.createDiv({ cls: "modal-button-container" });
    bar.createEl("button", { cls: "mod-cta", text: o.cta ?? "OK" }).addEventListener("click", submit);
    bar.createEl("button", { text: "Cancel" }).addEventListener("click", () => finish(null));
    m.setCloseCallback(() => finish(null));
    m.open();
    setTimeout(() => {
      input.focus();
      if (o.selectBasename) { const dot = input.value.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : input.value.length); }
      else input.select();
    }, 0);
  });
}

export interface ConfirmOptions { title: string; message: string; cta?: string; warning?: boolean; cancel?: string }

export function confirmDialog(app: App, o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const m = new Modal(app);
    m.modalEl.addClass("mod-confirmation");
    m.setTitle(o.title);
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; resolve(v); m.close(); };
    m.contentEl.createEl("p", { text: o.message });
    const bar = m.contentEl.createDiv({ cls: "modal-button-container" });
    const ok = bar.createEl("button", { cls: o.warning ? "mod-warning" : "mod-cta", text: o.cta ?? "OK" });
    ok.addEventListener("click", () => finish(true));
    bar.createEl("button", { text: o.cancel ?? "Cancel" }).addEventListener("click", () => finish(false));
    m.setCloseCallback(() => finish(false));
    m.open();
    setTimeout(() => ok.focus(), 0);
  });
}

export { Setting };
