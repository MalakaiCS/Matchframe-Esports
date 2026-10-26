export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

/**
 * Parser for Valve KeyValues text (libraryfolders.vdf, appmanifest_*.acf, GSI .cfg).
 * Supports quoted/unquoted tokens, nested objects, // comments and escape sequences.
 */
export function parseVdf(text: string): VdfObject {
  let i = 0;
  const n = text.length;
  const skip = () => {
    while (i < n) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
      } else break;
    }
  };
  const token = (): string | null => {
    skip();
    if (i >= n) return null;
    const c = text[i]!;
    if (c === "{" || c === "}") {
      i++;
      return c;
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          const e = text[i + 1]!;
          out += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
        } else out += text[i++];
      }
      i++;
      return out;
    }
    let out = "";
    while (i < n && !/[\s{}"]/.test(text[i]!)) out += text[i++];
    return out;
  };
  const parseObject = (depth: number): VdfObject => {
    const obj: VdfObject = {};
    while (true) {
      const k = token();
      if (k === null) {
        if (depth > 0) throw new Error("unexpected end of VDF");
        return obj;
      }
      if (k === "}") {
        if (depth === 0) throw new Error("unexpected } in VDF");
        return obj;
      }
      const v = token();
      if (v === null) throw new Error(`missing value for key ${k}`);
      obj[k] = v === "{" ? parseObject(depth + 1) : v;
    }
  };
  return parseObject(0);
}

export function getPath(obj: VdfObject, ...keys: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = obj;
  for (const k of keys) {
    if (typeof cur !== "object") return undefined;
    const found: string | undefined = Object.keys(cur).find((x) => x.toLowerCase() === k.toLowerCase());
    cur = found === undefined ? undefined : cur[found];
  }
  return cur;
}
