-- Phase 09: deterministic recommendation rules, computed instances and actions.
--
-- Three separate things live here, and keeping them apart is the point:
--
--   1. instrument.recommendation_rule — versioned CONFIGURATION. A rule is a
--      node of the questionnaire version like a question or a band, so it
--      freezes with that version's publish, travels inside the pinned
--      instrument snapshot the processor carries, and can never be edited in
--      place afterwards. Changing a rule means a new draft version.
--   2. publication.recommendation_instance — the COMPUTED result. It is written
--      only by publication.publish_release, only beside the release it belongs
--      to, and it is immutable. Every metric it names must be an AVAILABLE cell
--      of the same snapshot AND the same group: a recommendation may never be
--      evidence of a value the disclosure engine withheld.
--   3. core.recommendation_action — the STAFF workflow record. Owner, status,
--      due date, notes and resolution live here, separate from the computed
--      instance, so a consultant opinion can never be relabelled as an
--      automatic result and no staff edit can rewrite the frozen evidence.

-- ---------------------------------------------------------------------------
-- 1. Rules as instrument nodes.
-- ---------------------------------------------------------------------------
CREATE TABLE instrument.recommendation_rule (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL, organization_id uuid REFERENCES core.organization, version_id uuid NOT NULL,
 stable_key uuid NOT NULL, position integer NOT NULL CHECK(position>=0), parent_id uuid, payload jsonb NOT NULL,
 -- The target dimension is relational, so a rule cannot survive pointing at a
 -- dimension that no longer exists in its own version.
 dimension_id uuid,
 UNIQUE(scope_id,version_id,id), UNIQUE(scope_id,version_id,stable_key), UNIQUE NULLS NOT DISTINCT(scope_id,version_id,parent_id,position),
 FOREIGN KEY(scope_id,version_id) REFERENCES instrument.questionnaire_version(scope_id,id),
 FOREIGN KEY(scope_id,version_id,dimension_id) REFERENCES instrument.dimension(scope_id,version_id,id),
 CHECK(jsonb_typeof(payload)='object' AND (payload->>'id')::uuid=id AND (payload->>'key')::uuid=stable_key),
 CHECK(parent_id IS NULL)
);
CREATE INDEX ON instrument.recommendation_rule(organization_id,version_id);
CREATE INDEX ON instrument.recommendation_rule(scope_id,version_id,parent_id);
CREATE INDEX ON instrument.recommendation_rule(scope_id,version_id,dimension_id);
ALTER TABLE instrument.recommendation_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument.recommendation_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON instrument.recommendation_rule TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON instrument.recommendation_rule TO orgfit_core_owner USING(true) WITH CHECK(true);
CREATE POLICY staff_read ON instrument.recommendation_rule TO orgfit_staff USING(instrument.can_read(organization_id));
CREATE TRIGGER scope_check BEFORE INSERT OR UPDATE ON instrument.recommendation_rule FOR EACH ROW EXECUTE FUNCTION instrument.scope_check();
-- The same draft-only guard every other instrument child carries: a published
-- version's rules are as immutable as its questions.
CREATE TRIGGER draft_only BEFORE INSERT OR UPDATE OR DELETE ON instrument.recommendation_rule FOR EACH ROW EXECUTE FUNCTION instrument.draft_child();
GRANT SELECT ON instrument.recommendation_rule TO orgfit_staff;
GRANT SELECT,INSERT,UPDATE,DELETE ON instrument.recommendation_rule TO orgfit_access_executor;

-- The node table list becomes data rather than three literals inside the
-- writer, so a later phase adds a node table without restating this function.
CREATE FUNCTION instrument.node_tables() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ARRAY['section','dimension','question','question_option','matrix_row','matrix_column','score_definition','interpretation_band','recommendation_rule']
$$;

