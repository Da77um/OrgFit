-- Phase 06: assessment series/rounds, one campaign per round, frozen rosters,
-- report groups, invitations with keyed token digests, and the respondent
-- gateway validation/status contract. No answers, drafts, intake envelopes,
-- campaign keys or scores are created here; those belong to Phase 07.

CREATE TABLE core.assessment_series (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 name_ar text NOT NULL CHECK(length(trim(name_ar)) BETWEEN 1 AND 500), name_en text CHECK(length(name_en)<=500),
 purpose text NOT NULL CHECK(length(trim(purpose)) BETWEEN 1 AND 2000),
 questionnaire_family_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id)
);
CREATE INDEX ON core.assessment_series(organization_id,status,id);
CREATE INDEX ON core.assessment_series(created_by);
CREATE INDEX ON core.assessment_series(updated_by);

CREATE TABLE core.assessment_round (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 series_id uuid NOT NULL, label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
 period_start date NOT NULL, period_end date,
 instrument_scope_id uuid NOT NULL, questionnaire_version_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','COLLECTING','PROCESSING','PUBLISHED','INSUFFICIENT_DATA','CANCELLED','ARCHIVED')),
 archived_from text CHECK(archived_from IN ('PUBLISHED','INSUFFICIENT_DATA','CANCELLED')),
 notes text CHECK(length(notes)<=5000),
 population_definition jsonb NOT NULL DEFAULT '{"schemaVersion":1}'
  CHECK(jsonb_typeof(population_definition)='object' AND octet_length(population_definition::text)<=4096),
 compatibility_group text CHECK(length(compatibility_group)<=200),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id), UNIQUE(organization_id,series_id,id),
 FOREIGN KEY(organization_id,series_id) REFERENCES core.assessment_series(organization_id,id),
 FOREIGN KEY(instrument_scope_id,questionnaire_version_id) REFERENCES instrument.questionnaire_version(scope_id,id),
 CHECK(period_end IS NULL OR period_end>=period_start),
 CHECK((state='ARCHIVED')=(archived_from IS NOT NULL))
);
CREATE INDEX ON core.assessment_round(organization_id,series_id,period_start,id);
CREATE INDEX ON core.assessment_round(instrument_scope_id,questionnaire_version_id);
CREATE INDEX ON core.assessment_round(created_by);
CREATE INDEX ON core.assessment_round(updated_by);

CREATE TABLE core.campaign (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 round_id uuid NOT NULL, instrument_scope_id uuid NOT NULL, version_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SCHEDULED','OPEN','CLOSED','CANCELLED')),
 starts_at timestamptz NOT NULL, ends_at timestamptz, timezone text NOT NULL,
 target_mode text NOT NULL CHECK(target_mode IN ('SINGLE','SELECTED','DEPARTMENT')),
 requested_target jsonb NOT NULL CHECK(jsonb_typeof(requested_target)='object' AND octet_length(requested_target::text)<=65536),
 locales text[] NOT NULL DEFAULT ARRAY['ar']::text[]
  CHECK(array_length(locales,1) BETWEEN 1 AND 2 AND locales <@ ARRAY['ar','en']::text[] AND 'ar'=ANY(locales)),
 roster_frozen_at timestamptz, frozen_manifest jsonb, frozen_invited_count integer CHECK(frozen_invited_count>0),
 privacy_policy_version integer NOT NULL DEFAULT 1 CHECK(privacy_policy_version>0),
 threshold integer NOT NULL DEFAULT 5 CHECK(threshold>=5),
 closed_at timestamptz, close_kind text CHECK(close_kind IN ('MANUAL','END_DATE')), close_reason text CHECK(length(close_reason)<=500),
 cancelled_at timestamptz, cancel_reason text CHECK(length(cancel_reason)<=500),
 release_state text NOT NULL DEFAULT 'NOT_READY'
  CHECK(release_state IN ('NOT_READY','QUEUED','PROCESSING','PRIVACY_CHECK','PUBLISHED','FAILED','INSUFFICIENT_DATA','REVOKED')),
 archived boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id), UNIQUE(organization_id,round_id),
 FOREIGN KEY(organization_id,round_id) REFERENCES core.assessment_round(organization_id,id),
 FOREIGN KEY(instrument_scope_id,version_id) REFERENCES instrument.questionnaire_version(scope_id,id),
 CHECK(ends_at IS NULL OR ends_at>starts_at),
 CHECK(state IN ('DRAFT','CANCELLED') OR (roster_frozen_at IS NOT NULL AND frozen_manifest IS NOT NULL AND frozen_invited_count IS NOT NULL)),
 CHECK((state='CLOSED')=(closed_at IS NOT NULL)),
 CHECK((closed_at IS NULL)=(close_kind IS NULL)),
 CHECK(close_kind IS DISTINCT FROM 'MANUAL' OR close_reason IS NOT NULL),
 CHECK((state='CANCELLED')=(cancelled_at IS NOT NULL)),
 CHECK((cancelled_at IS NULL)=(cancel_reason IS NULL))
);
CREATE INDEX ON core.campaign(state,starts_at);
CREATE INDEX ON core.campaign(state,ends_at);
CREATE INDEX ON core.campaign(organization_id,release_state);
CREATE INDEX ON core.campaign(instrument_scope_id,version_id);
CREATE INDEX ON core.campaign(created_by);
CREATE INDEX ON core.campaign(updated_by);

CREATE TABLE core.report_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('COMPANY','DEPARTMENT','OTHER')),
 department_id uuid, label jsonb NOT NULL CHECK(jsonb_typeof(label)='object' AND octet_length(label::text)<=2048),
 UNIQUE(organization_id,campaign_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id),
 FOREIGN KEY(organization_id,department_id) REFERENCES core.department(organization_id,id),
 CHECK((kind='DEPARTMENT')=(department_id IS NOT NULL))
);
CREATE UNIQUE INDEX report_group_company ON core.report_group(organization_id,campaign_id) WHERE kind='COMPANY';
CREATE UNIQUE INDEX report_group_other ON core.report_group(organization_id,campaign_id) WHERE kind='OTHER';
CREATE UNIQUE INDEX report_group_department ON core.report_group(organization_id,campaign_id,department_id) WHERE kind='DEPARTMENT';
CREATE INDEX ON core.report_group(organization_id,department_id);

