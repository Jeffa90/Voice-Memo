/**
 * Deterministic post-pass. Anything the model produced that cannot be traced to
 * real transcript segments is removed, not shown. This is the anti-hallucination
 * control — see docs/HANDOFF.md rule 1.
 */

export interface GroundingResult {
  content: any;
  dropped: Array<{ kind: string; text: string; reason: string }>;
  status: "validated" | "partially_validated" | "failed";
}

export function validateGrounding(content: any, maxIndex: number): GroundingResult {
  const dropped: GroundingResult["dropped"] = [];

  const refsOk = (refs: unknown): refs is number[] =>
    Array.isArray(refs) && refs.length > 0 &&
    refs.every((r) => Number.isInteger(r) && r >= 0 && r <= maxIndex);

  const keep = <T extends { text?: string; body_markdown?: string; segment_refs?: unknown }>(
    items: T[] | undefined, kind: string, required: boolean,
  ): T[] => {
    if (!Array.isArray(items)) return [];
    return items.filter((item) => {
      if (refsOk(item.segment_refs)) return true;
      // A section legitimately has nothing to cite when nothing was discussed.
      if (!required && Array.isArray(item.segment_refs) && item.segment_refs.length === 0) return true;
      dropped.push({
        kind,
        text: (item.text ?? item.body_markdown ?? "").slice(0, 200),
        reason: Array.isArray(item.segment_refs) ? "segment_refs out of range" : "no segment_refs",
      });
      return false;
    });
  };

  const out = {
    ...content,
    key_points: keep(content.key_points, "key_point", true),
    action_items: keep(content.action_items, "action_item", true),
    sections: keep(content.sections, "section", false),
  };

  const status = typeof out.summary !== "string" || out.summary.length === 0
    ? "failed"
    : dropped.length > 0
    ? "partially_validated"
    : "validated";

  return { content: out, dropped, status };
}
