import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Lint-style check (ADR-082): console JSX text must go through t() or <T>. It parses every console
 * .tsx file and reports English left in the markup:
 * - JSX text with letters;
 * - string literals in user-facing props (title, label, placeholder, aria-label, hint, success, …),
 *   including `cond ? "A" : "B"` and template literals;
 * - string literals in JSX children expressions ({busy ? "Saving…" : "Save"});
 * - confirm dialogs' { title, body, confirmLabel } given as literals;
 * - toast.push(tone, "literal");
 * - the rows of a key/value list (<KV items={[["Label", value], …]}>, and `…Items` arrays), label and value.
 * Brand and product names, abbreviations in capitals (CT, ADR, ON AIR), symbols and the text of
 * <code>/<kbd>/<pre>/<samp>/<Mono> elements are allowed.
 */

const SOURCES = import.meta.glob<string>(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true });

/** Screens and components not extracted yet. The check expects English in them (remove a file once it is done). */
const PENDING = new Set<string>([
  "components/SignIn.tsx",
  "screens/Account.tsx",
  "screens/Demos.tsx",
  "screens/HudImages.tsx",
  "screens/Huds.tsx",
  "screens/IconPack.tsx",
  "screens/Maps.tsx",
  "screens/Sponsors.tsx",
  "screens/Training.tsx",
  "screens/demos/PipelinePanels.tsx",
  "screens/hudlib/HudDetails.tsx",
  "screens/huds/Annotations.tsx",
  "screens/huds/Composer.tsx",
  "screens/huds/Cues.tsx",
  "screens/huds/Outputs.tsx",
  "screens/huds/Packages.tsx",
  "screens/maps/CameraWalkthrough.tsx",
  "screens/training/DemoModel.tsx",
  "screens/training/TestBench.tsx",
]);

/** Files that stay English on purpose. */
const OUT_OF_SCOPE: Record<string, string> = {
  "screens/Captain.tsx": "the captains' veto page opens in a browser outside the console; it has no Language setting",
  "screens/testkit.tsx": "test helpers",
  "components/icons.tsx": "the brand badge's alt text is the product name",
};

const USER_PROPS = new Set(["title", "label", "placeholder", "aria-label", "alt", "hint", "subtitle", "summary", "success", "confirmLabel", "disabledReason", "reasonLabel", "description", "emptyLabel", "tooltip", "caption", "heading", "help", "message", "body", "text", "submitLabel", "backLabel", "error"]);
const OBJECT_PROPS = new Set(["title", "body", "confirmLabel", "reasonLabel", "label", "message", "hint"]);

/** Names kept as they are in every language (brands, products, game terms the scene uses in English). */
const ALLOWED = new Set([
  "MatchFrame",
  "MatchFrame Esports",
  "Esports",
  "vMix",
  "TeamSpeak",
  "TeamSpeak 3",
  "Stream Deck",
  "Companion",
  "Bitfocus Companion",
  "Counter-Strike 2",
  "Steam",
  "Windows",
  "GitHub",
  "Discord",
  "Twitch",
  "YouTube",
  "HLTV",
  "FACEIT",
  "Workshop Tools",
  "OpenAPI",
  // The update channels, as the releases on GitHub name them.
  "Stable",
  "Beta",
]);

/**
 * Plain text worth flagging: has a letter, isn't allowed, isn't an abbreviation in capitals (CT,
 * KAST, ON AIR) and isn't code (an API path, a setting key, a launch option: one word with / . or -).
 */
function flagged(text: string): boolean {
  const s = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!/\p{L}/u.test(s) || s.length < 2) return false;
  if (ALLOWED.has(s)) return false;
  if (!/\p{Ll}/u.test(s) && s.length <= 12) return false;
  if (/^[\w./:-]+$/.test(s) && /[./-]/.test(text)) return false;
  return true;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