-- The credential is never stored. Only a keyed digest with its key version is
-- persisted; display_reference is an opaque operational label, not a secret.
CREATE TABLE core.invitation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, participant_id uuid NOT NULL,
 display_reference text NOT NULL CHECK(display_reference ~ '^INV-[0-9A-F]{16}$'),
 token_digest bytea CHECK(octet_length(token_digest)=32),
 digest_key_version text CHECK(length(digest_key_version) BETWEEN 1 AND 40),
 token_generation integer NOT NULL DEFAULT 0 CHECK(token_generation>=0),
 status text NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','COMPLETED','REVOKED')),
 issued_at timestamptz, revoke_reason text CHECK(length(revoke_reason)<=500),
 admin_revision bigint NOT NULL DEFAULT 1 CHECK(admin_revision>0),
 UNIQUE(organization_id,campaign_id,id), UNIQUE(organization_id,campaign_id,participant_id),
 UNIQUE(organization_id,campaign_id,participant_id,id), UNIQUE(organization_id,display_reference),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id),
 FOREIGN KEY(organization_id,participant_id) REFERENCES core.participant(organization_id,id),
 CHECK((token_digest IS NULL)=(digest_key_version IS NULL)),
 CHECK((token_digest IS NULL)=(issued_at IS NULL)),
 CHECK(token_digest IS NULL OR token_generation>0),
 CHECK((status='REVOKED')=(revoke_reason IS NOT NULL)),
 CHECK(status<>'REVOKED' OR token_digest IS NULL)
);
CREATE UNIQUE INDEX invitation_token_digest ON core.invitation(token_digest) WHERE token_digest IS NOT NULL;
CREATE INDEX ON core.invitation(organization_id,campaign_id,status);
CREATE INDEX ON core.invitation(organization_id,participant_id);

CREATE TABLE core.campaign_roster (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, participant_id uuid NOT NULL, invitation_id uuid NOT NULL,
 department_snapshot jsonb NOT NULL CHECK(jsonb_typeof(department_snapshot)='object' AND octet_length(department_snapshot::text)<=4096),
 report_group_id uuid NOT NULL,
 eligibility text NOT NULL DEFAULT 'ACTIVE' CHECK(eligibility IN ('ACTIVE','REVOKED')),
 UNIQUE(organization_id,campaign_id,participant_id), UNIQUE(organization_id,campaign_id,invitation_id),
 FOREIGN KEY(organization_id,campaign_id,participant_id,invitation_id)
  REFERENCES core.invitation(organization_id,campaign_id,participant_id,id),
 FOREIGN KEY(organization_id,campaign_id,report_group_id) REFERENCES core.report_group(organization_id,campaign_id,id)
);
CREATE INDEX ON core.campaign_roster(organization_id,campaign_id,report_group_id);
CREATE INDEX ON core.campaign_roster(organization_id,participant_id);

CREATE TABLE ops.private_export (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 kind text NOT NULL CHECK(kind IN ('DIRECTORY','PARTICIPATION','LINKS')),
 campaign_id uuid, requested_by uuid NOT NULL REFERENCES access.staff_user,
 state text NOT NULL DEFAULT 'READY' CHECK(state IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED','REVOKED')),
 storage_key text CHECK(length(storage_key)<=200),
 item_count integer NOT NULL DEFAULT 0 CHECK(item_count>=0),
 expires_at timestamptz NOT NULL, generation_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,generation_key),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id),
 CHECK(kind='DIRECTORY' OR campaign_id IS NOT NULL)
);
CREATE INDEX ON ops.private_export(organization_id,kind,expires_at);
CREATE INDEX ON ops.private_export(organization_id,campaign_id);
CREATE INDEX ON ops.private_export(requested_by);

