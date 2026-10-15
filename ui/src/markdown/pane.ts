/** Where a link click opens: plain click = same tab; Ctrl/Cmd or middle button = new tab, + Alt = split, + Alt + Shift = window. */
export function paneFor(e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; button?: number }): false | "tab" | "split" | "window" {
  if (!(e.ctrlKey || e.metaKey || e.button === 1)) return false;
  if (e.altKey && e.shiftKey) return "window";
  return e.altKey ? "split" : "tab";
}
