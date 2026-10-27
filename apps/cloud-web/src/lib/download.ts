/** Saves data as a JSON file in the browser (indirection so tests can observe it). */
export const fileSaver = {
  saveJson(filename: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

/** "matchframe-account-2026-10-27.json" (local date). */
export function exportFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `matchframe-account-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}