-- Respondent gateway sessions. Bound to the current token generation so that
-- rotation and revocation invalidate live sessions, not only future links.
-- No client address, user agent, answer, draft or staff-readable column exists.
CREATE SCHEMA intake AUTHORIZATION orgfit_core_owner;
REVOKE ALL ON SCHEMA intake FROM PUBLIC;
GRANT USAGE ON SCHEMA intake TO orgfit_access_executor;
CREATE TABLE intake.respondent_session (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, invitation_id uuid NOT NULL,
 token_generation integer NOT NULL CHECK(token_generation>0),
 session_digest bytea NOT NULL UNIQUE CHECK(octet_length(session_digest)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
 FOREIGN KEY(organization_id,campaign_id,invitation_id) REFERENCES core.invitation(organization_id,campaign_id,id),
 CHECK(expires_at<=absolute_expires_at)
);
CREATE INDEX ON intake.respondent_session(invitation_id);
CREATE INDEX ON intake.respondent_session(expires_at);

ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state']::text[]);

GRANT SELECT ON core.assessment_series,core.assessment_round,core.campaign,core.report_group,core.campaign_roster,ops.private_export TO orgfit_staff;
-- Staff may never read a token digest or its key version, even through a future
-- query mistake. Column privileges enforce that at the database itself.
GRANT SELECT(id,organization_id,campaign_id,participant_id,display_reference,token_generation,status,issued_at,revoke_reason,admin_revision) ON core.invitation TO orgfit_staff;
GRANT SELECT,INSERT,UPDATE,DELETE ON core.assessment_series,core.assessment_round,core.campaign,core.report_group,core.invitation,core.campaign_roster,ops.private_export,intake.respondent_session TO orgfit_access_executor;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['core.assessment_series','core.assessment_round','core.campaign','core.report_group','core.invitation','core.campaign_roster','ops.private_export','intake.respondent_session'] LOOP
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION core.campaign_readable(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT access.has_org(org) AND (access.has_capability('campaigns.manage') OR access.has_capability('participation.read') OR access.has_capability('results.read'))
$$;
CREATE POLICY campaign_read ON core.assessment_series TO orgfit_staff USING(core.campaign_readable(organization_id));
CREATE POLICY campaign_read ON core.assessment_round TO orgfit_staff USING(core.campaign_readable(organization_id));
CREATE POLICY campaign_read ON core.campaign TO orgfit_staff USING(core.campaign_readable(organization_id));
CREATE POLICY campaign_read ON core.report_group TO orgfit_staff USING(core.campaign_readable(organization_id));
CREATE POLICY campaign_read ON core.campaign_roster TO orgfit_staff
 USING(access.has_org(organization_id) AND (access.has_capability('campaigns.manage') OR access.has_capability('participation.read')));
CREATE POLICY campaign_read ON core.invitation TO orgfit_staff
 USING(access.has_org(organization_id) AND (access.has_capability('campaigns.manage') OR access.has_capability('participation.read')));
CREATE POLICY export_read ON ops.private_export TO orgfit_staff
 USING(access.has_org(organization_id) AND (access.has_capability('campaigns.manage') OR access.has_capability('participation.export')));
-- Respondent sessions are never staff-readable; no orgfit_staff policy exists.

CREATE FUNCTION core.campaign_guard(org uuid,lock_org boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('campaigns.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 -- Launch takes the directory organization boundary; closure, end-date and
 -- invitation operations never do, so a late close cannot deadlock a launch.
 IF lock_org THEN
 PERFORM 1 FROM core.organization WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 END IF;
END $$;

CREATE FUNCTION core.mutation_receipt(op text,idem uuid,req_hash bytea) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r access.staff_mutation; BEGIN
 IF idem IS NULL OR req_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO r FROM access.staff_mutation WHERE staff_user_id=access.actor() AND operation=op AND idempotency_key=idem;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF r.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
 RETURN r.resource_id;
END $$;

-- Request-time boundary evaluation. A late scheduler never widens access.
CREATE FUNCTION core.effective_state(state text,starts_at timestamptz,ends_at timestamptz) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE
 WHEN state NOT IN ('SCHEDULED','OPEN') THEN state
 WHEN ends_at IS NOT NULL AND clock_timestamp()>=ends_at THEN 'CLOSED'
 WHEN clock_timestamp()>=starts_at THEN 'OPEN'
 ELSE 'SCHEDULED' END
$$;

CREATE FUNCTION core.normalize_campaign(cid uuid) RETURNS core.campaign LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; ts timestamptz; BEGIN
 SELECT * INTO c FROM core.campaign WHERE id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 ts:=clock_timestamp();
 IF c.state IN ('SCHEDULED','OPEN') THEN
 IF c.ends_at IS NOT NULL AND ts>=c.ends_at THEN
 UPDATE core.campaign SET state='CLOSED',closed_at=ts,close_kind='END_DATE',revision=revision+1,updated_at=ts WHERE id=cid RETURNING * INTO c;
 UPDATE core.assessment_round SET state='PROCESSING',revision=revision+1,updated_at=ts WHERE id=c.round_id AND state='COLLECTING';
 ELSIF c.state='SCHEDULED' AND ts>=c.starts_at THEN
 UPDATE core.campaign SET state='OPEN',revision=revision+1,updated_at=ts WHERE id=cid RETURNING * INTO c;
 END IF;
 END IF;
 RETURN c;
END $$;

CREATE FUNCTION core.normalize_due(max_rows integer DEFAULT 200) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r record; n integer:=0; BEGIN
 FOR r IN SELECT id FROM core.campaign
 WHERE state IN ('SCHEDULED','OPEN') AND core.effective_state(state,starts_at,ends_at)<>state
 ORDER BY id LIMIT greatest(1,max_rows) LOOP
 PERFORM core.normalize_campaign(r.id);
 n:=n+1;
 END LOOP;
 RETURN n;
END $$;

-- Launched campaigns freeze their instrument, roster, groups, notice, policy
-- and threshold. Only lifecycle columns may change afterwards.
CREATE FUNCTION core.campaign_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF OLD.state IN ('CLOSED','CANCELLED') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF OLD.state<>'DRAFT' AND (
  NEW.organization_id<>OLD.organization_id OR NEW.round_id<>OLD.round_id OR NEW.version_id<>OLD.version_id
  OR NEW.instrument_scope_id<>OLD.instrument_scope_id OR NEW.target_mode<>OLD.target_mode
  OR NEW.requested_target<>OLD.requested_target OR NEW.starts_at<>OLD.starts_at OR NEW.timezone<>OLD.timezone
  OR NEW.locales<>OLD.locales OR NEW.threshold<>OLD.threshold OR NEW.privacy_policy_version<>OLD.privacy_policy_version
  OR NEW.frozen_manifest IS DISTINCT FROM OLD.frozen_manifest OR NEW.roster_frozen_at IS DISTINCT FROM OLD.roster_frozen_at
  OR NEW.frozen_invited_count IS DISTINCT FROM OLD.frozen_invited_count) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_frozen BEFORE UPDATE OR DELETE ON core.campaign FOR EACH ROW EXECUTE FUNCTION core.campaign_freeze();

CREATE FUNCTION core.invitation_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF NEW.organization_id<>OLD.organization_id OR NEW.campaign_id<>OLD.campaign_id
  OR NEW.participant_id<>OLD.participant_id OR NEW.display_reference<>OLD.display_reference THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF OLD.status<>'READY' AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF NEW.token_generation<OLD.token_generation THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF NEW.admin_revision<OLD.admin_revision THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invitation_frozen BEFORE UPDATE OR DELETE ON core.invitation FOR EACH ROW EXECUTE FUNCTION core.invitation_freeze();

CREATE FUNCTION core.roster_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF (to_jsonb(NEW)-'eligibility')<>(to_jsonb(OLD)-'eligibility') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER roster_frozen BEFORE UPDATE OR DELETE ON core.campaign_roster FOR EACH ROW EXECUTE FUNCTION core.roster_freeze();
CREATE FUNCTION core.group_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'STATE_CONFLICT'; END $$;
CREATE TRIGGER group_frozen BEFORE UPDATE OR DELETE ON core.report_group FOR EACH ROW EXECUTE FUNCTION core.group_freeze();

CREATE FUNCTION core.save_series(org uuid,target uuid,expected bigint,body jsonb,idem uuid,req_hash bytea,archiving boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); result uuid; oldrev bigint; oldstatus text; op text:=concat('series/',org); BEGIN
 PERFORM core.campaign_guard(org);
 result:=core.mutation_receipt(op,idem,req_hash);
 IF result IS NOT NULL THEN RETURN result; END IF;
 result:=coalesce(target,gen_random_uuid());
 IF target IS NOT NULL THEN
 SELECT revision,status INTO oldrev,oldstatus FROM core.assessment_series WHERE id=target AND organization_id=org FOR UPDATE;
 IF oldrev IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR oldrev<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 IF oldstatus<>'ACTIVE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 END IF;
 IF archiving THEN
 IF target IS NULL OR length(trim(body->>'reason')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM core.assessment_round WHERE organization_id=org AND series_id=target AND state IN ('DRAFT','COLLECTING','PROCESSING')) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE core.assessment_series SET status='ARCHIVED',revision=revision+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=target AND organization_id=org;
 ELSE
 -- The family key is validated against a questionnaire lineage this staff
 -- member may actually read, never against another organization's copy.
 IF NOT EXISTS(SELECT 1 FROM instrument.questionnaire q WHERE q.family_key=(body->>'questionnaireFamilyId')::uuid
  AND (q.organization_id IS NULL OR q.organization_id=org)) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO core.assessment_series(id,organization_id,name_ar,name_en,purpose,questionnaire_family_id,created_by,updated_by)
 VALUES(result,org,body->>'nameAr',body->>'nameEn',body->>'purpose',(body->>'questionnaireFamilyId')::uuid,actor,actor)
 ON CONFLICT(id) DO UPDATE SET name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,purpose=EXCLUDED.purpose,
 questionnaire_family_id=EXCLUDED.questionnaire_family_id,revision=core.assessment_series.revision+1,updated_by=actor,updated_at=clock_timestamp();
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'SERIES_CHANGED',result,ARRAY['series']);
 RETURN result;
END $$;

CREATE FUNCTION core.save_round(org uuid,target uuid,expected bigint,body jsonb,idem uuid,req_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); result uuid; old core.assessment_round; v instrument.questionnaire_version; op text:=concat('round/',org); BEGIN
 PERFORM core.campaign_guard(org);
 result:=core.mutation_receipt(op,idem,req_hash);
 IF result IS NOT NULL THEN RETURN result; END IF;
 result:=coalesce(target,gen_random_uuid());
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=(body->>'questionnaireVersionId')::uuid;
 IF NOT FOUND OR v.state<>'PUBLISHED' OR (v.organization_id IS NOT NULL AND v.organization_id<>org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.assessment_series WHERE organization_id=org AND id=(body->>'seriesId')::uuid AND status='ACTIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF target IS NOT NULL THEN
 SELECT * INTO old FROM core.assessment_round WHERE id=target AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR old.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 -- Version and collection definition are editable only before collection.
 IF old.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF old.series_id<>(body->>'seriesId')::uuid THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 END IF;
 INSERT INTO core.assessment_round(id,organization_id,series_id,label,period_start,period_end,instrument_scope_id,questionnaire_version_id,notes,population_definition,compatibility_group,created_by,updated_by)
 VALUES(result,org,(body->>'seriesId')::uuid,body->>'label',(body->>'periodStart')::date,(body->>'periodEnd')::date,v.scope_id,v.id,body->>'notes',
 coalesce(body->'populationDefinition','{"schemaVersion":1}'),body->>'compatibilityGroup',actor,actor)
 ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,
 instrument_scope_id=EXCLUDED.instrument_scope_id,questionnaire_version_id=EXCLUDED.questionnaire_version_id,notes=EXCLUDED.notes,
 population_definition=EXCLUDED.population_definition,compatibility_group=EXCLUDED.compatibility_group,
 revision=core.assessment_round.revision+1,updated_by=actor,updated_at=clock_timestamp();
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'ROUND_CHANGED',result,ARRAY['round']);
 RETURN result;
END $$;

-- Deduplicated, organization-checked target resolution. Department targeting is
-- flat: it resolves the department's own active members once, at launch.
CREATE FUNCTION core.resolve_target(org uuid,mode text,target jsonb) RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE requested uuid[]; found uuid[]; BEGIN
 IF mode='SINGLE' THEN requested:=ARRAY[(target->>'participantId')::uuid];
 ELSIF mode='SELECTED' THEN SELECT array_agg(DISTINCT x::uuid) INTO requested FROM jsonb_array_elements_text(target->'participantIds') x;
 ELSIF mode='DEPARTMENT' THEN
 IF NOT EXISTS(SELECT 1 FROM core.department WHERE organization_id=org AND id=(target->>'departmentId')::uuid AND status='ACTIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT array_agg(id) INTO requested FROM core.participant WHERE organization_id=org AND status='ACTIVE' AND department_id=(target->>'departmentId')::uuid;
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF requested IS NULL OR array_length(requested,1) IS NULL OR array_position(requested,NULL) IS NOT NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT array_agg(id ORDER BY id) INTO found FROM core.participant WHERE organization_id=org AND status='ACTIVE' AND id=ANY(requested);
 -- An identifier from another organization or an archived person is never
 -- silently dropped; the whole target is rejected.
 IF found IS NULL OR array_length(found,1)<>array_length(requested,1) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 RETURN found;
END $$;

CREATE FUNCTION core.save_campaign(org uuid,target uuid,expected bigint,body jsonb,idem uuid,req_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); result uuid; old core.campaign; r core.assessment_round; v instrument.questionnaire_version;
 mode text:=body->'target'->>'mode'; starts timestamptz; ends timestamptz; op text:=concat('campaign/',org); BEGIN
 PERFORM core.campaign_guard(org);
 result:=core.mutation_receipt(op,idem,req_hash);
 IF result IS NOT NULL THEN RETURN result; END IF;
 result:=coalesce(target,gen_random_uuid());
 SELECT * INTO r FROM core.assessment_round WHERE id=(body->>'roundId')::uuid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- Exactly one campaign per round, reported before the unique index fires.
 IF EXISTS(SELECT 1 FROM core.campaign WHERE organization_id=org AND round_id=r.id AND (target IS NULL OR id<>target)) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=(body->>'questionnaireVersionId')::uuid;
 IF NOT FOUND OR v.state<>'PUBLISHED' OR (v.organization_id IS NOT NULL AND v.organization_id<>org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- A campaign pins exactly the round's version; it can never pin another one.
 IF v.id<>r.questionnaire_version_id THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=body->>'timezone') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 starts:=(body->>'startsAt')::timestamptz; ends:=(body->>'endsAt')::timestamptz;
 IF starts IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF ends IS NOT NULL AND ends<=starts THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM core.resolve_target(org,mode,body->'target');
 IF target IS NOT NULL THEN
 SELECT * INTO old FROM core.campaign WHERE id=target AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR old.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 IF old.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF old.round_id<>r.id THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 END IF;
 INSERT INTO core.campaign(id,organization_id,round_id,instrument_scope_id,version_id,starts_at,ends_at,timezone,target_mode,requested_target,locales,privacy_policy_version,threshold,created_by,updated_by)
 VALUES(result,org,r.id,v.scope_id,v.id,starts,ends,body->>'timezone',mode,body->'target',
 coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(body->'locales') x),ARRAY['ar']::text[]),
 coalesce((body->>'privacyPolicyVersion')::integer,1),coalesce((body->>'threshold')::integer,5),actor,actor)
 ON CONFLICT(id) DO UPDATE SET instrument_scope_id=EXCLUDED.instrument_scope_id,version_id=EXCLUDED.version_id,starts_at=EXCLUDED.starts_at,
 ends_at=EXCLUDED.ends_at,timezone=EXCLUDED.timezone,target_mode=EXCLUDED.target_mode,requested_target=EXCLUDED.requested_target,
 locales=EXCLUDED.locales,privacy_policy_version=EXCLUDED.privacy_policy_version,threshold=EXCLUDED.threshold,
 revision=core.campaign.revision+1,updated_by=actor,updated_at=clock_timestamp();
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'CAMPAIGN_CHANGED',result,ARRAY['campaign']);
 RETURN result;
END $$;

-- Launch is the freeze point: roster, groups, instrument, notice, locales,
-- policy and threshold are captured once and never recomputed.
CREATE FUNCTION core.launch_campaign(org uuid,cid uuid,expected bigint,idem uuid,req_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); result uuid; c core.campaign; r core.assessment_round; v instrument.questionnaire_version;
 people uuid[]; pid uuid; p core.participant; d core.department; company uuid; other uuid; grp uuid; inv uuid; ref text; ts timestamptz;
 groups jsonb; manifest jsonb; policy jsonb; next_state text; op text:=concat('campaign-launch/',org); BEGIN
 PERFORM core.campaign_guard(org,true);
 result:=core.mutation_receipt(op,idem,req_hash);
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR c.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 IF c.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT * INTO r FROM core.assessment_round WHERE id=c.round_id AND organization_id=org FOR UPDATE;
 IF r.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=c.version_id AND scope_id=c.instrument_scope_id;
 IF NOT FOUND OR v.state<>'PUBLISHED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 ts:=clock_timestamp();
 IF c.ends_at IS NOT NULL AND ts>=c.ends_at THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 people:=core.resolve_target(org,c.target_mode,c.requested_target);
 INSERT INTO core.report_group(organization_id,campaign_id,kind,label)
 SELECT org,cid,'COMPANY',jsonb_build_object('ar',o.name_ar,'en',coalesce(o.name_en,o.name_ar)) FROM core.organization o WHERE o.id=org RETURNING id INTO company;
 FOREACH pid IN ARRAY people LOOP
 SELECT * INTO p FROM core.participant WHERE id=pid AND organization_id=org;
 IF p.department_id IS NULL THEN
 IF other IS NULL THEN
 INSERT INTO core.report_group(organization_id,campaign_id,kind,label)
 VALUES(org,cid,'OTHER',jsonb_build_object('ar','بدون قسم محدد','en','No assigned department')) RETURNING id INTO other;
 END IF;
 grp:=other;
 ELSE
 SELECT id INTO grp FROM core.report_group WHERE organization_id=org AND campaign_id=cid AND kind='DEPARTMENT' AND department_id=p.department_id;
 IF grp IS NULL THEN
 SELECT * INTO d FROM core.department WHERE id=p.department_id AND organization_id=org;
 INSERT INTO core.report_group(organization_id,campaign_id,kind,department_id,label)
 VALUES(org,cid,'DEPARTMENT',d.id,jsonb_build_object('ar',d.name_ar,'en',coalesce(d.name_en,d.name_ar))) RETURNING id INTO grp;
 END IF;
 END IF;
 LOOP
 ref:=concat('INV-',upper(substr(encode(uuid_send(gen_random_uuid()),'hex'),1,16)));
 EXIT WHEN NOT EXISTS(SELECT 1 FROM core.invitation WHERE organization_id=org AND display_reference=ref);
 END LOOP;
 INSERT INTO core.invitation(organization_id,campaign_id,participant_id,display_reference) VALUES(org,cid,p.id,ref) RETURNING id INTO inv;
 INSERT INTO core.campaign_roster(organization_id,campaign_id,participant_id,invitation_id,report_group_id,department_snapshot)
 VALUES(org,cid,p.id,inv,grp,jsonb_strip_nulls(jsonb_build_object(
  'schemaVersion',1,'departmentId',p.department_id,
  'departmentCode',(SELECT code FROM core.department WHERE id=p.department_id AND organization_id=org),
  'departmentNameAr',(SELECT name_ar FROM core.department WHERE id=p.department_id AND organization_id=org),
  'departmentNameEn',(SELECT name_en FROM core.department WHERE id=p.department_id AND organization_id=org),
  'jobLevel',p.job_level,'position',p.position)));
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('id',g.id,'kind',g.kind,'label',g.label) ORDER BY g.kind,g.id) INTO groups
 FROM core.report_group g WHERE g.organization_id=org AND g.campaign_id=cid;
 policy:=jsonb_build_object('schemaVersion',1,'version',c.privacy_policy_version,'threshold',c.threshold,
 'segmentation','FLAT_DEPARTMENT','smallDepartment','COMPANY_ONLY','qualitative','WITHHELD','singleRelease',true);
 manifest:=jsonb_build_object('schemaVersion',1,'instrumentHash',encode(v.schema_hash,'hex'),'versionId',v.id,
 'allowedGroups',groups,'locales',to_jsonb(c.locales),'notice',coalesce(v.metadata->'privacyText','{}'::jsonb),
 'policy',policy,'startsAt',c.starts_at,'timezone',c.timezone);
 next_state:=CASE WHEN ts>=c.starts_at THEN 'OPEN' ELSE 'SCHEDULED' END;
 UPDATE core.campaign SET state=next_state,roster_frozen_at=ts,frozen_manifest=manifest,
 frozen_invited_count=array_length(people,1),revision=revision+1,updated_at=ts,updated_by=actor WHERE id=cid;
 UPDATE core.assessment_round SET state='COLLECTING',revision=revision+1,updated_at=ts,updated_by=actor WHERE id=r.id;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,cid);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'CAMPAIGN_LAUNCHED',cid,ARRAY['campaign','round']);
 RETURN cid;
