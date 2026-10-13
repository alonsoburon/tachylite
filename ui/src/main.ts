import "./styles";
import { boot, getSession } from "./app/boot";
import { ipc, listen } from "./ipc";
import { installFrontendLog } from "./app/log";
import "./obsidian";

installFrontendLog();
void listen("close-requested", () => {
  void (getSession()?.shell.flushAsync() ?? Promise.resolve()).catch((e) => console.error(e)).finally(() => { void ipc.quitApp(); });
});
const host = document.getElementById("app");
if (!host) throw new Error("#app missing");
document.body.classList.add("theme-dark", "app-body");
boot(host).catch((e) => {
  console.error("boot failed", e);
  host.textContent = `Tachylite failed to start: ${(e as Error).message ?? e}`;
});
