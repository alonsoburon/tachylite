import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/editor/htmlPaste";

describe("htmlToMarkdown", () => {
  it("converts headings, emphasis, links and lists", () => {
    const md = htmlToMarkdown('<h2>Title</h2><p>Some <strong>bold</strong> and <em>it</em> with <a href="https://x.dev/a b">link</a>.</p><ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul><ol start="3"><li>c</li></ol>');
    expect(md).toBe("## Title\n\nSome **bold** and *it* with [link](https://x.dev/a%20b).\n\n- one\n\t- deep\n- two\n\n3. c");
  });
  it("converts code, quotes, rules, images and tables", () => {
    const md = htmlToMarkdown('<pre><code>a\nb</code></pre><blockquote><p>q</p></blockquote><hr><p><img src="p.png" alt="pic"> <code>x</code></p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table>');
    expect(md).toBe("```\na\nb\n```\n\n> q\n\n---\n\n![pic](p.png) `x`\n\n| A | B |\n| --- | --- |\n| 1 | 2\\|3 |");
  });
  it("converts task checkboxes and strikethrough, drops scripts and styles", () => {
    expect(htmlToMarkdown('<style>p{}</style><script>x()</script><ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo <del>no</del></li></ul>'))
      .toBe("- [x] done\n- [ ] todo ~~no~~");
  });
  it("returns null when the HTML is just the plain text", () => {
    expect(htmlToMarkdown("<span>hello  world</span>", "hello world")).toBeNull();
    expect(htmlToMarkdown("", "x")).toBeNull();
    expect(htmlToMarkdown("<p>hi</p>", "something else")).toBe("hi");
  });
});
