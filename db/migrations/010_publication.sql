-- Phase 08: safe publication and analytics.
--
-- This schema is the ONLY place a staff credential may read an assessment
-- result. It holds aggregate cells that a disclosure review has already
-- approved; it never holds a response, an answer, a per-person score, a
-- contributor identity or anything that could be joined back to one.
--
-- Two independent rules protect it, and both are enforced here rather than in
-- application code:
--   1. A cell that is not AVAILABLE carries NO value, count, coverage,
--      distribution or band. There is no hidden companion column to leak.
--   2. An AVAILABLE cell carries at least five distinct contributors. Five is
--      a hard floor in a CHECK; a campaign may configure a higher threshold,
--      which publication.publish_release enforces on top.
--
-- Cells arrive as one whole release plan and are validated jointly, because a
-- department cell that is safe alone can still reconstruct a withheld sibling
-- once the company cell is published beside it.

CREATE SCHEMA publication AUTHORIZATION orgfit_core_owner;
REVOKE ALL ON SCHEMA publication FROM PUBLIC;
GRANT USAGE ON SCHEMA publication TO orgfit_access_executor;

CREATE TABLE publication.result_snapshot (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, round_id uuid NOT NULL,
 release_revision integer NOT NULL CHECK(release_revision>0),
 state text NOT NULL CHECK(state IN ('CANDIDATE','PUBLISHED','REVOKED')),
 instrument_version_id uuid NOT NULL,
 scoring_version text NOT NULL CHECK(length(scoring_version) BETWEEN 1 AND 40),
 rules_version text CHECK(rules_version IS NULL OR length(rules_version) BETWEEN 1 AND 40),
 privacy_version integer NOT NULL CHECK(privacy_version>0),
 threshold integer NOT NULL CHECK(threshold>=5),
 batch_id uuid NOT NULL,
 -- The campaign-level count of accepted contributors. It is not a per-metric
 -- denominator: every metric carries its own contributor count.
 contributor_count integer NOT NULL CHECK(contributor_count>=5),
 closed_period jsonb NOT NULL CHECK(jsonb_typeof(closed_period)='object' AND octet_length(closed_period::text)<=4096),
 report_manifest jsonb NOT NULL CHECK(jsonb_typeof(report_manifest)='object' AND octet_length(report_manifest::text)<=16384),
 generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 content_hash bytea NOT NULL CHECK(octet_length(content_hash)=32),
 prior_snapshot_id uuid, correction_reason text CHECK(length(correction_reason)<=2000),
 review_reference text NOT NULL CHECK(length(trim(review_reference)) BETWEEN 1 AND 200),
 revoked_reason text CHECK(length(revoked_reason)<=500),
 UNIQUE(organization_id,id), UNIQUE(organization_id,campaign_id,release_revision),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id),
 FOREIGN KEY(organization_id,round_id) REFERENCES core.assessment_round(organization_id,id),
 FOREIGN KEY(organization_id,prior_snapshot_id) REFERENCES publication.result_snapshot(organization_id,id),
 CHECK(release_revision=1 OR (prior_snapshot_id IS NOT NULL AND correction_reason IS NOT NULL)),
 CHECK((state='REVOKED')=(revoked_reason IS NOT NULL))
);
-- One release per closed campaign. A correction must supersede, never coexist.
CREATE UNIQUE INDEX result_snapshot_published ON publication.result_snapshot(organization_id,campaign_id) WHERE state='PUBLISHED';
CREATE INDEX ON publication.result_snapshot(organization_id,state,campaign_id);
CREATE INDEX ON publication.result_snapshot(organization_id,round_id);

-- The frozen group partition of the release: exactly one COMPANY plus the flat
-- department/other partition. Labels are copied at release time so that a later
-- directory rename never rewrites a published result.
CREATE TABLE publication.snapshot_group (
 organization_id uuid NOT NULL, snapshot_id uuid NOT NULL, group_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('COMPANY','DEPARTMENT','OTHER')),
 label jsonb NOT NULL CHECK(jsonb_typeof(label)='object' AND octet_length(label::text)<=2048),
 display_order integer NOT NULL CHECK(display_order>=0),
 PRIMARY KEY(organization_id,snapshot_id,group_key),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES publication.result_snapshot(organization_id,id)
);
CREATE UNIQUE INDEX snapshot_group_company ON publication.snapshot_group(organization_id,snapshot_id) WHERE kind='COMPANY';