/** String literals an expression can evaluate to directly (through ?:, ??, ||, &&, parentheses and templates). */
function literals(e: ts.Expression, out: ts.Node[] = []): ts.Node[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push(e);
  else if (ts.isTemplateExpression(e)) out.push(e);
  else if (ts.isParenthesizedExpression(e)) literals(e.expression, out);
  else if (ts.isConditionalExpression(e)) {
    literals(e.whenTrue, out);
    literals(e.whenFalse, out);
  } else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
    if (e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) literals(e.left, out);
    literals(e.right, out);
  }
  return out;
}

function literalText(n: ts.Node): string {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
  return "";
}

const CODE_TAGS = new Set(["code", "kbd", "pre", "samp", "Mono"]);

function scan(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const add = (n: ts.Node, text: string) => {
    if (flagged(text)) out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: text.replace(/\s+/g, " ").trim().slice(0, 80) });
  };
  const visit = (n: ts.Node) => {
    // Text in <code>, <kbd>, <pre>, <samp> and <Mono> is code (a console command, a key, a path), not prose.
    const inCode = (x: ts.Node) => ts.isJsxElement(x.parent) && CODE_TAGS.has(x.parent.openingElement.tagName.getText(sf));
    if (ts.isJsxText(n)) {
      if (!inCode(n)) add(n, n.text);
    }
    else if (ts.isJsxAttribute(n) && USER_PROPS.has(n.name.getText(sf)) && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) add(n.initializer, n.initializer.text);
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) for (const l of literals(n.initializer.expression)) add(l, literalText(l));
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)) && !inCode(n)) {
      for (const l of literals(n.expression)) add(l, literalText(l));
    } else if (ts.isPropertyAssignment(n) && OBJECT_PROPS.has(n.name.getText(sf)) && insideJsxAttribute(n)) {
      for (const l of literals(n.initializer)) add(l, literalText(l));
    } else if (ts.isCallExpression(n) && /(^|\.)push$/.test(n.expression.getText(sf)) && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0]!) && ["ok", "info", "warn", "danger"].includes(n.arguments[0].text)) {
      for (const a of n.arguments.slice(1)) for (const l of literals(a)) add(l, literalText(l));
    }
    // Key/value rows: <KV items={[["Label", value], …]} /> and arrays named …Items (built up with push).
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "items" && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression) kvRows(n.initializer.expression, add);
    else if (ts.isVariableDeclaration(n) && /items$/i.test(n.name.getText(sf)) && n.initializer) kvRows(n.initializer, add);
    else if (ts.isCallExpression(n) && /items\.push$/i.test(n.expression.getText(sf))) for (const a of n.arguments) kvRows(a, add);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The label and the literal value of each [label, value] row under `root`. */
function kvRows(root: ts.Node, add: (n: ts.Node, text: string) => void) {
  const walk = (x: ts.Node) => {
    if (ts.isArrayLiteralExpression(x) && x.elements.length === 2 && (ts.isArrayLiteralExpression(x.parent) || ts.isCallExpression(x.parent))) {
      for (const el of x.elements) if (!ts.isSpreadElement(el)) for (const l of literals(el)) add(l, literalText(l));
    }
    ts.forEachChild(x, walk);
  };
  walk(root);
}

function insideJsxAttribute(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

const files = Object.entries(SOURCES).map(([path, src]) => [path.replace(/^\.\.\//, ""), src] as const);

describe("console text goes through t() (ADR-082)", () => {
  it("finds the console's source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("leaves no English in translated files", () => {
    const findings = files.filter(([f]) => !PENDING.has(f) && !(f in OUT_OF_SCOPE)).flatMap(([f, src]) => scan(f, src));
    expect(findings.map((x) => `${x.file}:${x.line}  ${x.text}`)).toEqual([]);
  });

  it("lists only files that still need extracting", () => {
    const done = [...PENDING].filter((f) => {
      const src = files.find(([p]) => p === f)?.[1];
      return src === undefined || scan(f, src).length === 0;
    });
    expect(done, "these files are translated now (or gone): remove them from PENDING").toEqual([]);
  });
});
