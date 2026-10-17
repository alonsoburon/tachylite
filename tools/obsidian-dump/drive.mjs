// Drives a running Obsidian (started with --remote-debugging-port) through the Chrome DevTools protocol: turns on community
// plugins, enables the dump plugin and runs its command. Used by scripts/obsidian-reference.sh. Node 22+ (global WebSocket).
const port = process.argv[2];
const pluginId = "tachylite-reference-dump";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 300; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page" && /app:\/\/obsidian|index\.html|obsidian/i.test(t.url + t.title));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Obsidian's debugging port never showed a page");
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cannot connect to the page")); });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
async function run(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  return r.result?.result?.value;
}

// Wait for the workspace.
for (let i = 0; i < 300; i++) {
  if (await run("!!(window.app && app.workspace && app.workspace.layoutReady)").catch(() => false)) break;
  await sleep(200);
}
// Exploration mode: OBSIDIAN_EVAL=/path/to/file.js evaluates that file's JavaScript inside Obsidian and prints the result.
if (process.env.OBSIDIAN_EVAL) {
  const fs = await import("node:fs");
  console.log(JSON.stringify(await run(fs.readFileSync(process.env.OBSIDIAN_EVAL, "utf8")), null, 2));
  ws.close();
  process.exit(0);
}
console.log("app:", await run("(navigator.userAgent.match(/obsidian\\/[\\d.]+/i) || [navigator.userAgent])[0]"));
await run(`(async () => {
  await app.plugins.setEnable(true);
  await app.plugins.loadManifests();
  await app.plugins.enablePlugin(${JSON.stringify(pluginId)});
  return !!app.plugins.plugins[${JSON.stringify(pluginId)}];
})()`).then((ok) => { if (!ok) throw new Error("the dump plugin did not load"); });
console.log("plugin enabled");
await sleep(1500);
await run(`app.commands.executeCommandById("${pluginId}:dump-reference-data")`);
console.log("dump command executed");
ws.close();
