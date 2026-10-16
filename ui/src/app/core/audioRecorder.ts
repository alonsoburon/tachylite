// Core plugin "Audio recorder": record from the microphone, save the clip as an attachment and embed it in the note.
// The media layer (`recordingBackend`) is swappable so the flow can be tested without a microphone.
import moment from "moment";
import { MarkdownView, Notice, type App } from "../../obsidian";
import { saveAttachment } from "../bridge";
import { coreRibbon } from "./options";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";

const ID = "audio-recorder";

/** A running recording: `stop()` resolves with the audio when the recorder has flushed. */
export interface Recording { stop(): Promise<{ data: Blob; mimeType: string }> }
export interface RecordingBackend { start(): Promise<Recording> }

/** The microphone through getUserMedia + MediaRecorder. */
export const microphoneBackend: RecordingBackend = {
  async start() {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Audio recording is not available in this window.");
    const stream = await media.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.start(1000);
    return {
      stop: () => new Promise((resolve, reject) => {
        recorder.addEventListener("stop", () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve({ data: new Blob(chunks, { type: recorder.mimeType }), mimeType: recorder.mimeType });
        }, { once: true });
        recorder.addEventListener("error", () => reject(new Error("The recording failed.")), { once: true });
        recorder.stop();
      }),
    };
  },
};

let backend: RecordingBackend = microphoneBackend;
/** Replace the media layer (tests). Returns a function that restores the previous one. */
export function setRecordingBackend(b: RecordingBackend): () => void { const prev = backend; backend = b; return () => { backend = prev; }; }

/** File extension for a MediaRecorder mime type. */
export function audioExtension(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

export interface RecorderState { recording: boolean; seconds: number }

export class AudioRecorder {
  private current: Recording | null = null;
  private startedAt = 0;
  private timer = 0;
  private statusEl: HTMLElement | null = null;
  constructor(private app: App) {}

  get recording(): boolean { return this.current !== null; }

  private renderStatus(): void {
    if (!this.statusEl) return;
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    this.statusEl.setText(`● Recording ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
  }

  async start(): Promise<boolean> {
    if (this.current) return false;
    try { this.current = await backend.start(); }
    catch (e) { new Notice(`Could not start recording: ${(e as Error)?.message ?? e}`); return false; }
    this.startedAt = Date.now();
    this.statusEl = this.app.statusBarEl.createDiv({ cls: "status-bar-item plugin-audio-recorder mod-recording" });
    this.renderStatus();
    this.timer = window.setInterval(() => this.renderStatus(), 1000);
    new Notice("Recording started");
    return true;
  }

  /** Stop, save the clip as an attachment (named `Recording YYYYMMDDHHmmss.<ext>`) and embed it in the open note. */
  async stop(): Promise<string | null> {
    const rec = this.current;
    if (!rec) return null;
    this.current = null;
    window.clearInterval(this.timer);
    this.statusEl?.remove(); this.statusEl = null;
    try {
      const { data, mimeType } = await rec.stop();
      const name = `Recording ${moment().format("YYYYMMDDHHmmss")}.${audioExtension(mimeType)}`;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const link = await saveAttachment(this.app, new File([data], name, { type: mimeType }), view?.file?.path ?? "", false);
      if (view) view.editor.replaceSelection(link);
      new Notice(`Saved ${name}`);
      return link;
    } catch (e) {
      new Notice(`Could not save the recording: ${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.statusEl?.remove(); this.statusEl = null;
    const rec = this.current; this.current = null;
    void rec?.stop().catch(() => {}); // release the microphone
  }
}

export const audioRecorder: CoreModule = {
  id: ID,
  install(app) {
    return whileCoreEnabled(app, ID, () => {
      const recorder = new AudioRecorder(app);
      (app as any).audioRecorder = recorder;
      const offs = [
        coreRibbon(app, ID, "lucide-mic", "Record audio", () => { void (recorder.recording ? recorder.stop() : recorder.start()); }),
        addCommand(app, { id: "audio-recorder:start", name: "Audio recorder: Start recording audio", icon: "lucide-mic", checkCallback: (checking) => {
          if (recorder.recording) return false;
          if (!checking) void recorder.start();
          return true;
        } }),
        addCommand(app, { id: "audio-recorder:stop", name: "Audio recorder: Stop recording audio", icon: "lucide-square", checkCallback: (checking) => {
          if (!recorder.recording) return false;
          if (!checking) void recorder.stop();
          return true;
        } }),
      ];
      return () => { offs.forEach((f) => f()); recorder.dispose(); delete (app as any).audioRecorder; };
    });
  },
};