-- Metric definitions frozen with the release: labels, direction, unit and the
-- interpretation bands. Bands are instrument configuration, never a person's
-- value, so they stay readable even where the cell itself is withheld.
CREATE TABLE publication.snapshot_metric (
 organization_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 metric_key text NOT NULL CHECK(length(metric_key) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK(kind IN ('OVERALL','DIMENSION','QUESTION')),
 label jsonb NOT NULL CHECK(jsonb_typeof(label)='object'),
 description jsonb NOT NULL CHECK(jsonb_typeof(description)='object'),
 direction text CHECK(direction IN ('HIGH_GOOD','HIGH_RISK')),
 unit text NOT NULL CHECK(unit IN ('SCORE_0_100','PERCENT','NUMBER','SHARES')),
 display_order integer NOT NULL CHECK(display_order>=0),
 bands jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(bands)='array' AND octet_length(bands::text)<=32768),
 PRIMARY KEY(organization_id,snapshot_id,metric_key),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES publication.result_snapshot(organization_id,id)
);

CREATE TABLE publication.aggregate_cell (
 organization_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 group_key uuid NOT NULL, metric_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('AVAILABLE','SUPPRESSED','INSUFFICIENT','UNSCORED','NOT_COMPARABLE')),
 reason_code text CHECK(reason_code IN ('BELOW_THRESHOLD','COMPLEMENTARY','HOMOGENEOUS','SPARSE_BIN','RAW_WITHHELD','NO_VALID_SCORE','NOT_RELEASED')),
 contributor_count integer CHECK(contributor_count IS NULL OR contributor_count>=5),
 value numeric, coverage numeric CHECK(coverage IS NULL OR (coverage>=0 AND coverage<=1)),
 distribution jsonb CHECK(distribution IS NULL OR (jsonb_typeof(distribution)='object' AND octet_length(distribution::text)<=32768)),
 band jsonb CHECK(band IS NULL OR jsonb_typeof(band)='object'),
 PRIMARY KEY(organization_id,snapshot_id,group_key,metric_key),
 FOREIGN KEY(organization_id,snapshot_id,group_key) REFERENCES publication.snapshot_group(organization_id,snapshot_id,group_key),
 FOREIGN KEY(organization_id,snapshot_id,metric_key) REFERENCES publication.snapshot_metric(organization_id,snapshot_id,metric_key),
 -- THE suppression invariant. A withheld cell is empty in storage, not merely
 -- hidden by a view: there is nothing for an API, a chart payload, a cache or
 -- an export to accidentally serialize.
 CHECK(status='AVAILABLE' OR (contributor_count IS NULL AND value IS NULL AND coverage IS NULL AND distribution IS NULL AND band IS NULL)),
 CHECK(status<>'AVAILABLE' OR (contributor_count IS NOT NULL AND (value IS NOT NULL OR distribution IS NOT NULL))),
 CHECK((status='AVAILABLE')=(reason_code IS NULL))
);
CREATE INDEX ON publication.aggregate_cell(organization_id,snapshot_id,metric_key);