-- Replaced only to write the new node table; the guard, idempotency, revision
-- and lifecycle behaviour is unchanged from migration 005.
CREATE OR REPLACE FUNCTION instrument.write_version(org uuid,qid uuid,vid uuid,expected bigint,action text,body jsonb,nodes jsonb,hash bytea,idem uuid,request_hash bytea,source_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q instrument.questionnaire; v instrument.questionnaire_version; src instrument.questionnaire_version; receipt access.staff_mutation; sid uuid; result uuid:=coalesce(vid,gen_random_uuid()); n jsonb; tab text; tabs text[]:=instrument.node_tables(); i integer; actor uuid:=access.actor(); op text:=concat('instrument/',org); BEGIN
 PERFORM instrument.guard(org);
 PERFORM pg_advisory_xact_lock(80400);
 IF idem IS NULL OR request_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO receipt FROM access.staff_mutation WHERE staff_user_id=actor AND operation=op AND idempotency_key=idem;
 IF FOUND THEN IF receipt.request_digest<>request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN receipt.resource_id; END IF;
 IF action NOT IN ('CREATE','SAVE','PUBLISH','RETIRE','NEW_VERSION','ARCHIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF source_id IS NOT NULL THEN
 SELECT * INTO src FROM instrument.questionnaire_version WHERE id=source_id;
 IF NOT FOUND OR NOT instrument.can_read(src.organization_id) OR (src.organization_id IS NOT NULL AND src.organization_id IS DISTINCT FROM org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 END IF;
 IF action='CREATE' THEN
 INSERT INTO instrument.instrument_scope(organization_id) VALUES(org) ON CONFLICT DO NOTHING;
 SELECT id INTO sid FROM instrument.instrument_scope WHERE organization_id IS NOT DISTINCT FROM org;
 INSERT INTO instrument.questionnaire(scope_id,organization_id,name_ar,name_en,created_by,source_scope_id,source_template_id)
 VALUES(sid,org,body->'title'->>'ar',body->'title'->>'en',actor,src.scope_id,src.questionnaire_id) RETURNING * INTO q;
 ELSE
 SELECT * INTO q FROM instrument.questionnaire WHERE id=qid AND organization_id IS NOT DISTINCT FROM org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF q.source='BUILTIN' OR q.status<>'ACTIVE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 sid:=q.scope_id;
 END IF;
 IF action='ARCHIVE' THEN
 IF q.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 UPDATE instrument.questionnaire SET status='ARCHIVED',revision=revision+1 WHERE id=q.id; result:=q.id;
 ELSE
 IF action IN ('CREATE','NEW_VERSION') THEN
 IF action='NEW_VERSION' AND (src.id IS NULL OR src.questionnaire_id<>q.id OR src.revision IS DISTINCT FROM expected) THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 INSERT INTO instrument.questionnaire_version(id,scope_id,organization_id,questionnaire_id,version_number,metadata,created_by,updated_by)
 SELECT result,sid,org,q.id,coalesce(max(version_number),0)+1,body,actor,actor FROM instrument.questionnaire_version WHERE questionnaire_id=q.id RETURNING * INTO v;
 ELSE
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=vid AND questionnaire_id=q.id AND scope_id=sid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF v.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 END IF;
 IF action IN ('CREATE','NEW_VERSION','SAVE') THEN
 IF v.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- Children are removed in reverse dependency order and rewritten whole.
 FOR i IN REVERSE array_length(tabs,1)..1 LOOP
 EXECUTE format('DELETE FROM instrument.%I WHERE scope_id=$1 AND version_id=$2',tabs[i]) USING sid,result;
 END LOOP;
 FOREACH tab IN ARRAY tabs LOOP
 FOR n IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'table'=tab LOOP
 EXECUTE format('INSERT INTO instrument.%I(id,scope_id,organization_id,version_id,stable_key,position,parent_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',tab)
 USING (n->'payload'->>'id')::uuid,sid,org,result,(n->'payload'->>'key')::uuid,(n->>'position')::integer,(n->>'parentId')::uuid,n->'payload';
 IF tab='question' THEN UPDATE instrument.question SET dimension_id=(n->'payload'->>'dimensionId')::uuid WHERE id=(n->'payload'->>'id')::uuid; END IF;
 IF tab='recommendation_rule' THEN UPDATE instrument.recommendation_rule SET dimension_id=(n->'payload'->'target'->>'dimensionId')::uuid WHERE id=(n->'payload'->>'id')::uuid; END IF;
 END LOOP;
 END LOOP;
 UPDATE instrument.questionnaire_version SET metadata=body,revision=revision+CASE WHEN action='SAVE' THEN 1 ELSE 0 END,updated_at=clock_timestamp(),updated_by=actor WHERE id=result;
 ELSIF action='PUBLISH' THEN
 IF v.state<>'DRAFT' OR octet_length(hash)<>32 OR NOT EXISTS(SELECT 1 FROM instrument.question WHERE version_id=result AND payload->>'type'<>'CONTENT') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE instrument.questionnaire_version SET state='PUBLISHED',schema_hash=hash,published_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=result;
 ELSIF action='RETIRE' THEN
 IF v.state<>'PUBLISHED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE instrument.questionnaire_version SET state='RETIRED',revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=result;
 END IF;
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,request_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INSTRUMENT_CHANGED',result,ARRAY['instrument']);
 RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Computed instances, published with their release and never after it.
-- ---------------------------------------------------------------------------
CREATE TABLE publication.recommendation_instance (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization, snapshot_id uuid NOT NULL,
 group_key uuid NOT NULL, metric_key text NOT NULL,
 rules_version text NOT NULL CHECK(length(rules_version) BETWEEN 1 AND 40),
 rule_key uuid NOT NULL, rule_hash bytea NOT NULL CHECK(octet_length(rule_hash)=32),
 priority integer NOT NULL CHECK(priority BETWEEN 1 AND 999),
 dedup_key text NOT NULL CHECK(dedup_key~'^[a-z0-9][a-z0-9-]{0,59}$'),
 exclusivity_group text CHECK(exclusivity_group~'^[a-z0-9][a-z0-9-]{0,59}$'),
 severity text NOT NULL CHECK(severity IN ('NONE','LOW','MODERATE','HIGH','CRITICAL')),
 -- Frozen localized text and the exact approved cells it was derived from.
 text jsonb NOT NULL CHECK(jsonb_typeof(text)='object' AND octet_length(text::text)<=32768),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16384),
 UNIQUE(organization_id,id),
 -- One recommendation per dedup key per group: a rule set cannot flood one
 -- department with restatements of the same finding.
 UNIQUE(organization_id,snapshot_id,group_key,dedup_key),
 UNIQUE(organization_id,snapshot_id,group_key,rule_key),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES publication.result_snapshot(organization_id,id),
 -- The instance can only name a cell that exists in its own snapshot.
 FOREIGN KEY(organization_id,snapshot_id,group_key,metric_key) REFERENCES publication.aggregate_cell(organization_id,snapshot_id,group_key,metric_key)
);
CREATE INDEX ON publication.recommendation_instance(organization_id,snapshot_id,priority,rule_key);

-- THE recommendation disclosure invariant, enforced in the database and not
-- only in the evaluator: a published recommendation may reference AVAILABLE
-- cells of its own snapshot and its own group, and nothing else. A rule that
-- fired on a withheld input therefore cannot be stored at all.
CREATE FUNCTION publication.recommendation_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item jsonb; ok boolean; BEGIN
 SELECT status='AVAILABLE' INTO ok FROM publication.aggregate_cell
  WHERE organization_id=NEW.organization_id AND snapshot_id=NEW.snapshot_id
    AND group_key=NEW.group_key AND metric_key=NEW.metric_key;
 IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'RECOMMENDATION_ON_WITHHELD_METRIC'; END IF;
 IF jsonb_typeof(NEW.evidence->'items')<>'array' OR jsonb_array_length(NEW.evidence->'items')=0 THEN
  RAISE EXCEPTION 'RECOMMENDATION_EVIDENCE_REQUIRED'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.evidence->'items') LOOP
  IF (item->>'groupKey')::uuid<>NEW.group_key THEN RAISE EXCEPTION 'RECOMMENDATION_CROSS_GROUP_EVIDENCE'; END IF;
  -- Compared as numbers, not as text: the published cell keeps the scale the
  -- release wrote, and "60.0" and "60" are the same disclosed value.
  SELECT status='AVAILABLE' AND value IS NOT NULL AND value=(item->>'value')::numeric INTO ok
   FROM publication.aggregate_cell
   WHERE organization_id=NEW.organization_id AND snapshot_id=NEW.snapshot_id
     AND group_key=(item->>'groupKey')::uuid AND metric_key=item->>'metricKey';
  IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'RECOMMENDATION_ON_WITHHELD_METRIC'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence BEFORE INSERT ON publication.recommendation_instance FOR EACH ROW EXECUTE FUNCTION publication.recommendation_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON publication.recommendation_instance FOR EACH ROW EXECUTE FUNCTION publication.immutable();
ALTER TABLE publication.recommendation_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication.recommendation_instance FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON publication.recommendation_instance TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON publication.recommendation_instance TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON publication.recommendation_instance TO orgfit_access_executor;

-- ---------------------------------------------------------------------------
-- 3. The staff workflow record. Editable, audited, and structurally unable to
-- touch the computed instance beside it.
-- ---------------------------------------------------------------------------
CREATE TABLE core.recommendation_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization, instance_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','DONE','DISMISSED')),
 owner_staff_id uuid REFERENCES access.staff_user, due_date date,
 -- Consultant commentary. It is stored in its own column, is never merged into
 -- the frozen instance text, and is labelled as staff commentary wherever it is
 -- displayed or exported.
 staff_notes text CHECK(length(staff_notes)<=4000),
 resolution text CHECK(length(resolution)<=4000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id), UNIQUE(organization_id,instance_id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES publication.recommendation_instance(organization_id,id),
 -- Closing an item requires saying why; a silent DONE is not an outcome.
 CHECK(status NOT IN ('DONE','DISMISSED') OR length(trim(coalesce(resolution,'')))>0)
);
CREATE INDEX ON core.recommendation_action(organization_id,status,due_date);
CREATE INDEX ON core.recommendation_action(owner_staff_id);
CREATE INDEX ON core.recommendation_action(created_by);
CREATE INDEX ON core.recommendation_action(updated_by);
ALTER TABLE core.recommendation_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.recommendation_action FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON core.recommendation_action TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON core.recommendation_action TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON core.recommendation_action TO orgfit_access_executor;

ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction']::text[]);

-- ---------------------------------------------------------------------------
-- 4. Publication gate: recommendations are validated with the release plan.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.check_recommendations(payload jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE rec jsonb; item jsonb; keys text[]:='{}'; k text; BEGIN
 FOR rec IN SELECT * FROM jsonb_array_elements(coalesce(payload->'recommendations','[]'::jsonb)) LOOP
  -- The same check as the insert trigger, applied to the plan as a whole so a
  -- bad plan is refused before any part of the release is written.
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'cells') c
   WHERE (c->>'groupKey')::uuid=(rec->>'groupKey')::uuid AND c->>'metricKey'=rec->>'metricKey' AND c->>'status'='AVAILABLE')
  THEN RAISE EXCEPTION 'RECOMMENDATION_ON_WITHHELD_METRIC'; END IF;
  IF jsonb_array_length(coalesce(rec->'evidence'->'items','[]'::jsonb))=0 THEN RAISE EXCEPTION 'RECOMMENDATION_EVIDENCE_REQUIRED'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(rec->'evidence'->'items') LOOP
   IF (item->>'groupKey')::uuid<>(rec->>'groupKey')::uuid THEN RAISE EXCEPTION 'RECOMMENDATION_CROSS_GROUP_EVIDENCE'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'cells') c
    WHERE (c->>'groupKey')::uuid=(item->>'groupKey')::uuid AND c->>'metricKey'=item->>'metricKey'
      AND c->>'status'='AVAILABLE' AND (c->>'value')::numeric=(item->>'value')::numeric)
   THEN RAISE EXCEPTION 'RECOMMENDATION_ON_WITHHELD_METRIC'; END IF;
  END LOOP;
  k:=concat(rec->>'groupKey','/',rec->>'dedupKey');
  IF k=ANY(keys) THEN RAISE EXCEPTION 'RECOMMENDATION_DUPLICATE'; END IF;
  keys:=array_append(keys,k);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION publication.publish_release(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; org uuid; cid uuid; hash bytea; existing publication.result_snapshot;
 sid uuid; item jsonb; threshold integer; period jsonb; BEGIN
 org:=(payload->>'organizationId')::uuid; cid:=(payload->>'campaignId')::uuid;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF c.state<>'CLOSED' THEN RAISE EXCEPTION 'CAMPAIGN_NOT_CLOSED'; END IF;
 threshold:=greatest(c.threshold,coalesce((payload->>'threshold')::integer,5),5);
 PERFORM publication.check_plan(payload,threshold);
 PERFORM publication.check_recommendations(payload);
 period:=jsonb_build_object('startsAt',c.starts_at,'endsAt',c.ends_at,'closedAt',c.closed_at,
  'timezone',c.timezone,'invitedCount',c.frozen_invited_count);
 -- Recommendations are part of the released content, so they are inside the
 -- content hash: a different rule outcome is a different release, never a
 -- silent replacement of one staff already read.
 hash:=sha256(convert_to(jsonb_build_object('groups',payload->'groups','metrics',payload->'metrics',
  'cells',payload->'cells','recommendations',coalesce(payload->'recommendations','[]'::jsonb),
  'versions',payload->'versions','period',period)::text,'UTF8'));
 SELECT * INTO existing FROM publication.result_snapshot
  WHERE organization_id=org AND campaign_id=cid AND state='PUBLISHED';
 IF FOUND THEN
  IF existing.content_hash<>hash THEN RAISE EXCEPTION 'RELEASE_ALREADY_PUBLISHED'; END IF;
  RETURN jsonb_build_object('snapshotId',existing.id,'releaseRevision',existing.release_revision,'reused',true);
 END IF;
 INSERT INTO publication.result_snapshot(organization_id,campaign_id,round_id,release_revision,state,
  instrument_version_id,scoring_version,rules_version,privacy_version,threshold,batch_id,contributor_count,
  closed_period,report_manifest,content_hash,review_reference)
 VALUES(org,cid,c.round_id,1,'PUBLISHED',c.version_id,payload->'versions'->>'scoring',payload->'versions'->>'rules',
  c.privacy_policy_version,threshold,(payload->>'batchId')::uuid,(payload->>'contributorCount')::integer,
  period,payload->'reportManifest',hash,payload->>'reviewReference')
 RETURNING id INTO sid;
 FOR item IN SELECT * FROM jsonb_array_elements(payload->'groups') LOOP
  INSERT INTO publication.snapshot_group(organization_id,snapshot_id,group_key,kind,label,display_order)
  VALUES(org,sid,(item->>'key')::uuid,item->>'kind',item->'label',(item->>'order')::integer);
 END LOOP;
 FOR item IN SELECT * FROM jsonb_array_elements(payload->'metrics') LOOP
  INSERT INTO publication.snapshot_metric(organization_id,snapshot_id,metric_key,kind,label,description,direction,unit,display_order,bands)
  VALUES(org,sid,item->>'key',item->>'kind',item->'label',item->'description',item->>'direction',
   item->>'unit',(item->>'order')::integer,coalesce(item->'bands','[]'::jsonb));
 END LOOP;
 FOR item IN SELECT * FROM jsonb_array_elements(payload->'cells') LOOP
  INSERT INTO publication.aggregate_cell(organization_id,snapshot_id,group_key,metric_key,status,reason_code,
   contributor_count,value,coverage,distribution,band)
  VALUES(org,sid,(item->>'groupKey')::uuid,item->>'metricKey',item->>'status',item->>'reasonCode',
   (item->>'contributorCount')::integer,(item->>'value')::numeric,(item->>'coverage')::numeric,
   nullif(item->'distribution','null'::jsonb),nullif(item->'band','null'::jsonb));
 END LOOP;
 -- Instances are written last, after every cell exists, so the evidence trigger
 -- checks each one against the stored release rather than against the payload.
 FOR item IN SELECT * FROM jsonb_array_elements(coalesce(payload->'recommendations','[]'::jsonb)) LOOP
  INSERT INTO publication.recommendation_instance(organization_id,snapshot_id,group_key,metric_key,rules_version,
   rule_key,rule_hash,priority,dedup_key,exclusivity_group,severity,text,evidence)
  VALUES(org,sid,(item->>'groupKey')::uuid,item->>'metricKey',payload->'versions'->>'rules',
   (item->>'ruleKey')::uuid,decode(item->>'ruleHash','hex'),(item->>'priority')::integer,item->>'dedupKey',
   item->>'exclusivityGroup',item->>'severity',item->'text',item->'evidence');
 END LOOP;
 UPDATE core.campaign SET release_state='PUBLISHED',revision=revision+1,updated_at=clock_timestamp() WHERE id=cid;
 UPDATE core.assessment_round SET state='PUBLISHED',revision=revision+1,updated_at=clock_timestamp()
  WHERE id=c.round_id AND organization_id=org AND state IN ('COLLECTING','PROCESSING');
 RETURN jsonb_build_object('snapshotId',sid,'releaseRevision',1,'reused',false);
END $$;

-- ---------------------------------------------------------------------------
-- 5. The staff surface. Read is the published instances of the current release
-- joined to their own action row; write touches the action row only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.recommendations(cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; s publication.result_snapshot; BEGIN
 SELECT * INTO c FROM core.campaign WHERE id=cid;
 IF NOT FOUND OR NOT access.has_org(c.organization_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=c.organization_id AND campaign_id=cid AND state='PUBLISHED';
 IF NOT FOUND THEN RETURN jsonb_build_object('available',false,'campaignId',cid,'roundId',c.round_id,
  'releaseState',c.release_state,'campaignState',core.effective_state(c.state,c.starts_at,c.ends_at)); END IF;
 RETURN jsonb_build_object('available',true,'campaignId',cid,'roundId',s.round_id,'snapshotId',s.id,
  'rulesVersion',s.rules_version,
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'groupKey',r.group_key,'metricKey',r.metric_key,
    'ruleKey',r.rule_key,'ruleHash',encode(r.rule_hash,'hex'),'rulesVersion',r.rules_version,'priority',r.priority,
    'dedupKey',r.dedup_key,'exclusivityGroup',r.exclusivity_group,'severity',r.severity,'text',r.text,'evidence',r.evidence,
    'action',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'status',a.status,
      'ownerStaffId',a.owner_staff_id,'ownerName',u.display_name,'dueDate',a.due_date,'staffNotes',a.staff_notes,
      'resolution',a.resolution,'revision',a.revision,'updatedAt',a.updated_at) END)
    ORDER BY r.priority,r.rule_key,r.group_key)
   FROM publication.recommendation_instance r
   LEFT JOIN core.recommendation_action a ON a.organization_id=r.organization_id AND a.instance_id=r.id
   LEFT JOIN access.staff_user u ON u.id=a.owner_staff_id
   WHERE r.organization_id=s.organization_id AND r.snapshot_id=s.id),'[]'::jsonb));
