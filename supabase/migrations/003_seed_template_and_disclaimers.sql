insert into domain_templates (key, version, name, description, system_prompt, output_schema, section_manifest, speaker_roles, disclaimers)
values (
'medical_visit', 1, 'Medical visit', 'Plain-language summary of a medical consultation, written for the patient.',
$prompt$You turn a recorded medical consultation into a clear, plain-language summary for the patient who attended it.

WHAT YOU DO
Report what was actually said in the room, in plainer words. That is the entire job.

WHAT YOU MUST NEVER DO
- Never give medical advice of your own.
- Never interpret a result the clinician did not interpret out loud.
- Never suggest a test, medication, dose or action that nobody in the recording stated.
- Never speculate about a diagnosis, a prognosis, or what something "might mean".
- Never soften or omit something the clinician said because it sounds alarming.
- If the clinician was vague or uncertain, say that they were, rather than resolving it.

These are not style preferences. This product summarises a conversation; it is not a clinician and must never read like one.

GROUNDING
Every key point, action item and section body must cite the transcript segment indices it came from, in segment_refs. If you cannot point to specific segments, do not write the item. An empty section is correct and useful; an invented one is a failure.

WRITING
- Address the patient directly as "you". Refer to clinicians by name when the speaker labels give one, otherwise "the doctor".
- Aim for a grade 8 reading level. Expand jargon the first time it appears: "hypertension (high blood pressure)".
- Keep medication details exact. Name, dose, frequency and any change must match what was said, word for word where it matters. Never round, never approximate, never tidy up a dose.
- If audio was unclear or a section is empty, put that in confidence_notes rather than guessing.

SECTIONS
Fill the sections named in the section manifest, in that order. Use the exact key given. If nothing in the conversation belongs in a section, still include it with a short body saying nothing was discussed.$prompt$,
$schema${
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "key_points", "action_items", "sections", "confidence_notes"],
  "properties": {
    "summary": { "type": "string", "description": "2-4 sentences, plain language, what this appointment was about and what came out of it." },
    "key_points": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["text", "segment_refs"],
        "properties": {
          "text": { "type": "string" },
          "segment_refs": { "type": "array", "items": { "type": "integer" }, "minItems": 1 }
        }
      }
    },
    "action_items": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["text", "owner_hint", "due_hint", "segment_refs"],
        "properties": {
          "text": { "type": "string" },
          "owner_hint": { "type": ["string", "null"], "enum": ["you", "clinic", null] },
          "due_hint": { "type": ["string", "null"] },
          "segment_refs": { "type": "array", "items": { "type": "integer" }, "minItems": 1 }
        }
      }
    },
    "sections": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["key", "title", "body_markdown", "segment_refs"],
        "properties": {
          "key": { "type": "string" },
          "title": { "type": "string" },
          "body_markdown": { "type": "string" },
          "segment_refs": { "type": "array", "items": { "type": "integer" } }
        }
      }
    },
    "confidence_notes": { "type": "array", "items": { "type": "string" } }
  }
}$schema$,
$manifest$[
  {"key":"reason_for_visit","title":"Reason for visit"},
  {"key":"what_was_discussed","title":"What was discussed"},
  {"key":"assessment","title":"Diagnosis or assessment discussed"},
  {"key":"medications","title":"Medications discussed"},
  {"key":"tests_referrals","title":"Tests, scans and referrals"},
  {"key":"before_next_visit","title":"What to do before your next visit"},
  {"key":"warning_signs","title":"Warning signs to watch for"},
  {"key":"questions_next_time","title":"Questions to ask next time"},
  {"key":"follow_up","title":"Follow-up and next appointment"}
]$manifest$,
array['clinician','patient','interpreter','carer','other'],
array['This is a summary of what was said in your appointment. It is not medical advice, and it may contain mistakes. Always check with your doctor before acting on anything here.',
      'If you feel unwell or your symptoms get worse, contact your doctor or call 000 in an emergency.']
);

-- Placeholder recording-consent copy. Structure is the deliverable; the words
-- are lawyer-drafted and MUST be replaced before anyone else's voice is uploaded.
insert into jurisdiction_disclaimers (state_code, version, body_markdown, acknowledgement_label)
select s,
  1,
  '**[PLACEHOLDER - NOT LEGAL COPY]** Recording laws differ across Australia. In ' || s ||
  ', recording a private conversation may require the agreement of everyone taking part. ' ||
  'Ask your doctor before you record - most will say yes. You are responsible for making sure ' ||
  'you had permission to make this recording.',
  'I had everyone''s permission to make this recording.'
from unnest(array['NSW','VIC','QLD','SA','WA','TAS','NT','ACT']) as s;
