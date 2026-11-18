#!/usr/bin/env node
// Checks the translation catalogs (ADR-082). Run directly (`node scripts/i18n-check.mjs`) or as part
// of the tests (apps/operator-web/src/i18n/catalogs.test.ts).
//
// Catalogs: apps/operator-web/src/i18n/locales/<language>.json and apps/desktop/src/locales/<language>.json.
// - every key in the English catalog exists in every language, and no language has keys English lacks;
// - placeholders ({name}) and rich-text tags (<b>…</b>) match English;
// - plurals have exactly the forms the language needs (Intl.PluralRules: one/few/many/other for
//   Polish and Russian, one/many/other for Portuguese, Spanish and French, one/other for German);
// - every key the code uses literally (t("…"), <T k="…">) exists in English.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "pt-BR", "es", "de", "fr", "pl", "ru"];
const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

const isPlural = (v) => v && typeof v === "object" && "other" in v && Object.keys(v).every((k) => CATEGORIES.includes(k) && typeof v[k] === "string");

/** Flattens a catalog to { "a.b.c": string | { one, other } }. */
function flatten(obj, prefix, out, problems, where) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      if (!v.trim()) problems.push(`${where}: ${key} is empty`);
      out[key] = v;
    } else if (isPlural(v)) out[key] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out, problems, where);
    else problems.push(`${where}: ${key} is not text, a plural or a group`);
  }
  return out;
}

const tokens = (s) => {
  const vars = [...s.matchAll(/\{(\w+)\}/g)].map((m) => `{${m[1]}}`);
  const tags = [...s.matchAll(/<(\w+)>/g)].map((m) => `<${m[1]}>`);
  return [...vars, ...tags];
};
const tokenSet = (v) => new Set(typeof v === "string" ? tokens(v) : Object.values(v).flatMap(tokens));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const show = (s) => [...s].sort().join(" ") || "(none)";

function compare(enFlat, flat, locale, where, problems) {
  const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const [key, en] of Object.entries(enFlat)) {
    const v = flat[key];
    if (v === undefined) {
      problems.push(`${where}: missing ${key}`);
      continue;
    }
    if (isPlural(en) !== isPlural(v)) {
      problems.push(`${where}: ${key} should ${isPlural(en) ? "" : "not "}be a plural`);
      continue;
    }
    if (isPlural(v)) {
      const have = Object.keys(v);
      const missing = needed.filter((c) => !have.includes(c));
      const extra = have.filter((c) => !needed.includes(c));
      if (missing.length) problems.push(`${where}: ${key} lacks plural forms ${missing.join(", ")}`);
      if (extra.length) problems.push(`${where}: ${key} has plural forms ${locale} doesn't use: ${extra.join(", ")}`);
      // Every form may drop {count} ("one" often reads better without the number), but no form may add a placeholder.
      const enAll = tokenSet(en);
      for (const [cat, form] of Object.entries(v)) {
        const stray = tokens(form).filter((x) => !enAll.has(x));
        if (stray.length) problems.push(`${where}: ${key}.${cat} has placeholders English lacks: ${stray.join(" ")}`);
      }
      const all = tokenSet(v);
      const lost = [...enAll].filter((x) => x !== "{count}" && !all.has(x));
      if (lost.length) problems.push(`${where}: ${key} drops ${lost.join(" ")}`);
    } else if (!sameSet(tokenSet(en), tokenSet(v))) {
      problems.push(`${where}: ${key} placeholders differ (English: ${show(tokenSet(en))}; ${locale}: ${show(tokenSet(v))})`);
    }
  }
  for (const key of Object.keys(flat)) if (!(key in enFlat)) problems.push(`${where}: stray key ${key} (not in English)`);
}

const readJson = (file, problems) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`${relative(root, file)}: ${e.message}`);
    return {};
  }
};

function walk(dir, test, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "node_modules" && f !== "dist") walk(p, test, out);
    } else if (test(p)) out.push(p);
  }
  return out;
}

/** Keys used literally in the code: t("a.b"), t('a.b'), <T k="a.b" … />. */
function usedKeys(dir) {
  const out = new Map();
  for (const file of walk(dir, (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?<![\w.])t\(\s*["']([a-zA-Z][\w-]*(?:\.[\w-]+)+)["']|\bk=["']([a-zA-Z][\w-]*(?:\.[\w-]+)+)["']/g)) {
      const key = m[1] ?? m[2];
      if (!out.has(key)) out.set(key, relative(root, file));
    }
  }
  return out;
}

export function checkCatalogs() {
  const problems = [];
  const stats = {};

  // One catalog per language: the console's (top-level keys are namespaces) and the desktop shell's.
  const catalogs = (dir, name) => {
    const en = flatten(readJson(join(root, dir, "en.json"), problems), "", {}, problems, `${name} en`);
    for (const f of readdirSync(join(root, dir))) {
      if (f.endsWith(".json") && !LOCALES.includes(f.replace(/\.json$/, ""))) problems.push(`${name}: stray catalog ${f}`);
    }
    for (const locale of LOCALES.slice(1)) {
      const flat = flatten(readJson(join(root, dir, `${locale}.json`), problems), "", {}, problems, `${name} ${locale}`);
      compare(en, flat, locale, `${name} ${locale}`, problems);
    }
    return en;
  };
  const enConsole = catalogs("apps/operator-web/src/i18n/locales", "console");
  const enDesktop = catalogs("apps/desktop/src/locales", "desktop");
  stats.console = Object.keys(enConsole).length;
  stats.desktop = Object.keys(enDesktop).length;

  // English plurals need English's forms too.
  for (const [where, flat] of [
    ["console en", enConsole],
    ["desktop en", enDesktop],
  ]) {
    for (const [key, v] of Object.entries(flat)) if (isPlural(v) && !("one" in v)) problems.push(`${where}: ${key} lacks plural form one`);
  }

  // Keys the code uses must exist.
  for (const [key, file] of usedKeys(join(root, "apps/operator-web/src"))) if (!(key in enConsole)) problems.push(`${file}: uses ${key}, which the English console catalog lacks`);
  for (const [key, file] of usedKeys(join(root, "apps/desktop/src"))) if (!(key in enDesktop)) problems.push(`${file}: uses ${key}, which the English desktop catalog lacks`);

  return { problems, stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { problems, stats } = checkCatalogs();
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`\n${problems.length} translation problem(s).`);
    process.exit(1);
  }
  console.log(`Translations OK: ${stats.console} console and ${stats.desktop} desktop strings in ${LOCALES.length} languages.`);
}
