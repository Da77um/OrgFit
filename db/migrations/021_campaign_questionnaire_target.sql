-- ===========================================================================
-- Campaigns honour their questionnaire's target (020).
--
-- The audience of a campaign is bounded by the questionnaire it collects:
--
--   questionnaire targets the ENTIRE ORGANIZATION (no departments selected)
--     -> every active participant of that organization is eligible;
--   questionnaire targets DEPARTMENTS
--     -> only active participants whose department is one of them.
--
-- A new campaign target mode, ALL, invites that whole eligible audience,
-- resolved once at launch like DEPARTMENT. The existing SINGLE, SELECTED and
-- DEPARTMENT modes stay, but every person they resolve must be eligible, and a
-- DEPARTMENT campaign must name a targeted department; otherwise the save,
-- the launch review and the launch refuse with OUTSIDE_QUESTIONNAIRE_TARGET.
-- Department targeting stays flat, as in 008: a child department is not
-- implied by its parent. A global library questionnaire has no departments, so
-- it targets the entire organization running the campaign.
--
-- The check runs again at launch, inside the organization lock that a target
-- change (instrument.save_target) and a directory edit also take, so a target
-- narrowed after a draft was saved is still enforced. The roster frozen at
-- launch is unchanged by any later target edit.
--
-- save_campaign, launch_campaign and launch_review are restated from 008 with
-- only the target resolution replaced (and launch_review reporting the
-- questionnaire target); nothing else in them changes.
-- ===========================================================================

ALTER TABLE core.campaign DROP CONSTRAINT campaign_target_mode_check;
ALTER TABLE core.campaign ADD CONSTRAINT campaign_target_mode_check CHECK(target_mode IN ('SINGLE','SELECTED','DEPARTMENT','ALL'));

-- The questionnaire target behind a pinned version: its mode and, for
-- DEPARTMENTS, the targeted department identifiers of this organization.
CREATE FUNCTION core.questionnaire_audience(org uuid,version uuid,OUT mode text,OUT departments uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q instrument.questionnaire; BEGIN
 SELECT qq.* INTO q FROM instrument.questionnaire_version v
  JOIN instrument.questionnaire qq ON qq.scope_id=v.scope_id AND qq.id=v.questionnaire_id
  WHERE v.id=version AND (v.organization_id IS NULL OR v.organization_id=org);
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 mode:=CASE WHEN q.organization_id IS NULL THEN 'ORGANIZATION' ELSE q.target_mode END;
 departments:=CASE WHEN mode='DEPARTMENTS' THEN coalesce((SELECT array_agg(t.department_id ORDER BY t.department_id)
  FROM instrument.questionnaire_department t WHERE t.organization_id=org AND t.questionnaire_id=q.id),'{}'::uuid[]) ELSE '{}'::uuid[] END;
END $$;

CREATE FUNCTION core.resolve_campaign_target(org uuid,mode text,target jsonb,version uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record; people uuid[]; BEGIN
 SELECT * INTO a FROM core.questionnaire_audience(org,version);
 IF mode='ALL' THEN
  IF target IS DISTINCT FROM '{"mode":"ALL"}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
  SELECT array_agg(p.id ORDER BY p.id) INTO people FROM core.participant p
   WHERE p.organization_id=org AND p.status='ACTIVE' AND (a.mode='ORGANIZATION' OR p.department_id=ANY(a.departments));
  IF people IS NULL THEN RAISE EXCEPTION 'NO_ELIGIBLE_PARTICIPANTS'; END IF;
  RETURN people;
 END IF;
 IF mode='DEPARTMENT' AND a.mode='DEPARTMENTS' AND NOT coalesce((target->>'departmentId')::uuid=ANY(a.departments),false) THEN
  RAISE EXCEPTION 'OUTSIDE_QUESTIONNAIRE_TARGET';
 END IF;
 people:=core.resolve_target(org,mode,target);
 IF a.mode='DEPARTMENTS' AND EXISTS(SELECT 1 FROM core.participant p WHERE p.organization_id=org AND p.id=ANY(people)
  AND (p.department_id IS NULL OR NOT p.department_id=ANY(a.departments))) THEN
  RAISE EXCEPTION 'OUTSIDE_QUESTIONNAIRE_TARGET';
 END IF;
 RETURN people;
END $$;

CREATE OR REPLACE FUNCTION core.save_campaign(org uuid,target uuid,expected bigint,body jsonb,idem uuid,req_hash bytea) RETURNS uuid
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
 -- 021: bounded by the questionnaire's target.
 PERFORM core.resolve_campaign_target(org,mode,body->'target',v.id);
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

CREATE OR REPLACE FUNCTION core.launch_campaign(org uuid,cid uuid,expected bigint,idem uuid,req_hash bytea) RETURNS uuid
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
 -- 021: re-checked here, under the organization lock, against the current target.
 people:=core.resolve_campaign_target(org,c.target_mode,c.requested_target,c.version_id);
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

-- The review also reports the questionnaire target, and for a draft whose
-- audience no longer fits it, the refusal code instead of failing the page.
CREATE OR REPLACE FUNCTION core.launch_review(org uuid,cid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; people uuid[]; groups jsonb; invited integer; a record; qtarget jsonb; problem text; BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('campaigns.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO a FROM core.questionnaire_audience(org,c.version_id);
 qtarget:=jsonb_build_object('mode',a.mode,'departments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'code',d.code,'nameAr',d.name_ar,'nameEn',d.name_en) ORDER BY d.name_ar,d.id)
  FROM core.department d WHERE d.organization_id=org AND d.id=ANY(a.departments)),'[]'::jsonb));
 IF c.state<>'DRAFT' THEN
 SELECT jsonb_agg(jsonb_build_object('kind',g.kind,'label',g.label,'count',
  (SELECT count(*) FROM core.campaign_roster r WHERE r.campaign_id=cid AND r.report_group_id=g.id))
  ORDER BY g.kind,g.id) INTO groups FROM core.report_group g WHERE g.organization_id=org AND g.campaign_id=cid;
 invited:=c.frozen_invited_count;
 ELSE
 BEGIN
  people:=core.resolve_campaign_target(org,c.target_mode,c.requested_target,c.version_id);
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT IN ('OUTSIDE_QUESTIONNAIRE_TARGET','NO_ELIGIBLE_PARTICIPANTS') THEN RAISE; END IF;
  problem:=SQLERRM; people:='{}'::uuid[];
 END;
 invited:=coalesce(array_length(people,1),0);
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
  'reportEligible',invited>=c.threshold,'singlePerson',c.target_mode='SINGLE',
  'questionnaireTarget',qtarget,'targetProblem',problem);
END $$;

GRANT CREATE ON SCHEMA core TO orgfit_access_executor;
ALTER FUNCTION core.questionnaire_audience(uuid,uuid) OWNER TO orgfit_access_executor;
ALTER FUNCTION core.resolve_campaign_target(uuid,text,jsonb,uuid) OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA core FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION core.questionnaire_audience(uuid,uuid),core.resolve_campaign_target(uuid,text,jsonb,uuid) FROM PUBLIC;