END $$;

CREATE FUNCTION core.save_recommendation_action(org uuid,instance uuid,expected bigint,body jsonb,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); existing core.recommendation_action; result uuid; owner uuid; op text:=concat('recommendation-action/',org); receipt uuid; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN RETURN jsonb_build_object('id',receipt,'replayed',true); END IF;
 -- The instance must belong to this organization's published release. Staff
 -- never create, edit or delete an instance here; only the row beside it.
 IF NOT EXISTS(SELECT 1 FROM publication.recommendation_instance WHERE id=instance AND organization_id=org)
  THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 owner:=(body->>'ownerStaffId')::uuid;
 IF owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM access.staff_user WHERE id=owner AND status='ACTIVE')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO existing FROM core.recommendation_action WHERE organization_id=org AND instance_id=instance FOR UPDATE;
 IF FOUND THEN
  IF expected IS NULL OR existing.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  UPDATE core.recommendation_action SET status=coalesce(body->>'status',status),owner_staff_id=owner,
   due_date=(body->>'dueDate')::date,staff_notes=body->>'staffNotes',resolution=body->>'resolution',
   revision=revision+1,updated_at=clock_timestamp(),updated_by=actor
   WHERE id=existing.id RETURNING id INTO result;
 ELSE
  IF expected IS NOT NULL THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  INSERT INTO core.recommendation_action(organization_id,instance_id,status,owner_staff_id,due_date,staff_notes,resolution,created_by,updated_by)
  VALUES(org,instance,coalesce(body->>'status','OPEN'),owner,(body->>'dueDate')::date,body->>'staffNotes',body->>'resolution',actor,actor)
  RETURNING id INTO result;
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,result);
 -- Sanitized audit: the field group that changed, never the note text itself.
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'RECOMMENDATION_ACTION_CHANGED',result,ARRAY['recommendationAction']);
 RETURN (SELECT jsonb_build_object('id',a.id,'instanceId',a.instance_id,'status',a.status,'ownerStaffId',a.owner_staff_id,
   'dueDate',a.due_date,'staffNotes',a.staff_notes,'resolution',a.resolution,'revision',a.revision,'updatedAt',a.updated_at)
  FROM core.recommendation_action a WHERE a.id=result);
