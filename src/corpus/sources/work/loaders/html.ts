const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

export async function loadHtml(_filePath: string, buffer: Buffer): Promise<string> {
  let html = buffer.toString("utf8");
  html = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ");
  html = html.replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n\n");
  html = html.replace(/<[^>]+>/g, " ");
  html = html.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  for (const [ent, ch] of Object.entries(ENTITIES)) html = html.replaceAll(ent, ch);
  return html.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
