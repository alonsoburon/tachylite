// Core plugin "Audio recorder", with a fake recorder in place of the microphone.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { audioExtension, setRecordingBackend } from "../src/app/core/audioRecorder";

let v: FakeVault;
let session: Session | null = null;
let restore: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "before after\n" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { restore?.(); restore = null; await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function boot() {
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  const app = session.app;
  await app.internalPlugins.getPluginById("audio-recorder")!.enable();
  await app.workspace.openLinkText("Note", "", false);
  const view = app.workspace.activeLeaf!.view as any;
  await vi.waitFor(() => expect(view.file?.basename).toBe("Note"));
  view.editor.focus = () => {};
  return { app, view };
}
const fakeBackend = (opts: { mime?: string; failStart?: boolean } = {}) => {
  const log: string[] = [];
  restore = setRecordingBackend({
    async start() {
      if (opts.failStart) throw new Error("Permission denied");
      log.push("start");
      return { async stop() { log.push("stop"); return { data: new Blob(["AUDIO-BYTES"], { type: opts.mime ?? "audio/webm;codecs=opus" }), mimeType: opts.mime ?? "audio/webm;codecs=opus" }; } };
    },
  });
  return log;
};
const status = () => document.querySelector(".status-bar-item.plugin-audio-recorder");
const notices = () => [...document.querySelectorAll(".notice")].map((n) => n.textContent);

describe("audioExtension", () => {
  it("maps MediaRecorder mime types to file extensions", () => {
    expect([audioExtension("audio/webm;codecs=opus"), audioExtension("audio/ogg"), audioExtension("audio/mp4"), audioExtension("audio/wav"), audioExtension("audio/mpeg"), audioExtension("")]).toEqual(["webm", "ogg", "m4a", "wav", "mp3", "webm"]);
  });
});

describe("audio recorder", () => {
  it("is off by default; enabling adds the ribbon button and the start command only", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    const app = session.app;
    expect(app.commands.findCommand("audio-recorder:start")).toBeUndefined();
    await app.internalPlugins.getPluginById("audio-recorder")!.enable();
    expect(document.querySelector('.side-dock-ribbon-action[aria-label="Record audio"]')).toBeTruthy();
    expect(app.commands.executeCommandById("audio-recorder:stop")).toBe(false); // nothing is recording
    await app.internalPlugins.getPluginById("audio-recorder")!.disable();
    expect(app.commands.findCommand("audio-recorder:start")).toBeUndefined();
  });

  it("records, shows a status indicator, then saves the clip as an attachment and embeds it at the cursor", async () => {
    const log = fakeBackend();
    const { app, view } = await boot();
    view.editor.setCursor({ line: 0, ch: 6 });
    expect(app.commands.executeCommandById("audio-recorder:start")).toBe(true);
    await vi.waitFor(() => expect(status()?.textContent).toMatch(/^● Recording 00:0\d$/));
    expect(app.commands.executeCommandById("audio-recorder:start")).toBe(false); // already recording
    expect(app.commands.executeCommandById("audio-recorder:stop")).toBe(true);
    await vi.waitFor(() => expect(view.editor.getValue()).toMatch(/^before!\[\[Recording \d{14}\.webm\]\] after\n$/));
    expect(status()).toBeNull();
    expect(log).toEqual(["start", "stop"]);
    const name = /Recording \d{14}\.webm/.exec(view.editor.getValue())![0];
    expect(fs.readFileSync(path.join(v.root, name), "utf8")).toBe("AUDIO-BYTES");
    expect(notices().some((n) => n?.includes(name))).toBe(true);
  });

  it("uses the recorder's format for the file extension and the vault's attachment folder", async () => {
    fakeBackend({ mime: "audio/ogg" });
    const { app, view } = await boot();
    app.vault.setConfig("attachmentFolderPath", "audio");
    app.commands.executeCommandById("audio-recorder:start");
    await vi.waitFor(() => expect(status()).toBeTruthy());
    app.commands.executeCommandById("audio-recorder:stop");
    await vi.waitFor(() => expect(view.editor.getValue()).toMatch(/!\[\[Recording \d{14}\.ogg\]\]/));
    const name = /Recording \d{14}\.ogg/.exec(view.editor.getValue())![0];
    expect(fs.existsSync(path.join(v.root, "audio", name))).toBe(true);
  });

  it("tells you when the microphone cannot be started and stays idle", async () => {
    fakeBackend({ failStart: true });
    const { app } = await boot();
    app.commands.executeCommandById("audio-recorder:start");
    await vi.waitFor(() => expect(notices().some((n) => n?.includes("Permission denied"))).toBe(true));
    expect(status()).toBeNull();
    expect(app.commands.executeCommandById("audio-recorder:stop")).toBe(false);
  });

  it("turning the plugin off mid-recording stops it and removes the indicator", async () => {
    const log = fakeBackend();
    const { app } = await boot();
    app.commands.executeCommandById("audio-recorder:start");
    await vi.waitFor(() => expect(status()).toBeTruthy());
    await app.internalPlugins.getPluginById("audio-recorder")!.disable();
    expect(status()).toBeNull();
    await vi.waitFor(() => expect(log).toEqual(["start", "stop"]));
  });
});