-- Published content is immutable. The only permitted change to a snapshot row
-- is its own lifecycle state, and only forward.
CREATE FUNCTION publication.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'PUBLICATION_IMMUTABLE'; END $$;
CREATE FUNCTION publication.snapshot_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PUBLICATION_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-'state'-'revoked_reason') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revoked_reason')
  THEN RAISE EXCEPTION 'PUBLICATION_IMMUTABLE'; END IF;
 IF NOT (OLD.state='CANDIDATE' AND NEW.state IN ('PUBLISHED','REVOKED'))
  AND NOT (OLD.state='PUBLISHED' AND NEW.state='REVOKED')
  THEN RAISE EXCEPTION 'PUBLICATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle BEFORE UPDATE OR DELETE ON publication.result_snapshot
 FOR EACH ROW EXECUTE FUNCTION publication.snapshot_lifecycle();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['publication.snapshot_group','publication.snapshot_metric','publication.aggregate_cell'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION publication.immutable()',t);
 END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['publication.result_snapshot','publication.snapshot_group','publication.snapshot_metric','publication.aggregate_cell'] LOOP
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON publication.result_snapshot TO orgfit_access_executor;
GRANT SELECT,INSERT ON publication.snapshot_group,publication.snapshot_metric,publication.aggregate_cell TO orgfit_access_executor;

-- ---------------------------------------------------------------------------
-- The centralized disclosure gate.
--
-- Everything staff can ever see passes through publish_release, and nothing
-- reaches publication storage another way: orgfit_processor holds no table
-- privilege in this schema, only EXECUTE on the two routines below, and
-- orgfit_staff holds neither table privilege nor write routine.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.check_plan(payload jsonb,threshold integer) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE cell jsonb; bin jsonb; company uuid; metric text; released integer; withheld integer; BEGIN
 SELECT (g->>'key')::uuid INTO company FROM jsonb_array_elements(payload->'groups') g WHERE g->>'kind'='COMPANY';
 IF company IS NULL THEN RAISE EXCEPTION 'PLAN_NO_COMPANY_GROUP'; END IF;
 FOR cell IN SELECT * FROM jsonb_array_elements(payload->'cells') LOOP
  IF cell->>'status'='AVAILABLE' THEN
   IF (cell->>'contributorCount')::integer<threshold THEN RAISE EXCEPTION 'PLAN_BELOW_THRESHOLD'; END IF;
   IF cell->'reasonCode' IS NOT NULL AND cell->'reasonCode'<>'null'::jsonb THEN RAISE EXCEPTION 'PLAN_REASON_ON_AVAILABLE'; END IF;
   -- Each released bin is itself a contributor count and obeys the same floor.
   -- An empty bin discloses nobody; a bin of one to four discloses people.
   FOR bin IN SELECT * FROM jsonb_array_elements(coalesce(cell->'distribution'->'bins','[]'::jsonb)) LOOP
    IF (bin->>'count')::integer<>0 AND (bin->>'count')::integer<threshold THEN RAISE EXCEPTION 'PLAN_SPARSE_BIN'; END IF;
   END LOOP;
  ELSIF jsonb_strip_nulls(cell) ?| ARRAY['value','contributorCount','coverage','distribution','band'] THEN
   RAISE EXCEPTION 'PLAN_WITHHELD_CELL_CARRIES_VALUE';
  END IF;
 END LOOP;
 -- The joint check. Within one metric the department partition is released in
 -- full or not at all, and never without its company cell: a single withheld
 -- sibling beside a published company total is one subtraction from recovery.
 FOR metric IN SELECT DISTINCT c->>'metricKey' FROM jsonb_array_elements(payload->'cells') c LOOP
  SELECT count(*) FILTER (WHERE c->>'status'='AVAILABLE'), count(*) FILTER (WHERE c->>'status'<>'AVAILABLE')
   INTO released,withheld
   FROM jsonb_array_elements(payload->'cells') c
   WHERE c->>'metricKey'=metric AND (c->>'groupKey')::uuid<>company;
  IF released>0 AND withheld>0 THEN RAISE EXCEPTION 'PLAN_PARTIAL_PARTITION'; END IF;
  IF released>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'cells') c
    WHERE c->>'metricKey'=metric AND (c->>'groupKey')::uuid=company AND c->>'status'='AVAILABLE')
   THEN RAISE EXCEPTION 'PLAN_PARTITION_WITHOUT_COMPANY'; END IF;
 END LOOP;
END $$;

