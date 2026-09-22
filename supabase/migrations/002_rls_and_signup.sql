-- Org scoping helper. security definer so it can read memberships under RLS.
create or replace function public.user_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships where user_id = auth.uid()
$$;

-- On signup: user row + personal org + owner membership + free entitlement, in one transaction.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_org_id uuid;
begin
  insert into public.users (id, email) values (new.id, new.email);
  insert into public.organisations (name, kind)
    values (coalesce(split_part(new.email, '@', 1), 'Personal'), 'personal')
    returning id into new_org_id;
  insert into public.memberships (org_id, user_id, role) values (new_org_id, new.id, 'owner');
  insert into public.entitlements (org_id) values (new_org_id);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table organisations            enable row level security;
alter table users                    enable row level security;
alter table memberships              enable row level security;
alter table recordings               enable row level security;
alter table recording_events         enable row level security;
alter table transcripts              enable row level security;
alter table transcript_segments      enable row level security;
alter table speakers                 enable row level security;
alter table outputs                  enable row level security;
alter table action_items             enable row level security;
alter table consents                 enable row level security;
alter table entitlements             enable row level security;
alter table usage_ledger             enable row level security;
alter table audit_log                enable row level security;
alter table domain_templates         enable row level security;
alter table jurisdiction_disclaimers enable row level security;

create policy org_self    on organisations for select to authenticated using (id in (select public.user_org_ids()));
create policy user_self   on users         for all    to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy member_self on memberships   for select to authenticated using (user_id = auth.uid());

create policy rec_own on recordings for all to authenticated
  using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

create policy revt_own on recording_events for select to authenticated
  using (exists (select 1 from recordings r where r.id = recording_id and r.org_id in (select public.user_org_ids())));

create policy tr_own on transcripts for select to authenticated
  using (exists (select 1 from recordings r where r.id = recording_id and r.org_id in (select public.user_org_ids())));

create policy seg_own on transcript_segments for select to authenticated
  using (exists (select 1 from transcripts t join recordings r on r.id = t.recording_id
                 where t.id = transcript_id and r.org_id in (select public.user_org_ids())));

create policy spk_own on speakers for all to authenticated
  using (exists (select 1 from transcripts t join recordings r on r.id = t.recording_id
                 where t.id = transcript_id and r.org_id in (select public.user_org_ids())))
  with check (exists (select 1 from transcripts t join recordings r on r.id = t.recording_id
                 where t.id = transcript_id and r.org_id in (select public.user_org_ids())));

create policy out_own on outputs for select to authenticated
  using (exists (select 1 from recordings r where r.id = recording_id and r.org_id in (select public.user_org_ids())));

create policy ai_own on action_items for all to authenticated
  using (exists (select 1 from outputs o join recordings r on r.id = o.recording_id
                 where o.id = output_id and r.org_id in (select public.user_org_ids())))
  with check (exists (select 1 from outputs o join recordings r on r.id = o.recording_id
                 where o.id = output_id and r.org_id in (select public.user_org_ids())));

create policy con_own on consents     for all    to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy ent_own on entitlements for select to authenticated using (org_id in (select public.user_org_ids()));
create policy use_own on usage_ledger for select to authenticated using (org_id in (select public.user_org_ids()));

-- audit_log: RLS on, no policy. Service role only. Nobody reads their own audit trail.

create policy tpl_read on domain_templates         for select to authenticated using (is_active);
create policy jur_read on jurisdiction_disclaimers for select to authenticated using (is_active);

-- Private audio bucket, Sydney. Never public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vm-audio-au', 'vm-audio-au', false, 524288000,
        array['audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav',
              'audio/aac','audio/ogg','audio/flac','audio/webm','video/mp4','video/quicktime'])
on conflict (id) do nothing;

create policy audio_own on storage.objects for all to authenticated
  using (bucket_id = 'vm-audio-au' and exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid() and m.org_id::text = (storage.foldername(name))[1]))
  with check (bucket_id = 'vm-audio-au' and exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid() and m.org_id::text = (storage.foldername(name))[1]));
