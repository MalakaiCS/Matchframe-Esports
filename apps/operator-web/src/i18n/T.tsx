import { Fragment, type ReactNode } from "react";
import { interpolate, richPieces, type Vars } from "./core.ts";
import { rawTemplate } from "./index.ts";

type Values = Record<string, ReactNode>;
type Tags = Record<string, (children: ReactNode) => ReactNode>;

/** Default rich-text tags; a <T> call can add its own (a link, say) or replace these. */
const DEFAULT_TAGS: Tags = {
  b: (c) => <strong>{c}</strong>,
  code: (c) => <code>{c}</code>,
  em: (c) => <em>{c}</em>,
};

function fill(text: string, values: Values | undefined, locale: Parameters<typeof interpolate>[2]): ReactNode {
  if (!values) return text;
  const plain: Vars = {};
  const nodes: Values = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" || typeof v === "number") plain[k] = v;
    else nodes[k] = v;
  }
  const s = interpolate(text, plain, locale);
  if (Object.keys(nodes).length === 0) return s;
  const parts = s.split(/\{(\w+)\}/g);
  return parts.map((p, i) => (i % 2 === 1 ? <Fragment key={i}>{p in nodes ? nodes[p] : `{${p}}`}</Fragment> : p));
}

/**
 * Translated rich text: `{name}` placeholders may be React nodes (a <code>, a <Link>), and
 * `<tag>…</tag>` spans in the translation are rendered by `tags` (b, code and em by default).
 * Translators move the spans with the words; the code decides what each span is.
 */
export function T({ k, values, tags }: { k: string; values?: Values; tags?: Tags }) {
  const tpl = rawTemplate(k, values as Vars | undefined);
  if (!tpl) return <>{k}</>;
  const all = { ...DEFAULT_TAGS, ...tags };
  return (
    <>
      {richPieces(tpl.text).map((piece, i) => {
        const inner = fill(piece.text, values, tpl.locale);
        if (piece.kind === "text") return <Fragment key={i}>{inner}</Fragment>;
        const render = all[piece.name];
        return <Fragment key={i}>{render ? render(inner) : inner}</Fragment>;
      })}
    </>
  );
}
