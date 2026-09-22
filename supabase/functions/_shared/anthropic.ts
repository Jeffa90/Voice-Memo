import Anthropic from "npm:@anthropic-ai/sdk";
import type { NormalisedSegment } from "./providers.ts";

const client = () => new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

export const MODEL_EXTRACT = "claude-sonnet-5";
export const MODEL_CHEAP = "claude-haiku-4-5";

export interface SpeakerSuggestion {
  speaker_key: string;
  suggested_label: string;
  suggested_role: string;
  confidence: number;
}

/** Renders segments the way the model sees them. The idx is the grounding anchor. */
export function renderTranscript(
  segments: NormalisedSegment[],
  labels: Record<string, string> = {},
): string {
  return segments
    .map((s) => {
      const who = labels[s.speakerKey] ?? `Speaker ${s.speakerKey}`;
      const mins = Math.floor(s.startMs / 60000);
      const secs = Math.floor((s.startMs % 60000) / 1000).toString().padStart(2, "0");
      return `[${s.index}] (${mins}:${secs}) ${who}: ${s.text}`;
    })
    .join("\n");
}

function assertUsable(msg: any) {
  if (msg.stop_reason === "refusal") {
    throw new Error(`Model declined: ${msg.stop_details?.explanation ?? msg.stop_details?.category ?? "unknown"}`);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("Model hit max_tokens before finishing — output would be truncated");
  }
}

/**
 * Cheap pass over the head of the transcript to propose who is who.
 * Never authoritative — a human confirms before these become labels (§ rule 5).
 */
export async function suggestSpeakers(
  segments: NormalisedSegment[],
  roles: string[],
): Promise<SpeakerSuggestion[]> {
  const head = segments.slice(0, 40);
  const keys = [...new Set(segments.map((s) => s.speakerKey))];

  const msg = await client().messages.create({
    model: MODEL_CHEAP,
    max_tokens: 2000,
    system: "You identify who is speaking in a medical consultation transcript. You are making a suggestion a human will review, not a decision.",
    messages: [{
      role: "user",
      content: `Speaker keys present: ${keys.join(", ")}.
Allowed roles: ${roles.join(", ")}.

For each speaker key, suggest a short display label (for example "Dr Chen" if a name is spoken, otherwise a role-based label like "Doctor" or "Patient") and one role from the allowed list. Give a confidence between 0 and 1.

Base this only on what the transcript shows: who asks clinical questions, who describes symptoms, who accompanies.

Transcript opening:
${renderTranscript(head)}`,
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["speakers"],
          properties: {
            speakers: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["speaker_key", "suggested_label", "suggested_role", "confidence"],
                properties: {
                  speaker_key: { type: "string" },
                  suggested_label: { type: "string" },
                  suggested_role: { type: "string", enum: roles },
                  confidence: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  } as any);

  assertUsable(msg);
  const text = (msg.content.find((b: any) => b.type === "text") as any)?.text ?? "{}";
  return (JSON.parse(text).speakers ?? []) as SpeakerSuggestion[];
}

export interface ExtractResult {
  content: any;
  usage: { input: number; output: number; cacheRead: number };
  model: string;
}

/**
 * The product. Strict structured output against the template's schema, with the
 * stable template prefix cached and the volatile transcript after it.
 */
export async function extract(
  systemPrompt: string,
  outputSchema: unknown,
  sectionManifest: Array<{ key: string; title: string }>,
  segments: NormalisedSegment[],
  labels: Record<string, string>,
): Promise<ExtractResult> {
  const stablePrefix = `${systemPrompt}

SECTION MANIFEST — produce exactly these sections, in this order, using these keys:
${sectionManifest.map((s) => `- ${s.key}: ${s.title}`).join("\n")}`;

  const msg = await client().messages.create({
    model: MODEL_EXTRACT,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: outputSchema },
    },
    system: [{ type: "text", text: stablePrefix, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: `Here is the transcript. The number in square brackets at the start of each line is that segment's index — use those numbers in segment_refs.

${renderTranscript(segments, labels)}`,
    }],
  } as any);

  assertUsable(msg);
  const text = (msg.content.find((b: any) => b.type === "text") as any)?.text ?? "{}";
  return {
    content: JSON.parse(text),
    model: MODEL_EXTRACT,
    usage: {
      input: msg.usage?.input_tokens ?? 0,
      output: msg.usage?.output_tokens ?? 0,
      cacheRead: (msg.usage as any)?.cache_read_input_tokens ?? 0,
    },
  };
}
