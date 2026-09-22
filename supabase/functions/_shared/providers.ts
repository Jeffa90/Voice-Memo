/**
 * Transcription providers. NOTHING outside this file may import a provider SDK
 * or know a provider's wire format — see docs/DESIGN.md §3.1. Swapping
 * AssemblyAI for Deepgram or self-hosted WhisperX is a change here and nowhere else.
 */

export interface NormalisedSegment {
  index: number;
  speakerKey: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface NormalisedTranscript {
  languageCode: string;
  durationMs: number;
  segments: NormalisedSegment[];
  providerRaw: unknown;
}

export interface SubmitInput {
  audioUrl: string;
  webhookUrl: string;
  keyterms?: string[];
}

export interface TranscriptionProvider {
  readonly name: string;
  /** Returns a job id when async, or a transcript when the provider is synchronous. */
  submit(input: SubmitInput): Promise<{ providerJobId: string; inline?: NormalisedTranscript }>;
  fetchResult(providerJobId: string): Promise<NormalisedTranscript>;
}

// ------------------------------------------------------------------ AssemblyAI

const AAI = "https://api.assemblyai.com/v2";

export class AssemblyAIProvider implements TranscriptionProvider {
  readonly name = "assemblyai";
  constructor(private apiKey: string) {}

  async submit({ audioUrl, webhookUrl, keyterms }: SubmitInput) {
    const res = await fetch(`${AAI}/transcript`, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        audio_url: audioUrl,
        speaker_labels: true,
        language_code: "en_au",
        punctuate: true,
        format_text: true,
        webhook_url: webhookUrl,
        webhook_auth_header_name: "x-vm-webhook-secret",
        webhook_auth_header_value: Deno.env.get("ASSEMBLYAI_WEBHOOK_SECRET") ?? "",
        ...(keyterms?.length ? { word_boost: keyterms.slice(0, 1000), boost_param: "high" } : {}),
      }),
    });
    if (!res.ok) throw new Error(`AssemblyAI submit ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return { providerJobId: body.id as string };
  }

  async fetchResult(id: string): Promise<NormalisedTranscript> {
    const res = await fetch(`${AAI}/transcript/${id}`, { headers: { authorization: this.apiKey } });
    if (!res.ok) throw new Error(`AssemblyAI fetch ${res.status}: ${await res.text()}`);
    const t = await res.json();
    if (t.status === "error") throw new Error(`AssemblyAI: ${t.error}`);

    // Prefer diarized utterances; fall back to the flat transcript if diarization
    // produced nothing (very short or single-speaker audio).
    const utterances = t.utterances ?? [];
    const segments: NormalisedSegment[] = utterances.length
      ? utterances.map((u: any, i: number) => ({
          index: i,
          speakerKey: String(u.speaker ?? "A"),
          startMs: u.start ?? 0,
          endMs: u.end ?? 0,
          text: (u.text ?? "").trim(),
          confidence: u.confidence ?? null,
        }))
      : [{ index: 0, speakerKey: "A", startMs: 0, endMs: t.audio_duration ? t.audio_duration * 1000 : 0, text: t.text ?? "", confidence: t.confidence ?? null }];

    return {
      languageCode: t.language_code ?? "en_au",
      durationMs: Math.round((t.audio_duration ?? 0) * 1000),
      segments: segments.filter((s) => s.text.length > 0),
      providerRaw: { id: t.id, status: t.status, audio_duration: t.audio_duration },
    };
  }
}

// ------------------------------------------------------------------ Stub
// Deterministic and instant. Lets the whole pipeline and the entire web app be
// built and tested offline, with no credits spent and no minutes of waiting.

const STUB_TURNS: Array<[string, string]> = [
  ["A", "Morning, come on in and take a seat. How have you been since we last spoke?"],
  ["B", "Not great, honestly. The headaches have been coming back, maybe three or four times a week now."],
  ["A", "That's more often than last time. Are they the same kind of headache, or different?"],
  ["B", "Same sort of thing. Behind the eyes, mostly in the afternoon. Sometimes I feel a bit sick with them."],
  ["A", "And how are you going with the blood pressure medication? The perindopril, four milligrams."],
  ["B", "I've been taking it every morning. I did miss a couple of days when I was away two weeks ago."],
  ["A", "That's alright, these things happen. Let's have a look at your blood pressure now."],
  ["A", "It's sitting at one forty-two over eighty-eight. That's still higher than I'd like it to be."],
  ["B", "Is that bad?"],
  ["A", "It's not dangerous today, but it's above where we want you long term. I'd like to increase the perindopril from four milligrams to eight milligrams, once a day in the morning."],
  ["B", "Will that make me feel any different?"],
  ["A", "Some people get a bit light-headed in the first week, especially standing up quickly. If that happens, take your time getting up. If it's severe or you feel faint, stop and ring us."],
  ["C", "Sorry, can I ask — should he still take it if he feels dizzy in the morning?"],
  ["A", "Good question. If it's mild dizziness, keep taking it and let us know at the review. If he actually feels like he might pass out, stop the tablet and call us that day."],
  ["A", "I'd also like to get some blood tests done. A full blood count, kidney function, and cholesterol."],
  ["B", "Do I need to fast for those?"],
  ["A", "Yes, for the cholesterol. Nothing to eat for twelve hours beforehand, water is fine. Easiest to do it first thing in the morning."],
  ["A", "I'm also going to refer you to a neurologist about the headaches, given they've become more frequent."],
  ["B", "How long does that usually take?"],
  ["A", "Usually four to six weeks for a routine referral. If the headaches get significantly worse before then, don't wait — come back and see me."],
  ["A", "The things I'd want you to watch for are a sudden severe headache unlike your usual ones, any weakness or numbness, changes to your vision, or slurred speech. Any of those, that's an emergency, call triple zero."],
  ["B", "Right. Okay."],
  ["A", "Let's book you back in four weeks to check the blood pressure on the higher dose and go through the blood results. Make that appointment at the front desk on your way out."],
  ["B", "Will do. Thanks."],
];

export class StubProvider implements TranscriptionProvider {
  readonly name = "stub";

  private build(): NormalisedTranscript {
    let t = 0;
    const segments = STUB_TURNS.map(([speakerKey, text], index) => {
      const startMs = t;
      const endMs = t + Math.max(1800, text.length * 55);
      t = endMs + 400;
      return { index, speakerKey, startMs, endMs, text, confidence: 0.94 };
    });
    return { languageCode: "en_au", durationMs: t, segments, providerRaw: { provider: "stub" } };
  }

  async submit() {
    return { providerJobId: `stub_${crypto.randomUUID()}`, inline: this.build() };
  }
  async fetchResult() {
    return this.build();
  }
}

export function getProvider(): TranscriptionProvider {
  const name = Deno.env.get("TRANSCRIPTION_PROVIDER") ?? "stub";
  if (name === "assemblyai") {
    const key = Deno.env.get("ASSEMBLYAI_API_KEY");
    if (!key) throw new Error("TRANSCRIPTION_PROVIDER=assemblyai but ASSEMBLYAI_API_KEY is not set");
    return new AssemblyAIProvider(key);
  }
  return new StubProvider();
}

/** Medical vocabulary pushed to the ASR as a boost list. Generic ASR fumbles these. */
export const MEDICAL_KEYTERMS = [
  "perindopril", "amlodipine", "atorvastatin", "metformin", "salbutamol", "sertraline",
  "prednisolone", "amoxicillin", "pantoprazole", "warfarin", "apixaban", "levothyroxine",
  "milligrams", "micrograms", "twice daily", "once daily", "as needed",
  "full blood count", "kidney function", "cholesterol", "HbA1c", "ECG", "CT scan", "MRI",
  "ultrasound", "referral", "neurologist", "cardiologist", "endocrinologist", "specialist",
  "blood pressure", "hypertension", "diabetes", "asthma", "Medicare", "bulk billed",
];
