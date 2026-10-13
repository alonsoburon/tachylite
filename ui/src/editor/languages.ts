// Languages for fenced code blocks, shared by the editor (nested parsing) and the reading view (highlight.ts).
// lang-markdown already bundles lang-html (and with it the CSS and JavaScript parsers), so those load statically:
// a dynamic import() of a module that is also imported statically does not split it out of the bundle (and Vite
// warns). Everything else is a lazy chunk, loaded the first time a block in that language is seen. We keep our own
// list instead of @codemirror/language-data for that reason (it dynamically imports the static three).
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";

const legacy = (p: Promise<StreamParser<unknown>>) => p.then((m) => new LanguageSupport(StreamLanguage.define(m)));
const lazy = (name: string, alias: string[], load: () => Promise<LanguageSupport>) => LanguageDescription.of({ name, alias, load });

/** Fence info -> language. Names/aliases are matched case-insensitively (`LanguageDescription.matchLanguageName`). */
export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: "javascript", alias: ["js", "jsx", "mjs", "cjs", "dataviewjs"], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: "typescript", alias: ["ts", "tsx", "mts", "cts"], support: javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: "css", alias: ["scss", "less"], support: css() }),
  LanguageDescription.of({ name: "html", alias: ["htm", "svg", "vue", "xhtml"], support: html() }),
  lazy("json", ["json5", "jsonc", "canvas"], () => import("@codemirror/lang-json").then((m) => m.json())),
  lazy("python", ["py", "py3", "python3"], () => import("@codemirror/lang-python").then((m) => m.python())),
  lazy("rust", ["rs"], () => import("@codemirror/lang-rust").then((m) => m.rust())),
  lazy("cpp", ["c", "c++", "cc", "cxx", "h", "hpp", "objc", "objective-c"], () => import("@codemirror/lang-cpp").then((m) => m.cpp())),
  lazy("java", [], () => import("@codemirror/lang-java").then((m) => m.java())),
  lazy("go", ["golang"], () => import("@codemirror/lang-go").then((m) => m.go())),
  lazy("php", [], () => import("@codemirror/lang-php").then((m) => m.php())),
  lazy("sql", ["mysql", "postgresql", "postgres", "sqlite", "plsql"], () => import("@codemirror/lang-sql").then((m) => m.sql())),
  lazy("yaml", ["yml"], () => import("@codemirror/lang-yaml").then((m) => m.yaml())),
  lazy("xml", ["xsl", "xsd", "plist", "rss"], () => import("@codemirror/lang-xml").then((m) => m.xml())),
  lazy("shell", ["sh", "bash", "zsh", "console", "shellscript", "fish"], () => legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell))),
  lazy("powershell", ["ps1", "pwsh", "ps"], () => legacy(import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell))),
  lazy("ruby", ["rb"], () => legacy(import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby))),
  lazy("lua", [], () => legacy(import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua))),
  lazy("swift", [], () => legacy(import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift))),
  lazy("kotlin", ["kt", "kts"], () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin))),
  lazy("csharp", ["cs", "c#"], () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp))),
  lazy("scala", [], () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala))),
  lazy("dart", [], () => legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart))),
  lazy("diff", ["patch"], () => legacy(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff))),
  lazy("dockerfile", ["docker"], () => legacy(import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile))),
  lazy("toml", [], () => legacy(import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml))),
  lazy("ini", ["properties", "cfg", "conf", "dosini"], () => legacy(import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties))),
  lazy("r", [], () => legacy(import("@codemirror/legacy-modes/mode/r").then((m) => m.r))),
  lazy("perl", ["pl", "pm"], () => legacy(import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl))),
  lazy("haskell", ["hs"], () => legacy(import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell))),
  lazy("julia", ["jl"], () => legacy(import("@codemirror/legacy-modes/mode/julia").then((m) => m.julia))),
  lazy("latex", ["tex", "stex"], () => legacy(import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex))),
];

/** The language for a fence info string (first word), or null. */
export function findCodeLanguage(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s+/)[0] ?? "";
  return name ? LanguageDescription.matchLanguageName(codeLanguages, name, false) : null;
}