END $$;

CREATE FUNCTION core.campaign_transition(org uuid,cid uuid,expected bigint,action text,reason text,new_end timestamptz,idem uuid,req_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); result uuid; c core.campaign; ts timestamptz; op text:=concat('campaign-transition/',org); BEGIN
 -- Deliberately no organization lock: closure must never wait on a launch.
 PERFORM core.campaign_guard(org,false);
 result:=core.mutation_receipt(op,idem,req_hash);
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR c.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 c:=core.normalize_campaign(cid);
 ts:=clock_timestamp();
 IF action='CLOSE' THEN
 IF c.state<>'OPEN' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF length(trim(coalesce(reason,''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.campaign SET state='CLOSED',closed_at=ts,close_kind='MANUAL',close_reason=reason,revision=revision+1,updated_at=ts,updated_by=actor WHERE id=cid;
 UPDATE core.assessment_round SET state='PROCESSING',revision=revision+1,updated_at=ts,updated_by=actor WHERE id=c.round_id AND state='COLLECTING';
 ELSIF action='CANCEL' THEN
 IF c.state NOT IN ('DRAFT','SCHEDULED','OPEN') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF length(trim(coalesce(reason,''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.campaign SET state='CANCELLED',cancelled_at=ts,cancel_reason=reason,revision=revision+1,updated_at=ts,updated_by=actor WHERE id=cid;
 UPDATE core.assessment_round SET state='CANCELLED',revision=revision+1,updated_at=ts,updated_by=actor WHERE id=c.round_id AND state IN ('DRAFT','COLLECTING');
 ELSIF action='ARCHIVE' THEN
 IF c.state NOT IN ('CLOSED','CANCELLED') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE core.campaign SET archived=true,revision=revision+1,updated_at=ts,updated_by=actor WHERE id=cid;
 ELSIF action='END_DATE' THEN
 IF c.state NOT IN ('DRAFT','SCHEDULED','OPEN') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- An end boundary that has already passed can never be moved forward again.
 IF c.ends_at IS NOT NULL AND c.ends_at<=ts THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF new_end IS NOT NULL AND (new_end<=c.starts_at OR new_end<=ts) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.campaign SET ends_at=new_end,revision=revision+1,updated_at=ts,updated_by=actor WHERE id=cid;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'CAMPAIGN_END_DATE_CHANGED',cid,ARRAY['campaign','endsAt']);
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,cid);
 IF action<>'END_DATE' THEN
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'CAMPAIGN_CHANGED',cid,ARRAY['campaign','state']);
 END IF;
 RETURN cid;
END $$;

-- Issue, rotate and revoke. The raw credential never reaches this function or
-- any receipt; only its keyed digest and key version are persisted.
CREATE FUNCTION core.invitation_action(org uuid,cid uuid,inv uuid,action text,expected_generation integer,reason text,new_digest bytea,key_version text,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); receipt uuid; c core.campaign; i core.invitation; ts timestamptz; op text:=concat('invitation/',org); BEGIN
 PERFORM core.campaign_guard(org,false);
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN
 -- A retried issue never re-reveals a credential; the caller reads status.
 RETURN (SELECT jsonb_build_object('replayed',true,'generation',token_generation,'status',status,
  'displayReference',display_reference) FROM core.invitation WHERE id=receipt);
 END IF;
 c:=core.normalize_campaign(cid);
 IF c.organization_id<>org THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF c.state NOT IN ('SCHEDULED','OPEN') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT * INTO i FROM core.invitation WHERE id=inv AND campaign_id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF i.status<>'READY' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF expected_generation IS NULL OR expected_generation<>i.token_generation THEN RAISE EXCEPTION 'TOKEN_ALREADY_ISSUED'; END IF;
 ts:=clock_timestamp();
 IF action='ISSUE' THEN
 IF i.token_generation<>0 THEN RAISE EXCEPTION 'TOKEN_ALREADY_ISSUED'; END IF;
 IF octet_length(new_digest)<>32 OR key_version IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.invitation SET token_digest=new_digest,digest_key_version=key_version,issued_at=ts,token_generation=1,admin_revision=admin_revision+1 WHERE id=inv;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INVITATION_ISSUED',inv,ARRAY['invitation']);
 ELSIF action='ROTATE' THEN
 IF i.token_generation<1 THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF octet_length(new_digest)<>32 OR key_version IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.invitation SET token_digest=new_digest,digest_key_version=key_version,issued_at=ts,
 token_generation=token_generation+1,admin_revision=admin_revision+1 WHERE id=inv;
 DELETE FROM intake.respondent_session WHERE invitation_id=inv;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INVITATION_ROTATED',inv,ARRAY['invitation']);
 ELSIF action='REVOKE' THEN
 IF length(trim(coalesce(reason,''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.invitation SET status='REVOKED',revoke_reason=reason,token_digest=NULL,digest_key_version=NULL,issued_at=NULL,
 admin_revision=admin_revision+1 WHERE id=inv;
 UPDATE core.campaign_roster SET eligibility='REVOKED' WHERE organization_id=org AND campaign_id=cid AND invitation_id=inv;
 DELETE FROM intake.respondent_session WHERE invitation_id=inv;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INVITATION_REVOKED',inv,ARRAY['invitation']);
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,inv);
 RETURN (SELECT jsonb_build_object('replayed',false,'generation',token_generation,'status',status,
  'displayReference',display_reference) FROM core.invitation WHERE id=inv);
END $$;

CREATE FUNCTION core.record_link_export(org uuid,cid uuid,export uuid,generation_key uuid,storage_key text,items integer,ttl interval) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); BEGIN
 PERFORM core.campaign_guard(org,false);
 IF ttl>interval '24 hours' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO ops.private_export(id,organization_id,kind,campaign_id,requested_by,state,storage_key,item_count,expires_at,generation_key)
 VALUES(export,org,'LINKS',cid,actor,'READY',storage_key,items,clock_timestamp()+ttl,generation_key);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'LINK_EXPORT_CREATED',export,ARRAY['export','invitation']);
END $$;
CREATE FUNCTION core.link_export_download(org uuid,export uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e ops.private_export; BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (access.has_capability('campaigns.manage') OR access.has_capability('participation.export')) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO e FROM ops.private_export WHERE id=export AND organization_id=org AND kind='LINKS';
 IF NOT FOUND OR e.state<>'READY' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(access.actor(),org,'LINK_EXPORT_DOWNLOADED',export,ARRAY['export']);
 RETURN e.storage_key;
END $$;

-- Named participation lists and their denominators. Identity never joins to an
-- answer here: there are no answers, response identifiers or scores at all.
CREATE FUNCTION core.participation(org uuid,cid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE items jsonb; invited integer; completed integer; revoked integer; BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (access.has_capability('campaigns.manage') OR access.has_capability('participation.read')) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT jsonb_agg(jsonb_build_object('invitationId',i.id,'participantId',i.participant_id,'displayReference',i.display_reference,
  'displayName',p.display_name,'status',i.status,'issued',i.token_generation>0,'generation',i.token_generation,
  'reportGroupId',cr.report_group_id) ORDER BY p.display_name,i.id),
 count(*) FILTER (WHERE true), count(*) FILTER (WHERE i.status='COMPLETED'), count(*) FILTER (WHERE i.status='REVOKED')
 INTO items,invited,completed,revoked
 FROM core.invitation i JOIN core.participant p ON p.id=i.participant_id AND p.organization_id=i.organization_id
 LEFT JOIN core.campaign_roster cr ON cr.invitation_id=i.id AND cr.organization_id=i.organization_id
 WHERE i.organization_id=org AND i.campaign_id=cid;
 invited:=coalesce(invited,0); completed:=coalesce(completed,0); revoked:=coalesce(revoked,0);
 RETURN jsonb_build_object('items',coalesce(items,'[]'::jsonb),'totals',jsonb_build_object(
  'invited',invited,'completed',completed,'revoked',revoked,
  'outstanding',invited-completed-revoked,'eligible',invited-revoked,
  'rate',CASE WHEN invited-revoked=0 THEN NULL ELSE round(completed::numeric/(invited-revoked),4) END));
END $$;

-- Gateway contract for Phase 07. Opening never consumes an invitation and never
-- returns a name, participant identifier, answer, draft or score.
CREATE FUNCTION core.gateway_status(session_digest_in bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s intake.respondent_session; i core.invitation; c core.campaign; ts timestamptz:=clock_timestamp(); state text; BEGIN
 IF octet_length(session_digest_in)<>32 THEN RETURN jsonb_build_object('access','UNAVAILABLE'); END IF;
 SELECT * INTO s FROM intake.respondent_session WHERE session_digest=session_digest_in;
 IF NOT FOUND OR s.expires_at<=ts OR s.absolute_expires_at<=ts THEN RETURN jsonb_build_object('access','SESSION_EXPIRED'); END IF;
 SELECT * INTO i FROM core.invitation WHERE id=s.invitation_id;
 -- Rotation and revocation invalidate live sessions through this check as well
 -- as by deleting session rows, so a replayed cookie cannot outlive its token.
 IF i.status='REVOKED' OR i.token_generation<>s.token_generation THEN RETURN jsonb_build_object('access','UNAVAILABLE'); END IF;
 SELECT * INTO c FROM core.campaign WHERE id=s.campaign_id;
 IF i.status='COMPLETED' THEN RETURN jsonb_build_object('access','ACCEPTED'); END IF;
 state:=core.effective_state(c.state,c.starts_at,c.ends_at);
 RETURN jsonb_build_object('access',CASE
  WHEN c.state='CANCELLED' THEN 'UNAVAILABLE'
  WHEN state='SCHEDULED' THEN 'NOT_YET_OPEN'
  WHEN state='OPEN' THEN 'OPEN'
  ELSE 'CLOSED' END,
  'campaignId',c.id,'versionId',c.version_id,'locales',to_jsonb(c.locales),
  'notice',coalesce(c.frozen_manifest->'notice','{}'::jsonb),'endsAt',c.ends_at);
END $$;

CREATE FUNCTION core.gateway_exchange(token_digest_in bytea,session_digest_in bytea,idle interval DEFAULT interval '2 hours',absolute interval DEFAULT interval '12 hours') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; c core.campaign; ts timestamptz; BEGIN
 IF octet_length(token_digest_in)<>32 OR octet_length(session_digest_in)<>32 THEN RETURN jsonb_build_object('access','UNAVAILABLE'); END IF;
 SELECT * INTO i FROM core.invitation WHERE token_digest=token_digest_in;
 IF NOT FOUND OR i.status='REVOKED' THEN RETURN jsonb_build_object('access','UNAVAILABLE'); END IF;
 c:=core.normalize_campaign(i.campaign_id);
 ts:=clock_timestamp();
 INSERT INTO intake.respondent_session(organization_id,campaign_id,invitation_id,token_generation,session_digest,expires_at,absolute_expires_at)
 VALUES(i.organization_id,i.campaign_id,i.id,i.token_generation,session_digest_in,ts+idle,ts+absolute);
 RETURN core.gateway_status(session_digest_in);
END $$;
-- Launch review. Staff holding campaigns.manage but not directory.manage may
-- see resolved counts and group shape, never the private participant rows.
CREATE FUNCTION core.launch_review(org uuid,cid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; people uuid[]; groups jsonb; invited integer; BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('campaigns.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF c.state<>'DRAFT' THEN
 SELECT jsonb_agg(jsonb_build_object('kind',g.kind,'label',g.label,'count',
  (SELECT count(*) FROM core.campaign_roster r WHERE r.campaign_id=cid AND r.report_group_id=g.id))
  ORDER BY g.kind,g.id) INTO groups FROM core.report_group g WHERE g.organization_id=org AND g.campaign_id=cid;
 invited:=c.frozen_invited_count;
 ELSE
 people:=core.resolve_target(org,c.target_mode,c.requested_target);
 invited:=array_length(people,1);
 SELECT jsonb_agg(jsonb_build_object('kind',x.kind,'label',jsonb_build_object('ar',x.label),'count',x.n) ORDER BY x.kind,x.label)
 INTO groups FROM (
  SELECT CASE WHEN p.department_id IS NULL THEN 'OTHER' ELSE 'DEPARTMENT' END kind,
  coalesce(d.name_ar,'بدون قسم محدد') label, count(*) n
  FROM core.participant p LEFT JOIN core.department d ON d.id=p.department_id AND d.organization_id=org
  WHERE p.organization_id=org AND p.id=ANY(people) GROUP BY 1,2) x;
 END IF;
 -- A campaign smaller than its own threshold can never release a metric.
 RETURN jsonb_build_object('state',c.state,'frozen',c.state<>'DRAFT','invited',invited,
  'groups',coalesce(groups,'[]'::jsonb),'threshold',c.threshold,
  'reportEligible',invited>=c.threshold,'singlePerson',c.target_mode='SINGLE');
END $$;

-- Authorized request-time read. Normalization is a system clock transition,
-- never a staff edit, but it is still confined to one authorized organization.
CREATE FUNCTION core.campaign_view(org uuid,cid uuid) RETURNS core.campaign LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT core.campaign_readable(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN core.normalize_campaign(cid);
END $$;

-- One atomic issuance/rotation plan for a manual link export. Invitations are
-- locked in identifier order. Any unexpected generation, wrong campaign or
-- completed invitation aborts the entire plan; nothing is issued or rotated.
CREATE FUNCTION core.issue_export_plan(org uuid,cid uuid,ids uuid[],expected integer[],digests bytea[],key_version text,confirm boolean,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); receipt uuid; c core.campaign; i core.invitation; ts timestamptz; k integer;
 out_rows jsonb:='[]'::jsonb; op text:=concat('link-export/',org); BEGIN
 PERFORM core.campaign_guard(org,false);
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN RAISE EXCEPTION 'TOKEN_ALREADY_ISSUED'; END IF;
 IF array_length(ids,1) IS NULL OR array_length(ids,1)<>array_length(expected,1)
  OR array_length(ids,1)<>array_length(digests,1) OR key_version IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 c:=core.normalize_campaign(cid);
 IF c.organization_id<>org THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF c.state NOT IN ('SCHEDULED','OPEN') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 ts:=clock_timestamp();
 FOR k IN 1..array_length(ids,1) LOOP
 SELECT * INTO i FROM core.invitation WHERE id=ids[k] AND campaign_id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF i.status<>'READY' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF expected[k] IS NULL OR expected[k]<>i.token_generation THEN RAISE EXCEPTION 'TOKEN_ALREADY_ISSUED'; END IF;
 IF i.token_generation>0 AND NOT confirm THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 IF octet_length(digests[k])<>32 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.invitation SET token_digest=digests[k],digest_key_version=key_version,issued_at=ts,
  token_generation=token_generation+1,admin_revision=admin_revision+1 WHERE id=i.id;
 DELETE FROM intake.respondent_session WHERE invitation_id=i.id;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,CASE WHEN i.token_generation>0 THEN 'INVITATION_ROTATED' ELSE 'INVITATION_ISSUED' END,i.id,ARRAY['invitation']);
 out_rows:=out_rows||jsonb_build_array(jsonb_build_object('invitationId',i.id,'displayReference',i.display_reference,
  'generation',i.token_generation+1,'rotated',i.token_generation>0));
 END LOOP;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,cid);
 RETURN out_rows;
END $$;

GRANT CREATE ON SCHEMA core,ops TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='core' AND p.proname IN ('campaign_guard','mutation_receipt','effective_state','normalize_campaign','normalize_due',
 'campaign_freeze','invitation_freeze','roster_freeze','group_freeze','campaign_readable','save_series','save_round','resolve_target',
 'save_campaign','launch_campaign','campaign_transition','invitation_action','record_link_export','link_export_download','participation',
 'gateway_exchange','gateway_status','launch_review','campaign_view','issue_export_plan') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA core,ops FROM orgfit_access_executor;
GRANT EXECUTE ON FUNCTION core.campaign_readable(uuid),core.effective_state(text,timestamptz,timestamptz),
 core.save_series(uuid,uuid,bigint,jsonb,uuid,bytea,boolean),core.save_round(uuid,uuid,bigint,jsonb,uuid,bytea),
 core.save_campaign(uuid,uuid,bigint,jsonb,uuid,bytea),core.launch_campaign(uuid,uuid,bigint,uuid,bytea),
 core.campaign_transition(uuid,uuid,bigint,text,text,timestamptz,uuid,bytea),
 core.invitation_action(uuid,uuid,uuid,text,integer,text,bytea,text,uuid,bytea),core.campaign_view(uuid,uuid),
 core.issue_export_plan(uuid,uuid,uuid[],integer[],bytea[],text,boolean,uuid,bytea),
 core.record_link_export(uuid,uuid,uuid,uuid,text,integer,interval),core.link_export_download(uuid,uuid),
 core.participation(uuid,uuid),core.launch_review(uuid,uuid) TO orgfit_staff;
-- Deliberately NOT granted to orgfit_staff: normalize_due (scheduler credential),
-- gateway_exchange and gateway_status (respondent gateway credential, Phase 07).
GRANT EXECUTE ON FUNCTION core.normalize_due(integer),core.gateway_exchange(bytea,bytea,interval,interval),core.gateway_status(bytea) TO orgfit_core_owner;
