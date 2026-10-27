import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

/**
 * `import Icon from "./icon.svg?react"`: a React component that renders the SVG inline, so CSS can
 * colour and size it (the template's icons rely on this). A small stand-in for vite-plugin-svgr:
 * the root <svg> keeps viewBox/width/height/fill/preserveAspectRatio and takes the component's
 * props; the inner markup is inserted as is (the files are the template's own icons).
 */
const KEEP = new Set(["viewBox", "width", "height", "fill", "preserveAspectRatio"]);

export function svgComponent(): Plugin {
  return {
    name: "matchframe-svg-component",
    enforce: "pre",
    async load(id) {
      const [file, query] = id.split("?", 2);
      if (!file?.endsWith(".svg") || query !== "react") return null;
      const raw = (await readFile(file, "utf8")).replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
      const open = /<svg\b([^>]*)>/i.exec(raw);
      const close = raw.lastIndexOf("</svg>");
      if (!open || close < 0) throw new Error(`${file} is not an SVG`);
      const attrs: Record<string, string> = {};
      for (const m of open[1]!.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        const name = m[1]!;
        if (KEEP.has(name)) attrs[name] = m[3] ?? m[4] ?? "";
      }
      const inner = raw.slice(open.index + open[0].length, close).trim();
      return [
        `import { createElement, memo } from "react";`,
        `const attrs = ${JSON.stringify(attrs)};`,
        `const html = { __html: ${JSON.stringify(inner)} };`,
        `const Svg = memo(function Svg(props) { return createElement("svg", { xmlns: "http://www.w3.org/2000/svg", ...attrs, ...props, dangerouslySetInnerHTML: html }); });`,
        `export default Svg;`,
      ].join("\n");
    },
  };
}
