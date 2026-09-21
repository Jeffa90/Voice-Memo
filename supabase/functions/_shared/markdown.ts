export function renderMarkdown(
  title: string,
  content: any,
  disclaimers: string[],
  recordedAt?: string | null,
): string {
  const L: string[] = [`# ${title}`];
  if (recordedAt) L.push(`*${new Date(recordedAt).toLocaleDateString("en-AU", { dateStyle: "long" })}*`);
  L.push("", content.summary ?? "", "");

  if (content.key_points?.length) {
    L.push("## Key points", "");
    for (const k of content.key_points) L.push(`- ${k.text}`);
    L.push("");
  }
  if (content.action_items?.length) {
    L.push("## What to do", "");
    for (const a of content.action_items) {
      const bits = [a.owner_hint && a.owner_hint !== "you" ? `(${a.owner_hint})` : "", a.due_hint ? `— ${a.due_hint}` : ""].filter(Boolean).join(" ");
      L.push(`- [ ] ${a.text}${bits ? " " + bits : ""}`);
    }
    L.push("");
  }
  for (const s of content.sections ?? []) {
    if (!s.body_markdown?.trim()) continue;
    L.push(`## ${s.title}`, "", s.body_markdown.trim(), "");
  }
  if (content.confidence_notes?.length) {
    L.push("## Notes on this summary", "");
    for (const n of content.confidence_notes) L.push(`- ${n}`);
    L.push("");
  }
  L.push("---", "");
  for (const d of disclaimers) L.push(`> ${d}`, "");
  return L.join("\n");
}