END $$;

-- The batch the privacy processor receives must carry the rules, because the
-- pinned instrument snapshot in the anonymous database is what publication
-- evaluates months later. It now takes the node list from instrument.node_tables
-- instead of a literal list, so a node table added here cannot be silently
-- missing from a processed batch.
--
-- intake.gateway_instrument is deliberately NOT changed: a respondent's browser
-- receives the questions it must answer, and rule thresholds and consulting
-- text are staff configuration that has no business being sent to a respondent.
CREATE OR REPLACE FUNCTION intake.batch_payload(bid uuid,lease_gen bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b intake.processing_batch; c core.campaign; v instrument.questionnaire_version;
 rows jsonb; nodes jsonb:='[]'::jsonb; t text; part jsonb; BEGIN
 SELECT * INTO b FROM intake.processing_batch WHERE id=bid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF b.lease_generation<>lease_gen THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=b.campaign_id;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=c.version_id AND scope_id=c.instrument_scope_id;
 FOREACH t IN ARRAY instrument.node_tables() LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''table'',%L,''position'',position,''parentId'',parent_id,''payload'',payload)),''[]''::jsonb)
  FROM instrument.%I WHERE scope_id=$1 AND version_id=$2',t,t) INTO part USING v.scope_id, v.id;
 nodes:=nodes||part;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('keyReference',e.key_reference,'ciphertext',encode(e.ciphertext,'base64'))
  ORDER BY e.id),'[]'::jsonb) INTO rows FROM intake.submission_inbox e WHERE e.batch_id=bid;
 RETURN jsonb_build_object('batchId',b.id,'organizationId',b.organization_id,'campaignId',b.campaign_id,
 'versionId',c.version_id,'acceptedCount',b.accepted_count,'state',b.state,
 'manifestHash',encode(b.manifest_hash,'hex'),
 'manifest',c.frozen_manifest,'threshold',c.threshold,'envelopes',rows,
 'instrument',jsonb_build_object('metadata',v.metadata,'nodes',nodes));
END $$;

GRANT CREATE ON SCHEMA publication,instrument,core,intake TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='publication' AND p.proname IN ('check_recommendations','publish_release','recommendations','recommendation_evidence'))
    OR (n.nspname='core' AND p.proname='save_recommendation_action')
    OR (n.nspname='instrument' AND p.proname IN ('node_tables','write_version'))
    OR (n.nspname='intake' AND p.proname='batch_payload') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication,instrument,core,intake FROM orgfit_access_executor;
GRANT EXECUTE ON FUNCTION instrument.node_tables(),instrument.write_version(uuid,uuid,uuid,bigint,text,jsonb,jsonb,bytea,uuid,bytea,uuid) TO orgfit_staff;
GRANT EXECUTE ON FUNCTION publication.recommendations(uuid),core.save_recommendation_action(uuid,uuid,bigint,jsonb,uuid,bytea) TO orgfit_staff;
