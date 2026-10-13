// Popout windows in tests: a second happy-dom Window stands in for the WindowProxy that window.open returns in
// the app (a separate document; happy-dom shares constructors between windows, so realms are only simulated).
import { Window } from "happy-dom";
import { setPopoutOpener } from "../../src/app/popout";

export interface FakePopouts { opened: { url: string; name: string; win: Window }[]; restore(): Promise<void> }

export function installFakePopouts(): FakePopouts {
  const opened: FakePopouts["opened"] = [];
  setPopoutOpener((url, name) => {
    const win = new Window({ url: "about:blank", width: 800, height: 600 });
    opened.push({ url, name, win });
    return win as unknown as globalThis.Window;
  });
  return {
    opened,
    async restore() {
      setPopoutOpener(null);
      for (const o of opened.splice(0)) await o.win.happyDOM.close();
    },
  };
}
