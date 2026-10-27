import { useRef, useState } from "react";
import { api, describeError } from "../api/index.ts";
import { fmtBytes } from "../lib/format.ts";
import { Button } from "./ui.tsx";

/** The engine's asset upload limit (POST /api/v1/assets; larger bodies get 413). */
export const ASSET_UPLOAD_LIMIT = 20 * 1024 * 1024;
const ACCEPT = ".png,.jpg,.jpeg,.webp,.svg,.gif,.webm,.mp4";

export function assetUrl(id: string | null | undefined): string | null {
  return id ? `/assets/${encodeURIComponent(id)}` : null;
}

export async function uploadAsset(file: File): Promise<{ assetId: string; url: string }> {
  if (file.size > ASSET_UPLOAD_LIMIT) throw new Error(`${file.name} is ${fmtBytes(file.size)}; the engine accepts uploads up to ${fmtBytes(ASSET_UPLOAD_LIMIT)}.`);
  return api.upload(`/api/v1/assets?name=${encodeURIComponent(file.name)}`, await file.arrayBuffer(), file.type || "application/octet-stream");
}

/** Upload control for logos/avatars/sponsor media; shows the current asset thumbnail. */
export function AssetUpload({ value, onChange, label, disabledReason }: { value: string | null; onChange: (assetId: string | null) => void; label: string; disabledReason?: string | null }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = assetUrl(value);
  const isVideo = value ? /\.(webm|mp4)$/i.test(value) : false;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row">
        {url ? isVideo ? <span className="small mono">{value}</span> : <img className="thumb" src={url} alt={`${label} preview`} /> : null}
        <input
          ref={ref}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label={`Upload ${label}`}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            setError(null);
            try {
              const r = await uploadAsset(f);
              onChange(r.assetId);
            } catch (err) {
              setError(describeError(err));
            } finally {
              setBusy(false);
              if (ref.current) ref.current.value = "";
            }
          }}
        />
        <Button size="sm" onClick={() => ref.current?.click()} disabled={busy} disabledReason={disabledReason ?? null} title={`PNG, JPG, WebP, SVG, GIF, WebM or MP4 up to ${fmtBytes(ASSET_UPLOAD_LIMIT)}`}>
          {busy ? "Uploading…" : url ? "Replace" : "Upload"}
        </Button>
        {value ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        ) : null}
      </div>
      {error ? <span className="action-error">{error}</span> : null}
    </div>
  );
}

/** Editable list of map names (map pool). */
export function MapPoolEditor({ value, onChange, suggestions }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const [input, setInput] = useState("");
  const add = (m: string) => {
    const v = m.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setInput("");
  };
  return (
    <div className="field">
      <span className="field-label">Map pool ({value.length})</span>
      <div className="pill-list">
        {value.map((m) => (
          <span className="pill" key={m}>
            {m}
            <button aria-label={`Remove ${m}`} onClick={() => onChange(value.filter((x) => x !== m))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          list="map-suggestions"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(input);
            }
          }}
          placeholder="de_mirage"
        />
        <datalist id="map-suggestions">
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button size="sm" onClick={() => add(input)} disabled={!input.trim()}>
          Add map
        </Button>
        {suggestions.length ? (
          <Button size="sm" variant="ghost" onClick={() => onChange([...new Set([...value, ...suggestions])])}>
            Add all suggested
          </Button>
        ) : null}
      </div>
    </div>
  );
}