CREATE FUNCTION publication.publish_release(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; org uuid; cid uuid; hash bytea; existing publication.result_snapshot;
 sid uuid; item jsonb; threshold integer; period jsonb; BEGIN
 org:=(payload->>'organizationId')::uuid; cid:=(payload->>'campaignId')::uuid;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- An open campaign has no assessment result at all. Live score polling is not
 -- a feature that was left out; it is refused here.
 IF c.state<>'CLOSED' THEN RAISE EXCEPTION 'CAMPAIGN_NOT_CLOSED'; END IF;
 threshold:=greatest(c.threshold,coalesce((payload->>'threshold')::integer,5),5);
 PERFORM publication.check_plan(payload,threshold);
 -- The content hash is computed here, not accepted from the caller, so that
 -- "the same plan republishes to the same snapshot" is a database property.
 -- The collection period is read from the closed campaign, never accepted from
 -- the caller, and it is deliberately campaign-level: no submission instant of
 -- any individual exists to record here.
 period:=jsonb_build_object('startsAt',c.starts_at,'endsAt',c.ends_at,'closedAt',c.closed_at,
  'timezone',c.timezone,'invitedCount',c.frozen_invited_count);
 hash:=sha256(convert_to(jsonb_build_object('groups',payload->'groups','metrics',payload->'metrics',
  'cells',payload->'cells','versions',payload->'versions','period',period)::text,'UTF8'));
 SELECT * INTO existing FROM publication.result_snapshot
  WHERE organization_id=org AND campaign_id=cid AND state='PUBLISHED';
 IF FOUND THEN
  -- Idempotent replay returns the existing release. A DIFFERENT plan for an
  -- already released campaign is refused: a correction is a reviewed new
  -- revision, never a silent overwrite of numbers staff already saw.
  IF existing.content_hash<>hash THEN RAISE EXCEPTION 'RELEASE_ALREADY_PUBLISHED'; END IF;
  RETURN jsonb_build_object('snapshotId',existing.id,'releaseRevision',existing.release_revision,'reused',true);
 END IF;
 INSERT INTO publication.result_snapshot(organization_id,campaign_id,round_id,release_revision,state,
  instrument_version_id,scoring_version,privacy_version,threshold,batch_id,contributor_count,
  closed_period,report_manifest,content_hash,review_reference)
 VALUES(org,cid,c.round_id,1,'PUBLISHED',c.version_id,payload->'versions'->>'scoring',
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
   -- A JSON null is not a SQL NULL. A withheld cell must store the absence.
   nullif(item->'distribution','null'::jsonb),nullif(item->'band','null'::jsonb));
 END LOOP;
 UPDATE core.campaign SET release_state='PUBLISHED',revision=revision+1,updated_at=clock_timestamp() WHERE id=cid;
 UPDATE core.assessment_round SET state='PUBLISHED',revision=revision+1,updated_at=clock_timestamp()
  WHERE id=c.round_id AND organization_id=org AND state IN ('COLLECTING','PROCESSING');
 RETURN jsonb_build_object('snapshotId',sid,'releaseRevision',1,'reused',false);
END $$;

-- A campaign that never reached the threshold produces a recorded outcome and
-- no snapshot at all. There is nothing to suppress because nothing was ever
-- computed: the processor purged that intake without decrypting it.
CREATE FUNCTION publication.mark_release_state(org uuid,cid uuid,new_state text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; BEGIN
 IF new_state NOT IN ('QUEUED','PROCESSING','PRIVACY_CHECK','FAILED','INSUFFICIENT_DATA') THEN
  RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=cid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF c.release_state='PUBLISHED' THEN RAISE EXCEPTION 'RELEASE_ALREADY_PUBLISHED'; END IF;
 UPDATE core.campaign SET release_state=new_state,revision=revision+1,updated_at=clock_timestamp() WHERE id=cid;
 IF new_state='INSUFFICIENT_DATA' THEN
  UPDATE core.assessment_round SET state='INSUFFICIENT_DATA',revision=revision+1,updated_at=clock_timestamp()
   WHERE id=c.round_id AND organization_id=org AND state IN ('COLLECTING','PROCESSING');
 END IF;
 RETURN new_state;
END $$;

-- The processor's work queue. It holds no SELECT on core.campaign or on
-- intake.processing_batch and must not be given one just to find its next job,
-- so the selection itself is a routine that returns campaign identifiers and
-- nothing else. 'PROCESS' is the privacy processor's queue and 'RELEASE' is the
-- publication queue; both are campaign-level.
CREATE FUNCTION publication.due_campaigns(kind text,limit_rows integer DEFAULT 20) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result uuid[]; BEGIN
 IF kind='PROCESS' THEN
  SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO result FROM (
   SELECT c.id FROM core.campaign c LEFT JOIN intake.processing_batch b ON b.campaign_id=c.id
    WHERE c.state='CLOSED' AND (b.id IS NULL OR b.state NOT IN ('CLEANED','PURGED','FAILED'))
    ORDER BY c.id LIMIT limit_rows) q;
 ELSIF kind='RELEASE' THEN
  SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO result FROM (
   SELECT c.id FROM core.campaign c JOIN intake.processing_batch b ON b.campaign_id=c.id
    WHERE c.state='CLOSED' AND c.release_state NOT IN ('PUBLISHED','REVOKED')
      AND b.state IN ('CLEANED','PURGED')
    ORDER BY c.id LIMIT limit_rows) q;
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED';
 END IF;
 RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- The staff read model. orgfit_staff has NO privilege on any publication table
-- and no way to name one; this routine is the whole analytics surface.
--
-- It returns the current PUBLISHED release only. A candidate, a revoked release
-- and an unreleased campaign are all indistinguishable "not available" answers
-- carrying a release state and no numbers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.snapshot(cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; s publication.result_snapshot; BEGIN
 SELECT * INTO c FROM core.campaign WHERE id=cid;
 IF NOT FOUND OR NOT access.has_org(c.organization_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=c.organization_id AND campaign_id=cid AND state='PUBLISHED';
 IF NOT FOUND THEN
  RETURN jsonb_build_object('available',false,'campaignId',cid,'roundId',c.round_id,
   'releaseState',c.release_state,'campaignState',core.effective_state(c.state,c.starts_at,c.ends_at),
   'threshold',c.threshold);
 END IF;
 RETURN jsonb_build_object('available',true,'campaignId',cid,'roundId',s.round_id,'id',s.id,
  'releaseRevision',s.release_revision,'releaseState',c.release_state,'threshold',s.threshold,
  'contributorCount',s.contributor_count,'generatedAt',s.generated_at,'period',s.closed_period,
  'manifest',s.report_manifest,'contentHash',encode(s.content_hash,'hex'),
  'versions',jsonb_build_object('instrument',s.instrument_version_id,'scoring',s.scoring_version,
   'rules',s.rules_version,'privacy',s.privacy_version),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('key',g.group_key,'kind',g.kind,'label',g.label)
    ORDER BY g.display_order,g.group_key) FROM publication.snapshot_group g
    WHERE g.organization_id=s.organization_id AND g.snapshot_id=s.id),'[]'::jsonb),
  'metrics',coalesce((SELECT jsonb_agg(jsonb_build_object('key',m.metric_key,'kind',m.kind,'label',m.label,
    'description',m.description,'direction',m.direction,'unit',m.unit,'bands',m.bands)
    ORDER BY m.display_order,m.metric_key) FROM publication.snapshot_metric m
    WHERE m.organization_id=s.organization_id AND m.snapshot_id=s.id),'[]'::jsonb),
  'cells',coalesce((SELECT jsonb_agg(jsonb_build_object('groupKey',a.group_key,'metricKey',a.metric_key,
    'status',a.status,'reasonCode',a.reason_code,'contributorCount',a.contributor_count,
    'value',CASE WHEN a.value IS NULL THEN NULL ELSE trim_scale(a.value)::text END,
    'coverage',CASE WHEN a.coverage IS NULL THEN NULL ELSE trim_scale(a.coverage)::text END,
    'distribution',a.distribution,'band',a.band)
    ORDER BY a.metric_key,a.group_key) FROM publication.aggregate_cell a
    WHERE a.organization_id=s.organization_id AND a.snapshot_id=s.id),'[]'::jsonb));
END $$;

GRANT CREATE ON SCHEMA publication TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='publication' AND p.proname IN ('check_plan','publish_release','mark_release_state','snapshot','due_campaigns') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication FROM orgfit_access_executor;

-- The processor may publish and record a release outcome. It may not read the
-- published result back through a staff path, and it never gains a staff
-- capability by doing so.
GRANT USAGE ON SCHEMA publication TO orgfit_processor;
GRANT EXECUTE ON FUNCTION publication.publish_release(jsonb),publication.mark_release_state(uuid,uuid,text),
 publication.due_campaigns(text,integer) TO orgfit_processor;
-- Staff analytics terminate here and nowhere else.
GRANT USAGE ON SCHEMA publication TO orgfit_staff;
GRANT EXECUTE ON FUNCTION publication.snapshot(uuid) TO orgfit_staff;
-- The processor needs the campaign's release context to build a plan. It is
-- campaign-level only and already reachable through core.release_readiness.
