const BASE = "http://localhost:8100";

export async function openInEditor(
  filePath: string,
  line?: number,
  col?: number
): Promise<void> {
  const body: Record<string, unknown> = { path: filePath };
  if (line !== undefined) body["line"] = line;
  if (col !== undefined) body["col"] = col;

  const res = await fetch(`${BASE}/api/open-in-editor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 503) {
      throw new Error(data.error ?? "No editor found. Install cursor, code, or zed.");
    }
    throw new Error(data.error ?? `open-in-editor failed (${res.status})`);
  }
}
