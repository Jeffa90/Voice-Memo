-- Voice-Memo core schema. See docs/DESIGN.md §7.2.
-- The full schema ships day one even though v1 only exercises part of it:
-- backfilling org/region/consent columns across health records later is the
-- migration nobody wants to run.

create extension if not exists "pgcrypto";

create type org_kind            as enum ('personal','clinic');
create type member_role         as enum ('owner','admin','member','viewer');
create type entitlement_source  as enum ('none','stripe','apple','google','manual');
create type consent_type        as enum ('terms','privacy','overseas_disclosure');
create type validation_status   as enum ('validated','partially_validated','failed');
create type actor_kind          as enum ('user','worker','admin','system');

-- ---------------------------------------------------------------- tenancy

create table organisations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  kind                 org_kind not null default 'personal',
  data_region          text not null default 'au',   -- the US/HIPAA seam (§4.7)
  retention_days       int  not null default 730,
  audio_retention_days int  not null default 7,
  created_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create table users (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  display_name    text,
  state_territory text check (state_territory in ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create table memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organisations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       member_role not null default 'owner',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on memberships (user_id);

-- ---------------------------------------------------------------- templates

create table domain_templates (
  key              text not null,
  version          int  not null,
  name             text not null,
  description      text,
  system_prompt    text not null,
  output_schema    jsonb not null,
  section_manifest jsonb not null,
  speaker_roles    text[] not null default '{}',
  disclaimers      text[] not null default '{}',
  is_active        bool not null default true,
  created_at       timestamptz not null default now(),
  primary key (key, version)
);

create table jurisdiction_disclaimers (
  state_code            text not null check (state_code in ('NSW','VIC','QLD','SA','WA','TAS','NT','ACT')),
  version               int  not null,
  body_markdown         text not null,
  acknowledgement_label text not null,
  is_active             bool not null default true,
  created_at            timestamptz not null default now(),
  primary key (state_code, version)
);

-- ---------------------------------------------------------------- recordings

create table recordings (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organisations(id) on delete cascade,
  owner_user_id             uuid not null references users(id) on delete cascade,
  title                     text,
  domain_template_key       text not null default 'medical_visit',
  status                    text not null default 'created',
  failure_reason            text,
  storage_bucket            text,
  storage_key               text,
  content_type              text,
  byte_size                 bigint,
  duration_ms               int,
  checksum_sha256           text,
  recorded_at               timestamptz,
  -- recording-consent evidence (§4.6); jurisdiction follows the conversation
  recorded_in_state         text,
  consent_disclaimer_state  text,
  consent_disclaimer_version int,
  consent_attested_at       timestamptz,
  audio_delete_at           timestamptz,
  audio_deleted_at          timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,
  constraint recordings_status_check check (status in (
    'created','uploading','uploaded','queued','transcribing','transcribed',
    'suggesting_speakers','awaiting_speaker_confirmation','summarising','ready',
    'failed_upload','failed_audio_qc','failed_quota_exceeded',
    'failed_transcription','failed_extraction','deleted'))
);
create index on recordings (org_id, created_at desc);
create index on recordings (status) where deleted_at is null;
create index on recordings (audio_delete_at) where audio_deleted_at is null;

create table recording_events (
  id           bigserial primary key,
  recording_id uuid not null references recordings(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index on recording_events (recording_id, created_at);

-- ---------------------------------------------------------------- transcripts

create table transcripts (
  id             uuid primary key default gen_random_uuid(),
  recording_id   uuid not null unique references recordings(id) on delete cascade,
  provider       text not null,
  provider_job_id text,
  language_code  text,
  provider_raw   jsonb,
  created_at     timestamptz not null default now()
);
create index on transcripts (provider_job_id);

create table transcript_segments (
  id            bigserial primary key,
  transcript_id uuid not null references transcripts(id) on delete cascade,
  idx           int  not null,                 -- the grounding anchor for segment_refs
  speaker_key   text not null,
  start_ms      int,
  end_ms        int,
  text          text not null,
  confidence    real,
  unique (transcript_id, idx)
);

create table speakers (
  id                   uuid primary key default gen_random_uuid(),
  transcript_id        uuid not null references transcripts(id) on delete cascade,
  speaker_key          text not null,
  suggested_label      text,
  suggested_role       text,
  suggested_confidence real,
  display_label        text,
  role                 text,
  confirmed_by_user_id uuid references users(id),
  confirmed_at         timestamptz,
  unique (transcript_id, speaker_key)
);

-- ---------------------------------------------------------------- outputs

create table outputs (
  id                uuid primary key default gen_random_uuid(),
  recording_id      uuid not null references recordings(id) on delete cascade,
  template_key      text not null,
  template_version  int  not null,
  model             text not null,
  envelope_version  int  not null default 1,
  content           jsonb not null,
  content_markdown  text,
  validation_status validation_status not null default 'validated',
  dropped_items     jsonb,
  input_tokens      int,
  output_tokens     int,
  cache_read_tokens int,
  superseded_by     uuid references outputs(id),
  created_at        timestamptz not null default now()
);
create index on outputs (recording_id, created_at desc);

create table action_items (
  id           uuid primary key default gen_random_uuid(),
  output_id    uuid not null references outputs(id) on delete cascade,
  idx          int not null,
  text         text not null,
  owner_hint   text,
  due_hint     text,
  segment_refs int[] not null default '{}',
  completed_at timestamptz,
  edited_text  text
);
create index on action_items (output_id, idx);

-- ---------------------------------------------------------------- consent, billing, audit

create table consents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  org_id     uuid references organisations(id) on delete cascade,
  type       consent_type not null,
  version    text not null,
  granted_at timestamptz not null default now(),
  ip         inet,
  user_agent text,
  revoked_at timestamptz
);
create index on consents (user_id, type);

create table entitlements (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null unique references organisations(id) on delete cascade,
  plan                     text not null default 'free',
  status                   text not null default 'active',
  source                   entitlement_source not null default 'none',
  external_ref             text,
  audio_seconds_per_period int  not null default 36000,   -- 10 hours
  period_start             timestamptz not null default date_trunc('month', now()),
  current_period_end       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- immutable; deliberately survives deletion of the recording, so deleting
-- a recording cannot reclaim quota (§5.2)
create table usage_ledger (
  id            bigserial primary key,
  org_id        uuid not null references organisations(id) on delete cascade,
  recording_id  uuid,                        -- NOT a FK: the recording gets purged
  period_ym     text not null,
  audio_seconds int  not null,
  created_at    timestamptz not null default now()
);
create index on usage_ledger (org_id, period_ym);

create table audit_log (
  id            bigserial primary key,
  org_id        uuid,
  actor_user_id uuid,
  actor_kind    actor_kind not null default 'user',
  action        text not null,
  resource_type text,
  resource_id   uuid,
  ip            inet,
  user_agent    text,
  break_glass   bool not null default false,
  created_at    timestamptz not null default now()
);
create index on audit_log (org_id, created_at desc);

-- updated_at maintenance
create or replace function touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create trigger recordings_touch   before update on recordings   for each row execute function touch_updated_at();
create trigger entitlements_touch before update on entitlements for each row execute function touch_updated_at();
