-- Phase 11: professional PDF and Excel report artifacts.
--
-- A report is a RENDERING of an already published release. It adds no number,
-- recomputes nothing and reaches nothing the results surface could not already
-- show. Three structural properties make that true rather than merely intended:
--
--   1. The job carries its own frozen SOURCE. Everything a renderer will ever
--      print is assembled once, at request time, from publication storage and
--      from the staff history projection, and is then immutable. A retry, a
--      second worker or a re-render three days later prints the same document.
--   2. The database re-checks that source before accepting it
--      (publication.check_report_input): no withheld cell may carry a value,
--      count, coverage, distribution or band anywhere in the payload, and every
--      released number it quotes must equal the stored aggregate cell it claims
--      to come from. The application is not trusted to have projected honestly.
--   3. The renderer runs under orgfit_report, a login role with NO table
--      privilege anywhere, no CONNECT on the anonymous database, and execute
--      rights on four job routines only. It cannot read a participant, an
--      invitation, a draft, an intake envelope or an answer even by mistake.
--
-- Named participation lists are deliberately NOT part of this. They are staff
-- identity material, they live in ops.private_export under their own kind,
-- their own capability and their own storage prefix, and they carry no
-- response identifier, score or result. The assessment workbook and the named
-- list can never be the same file.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgfit_report') THEN
  RAISE EXCEPTION 'Apply db/roles.sql before migration 014: role orgfit_report is missing';
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The job.
--
-- state:   QUEUED -> RUNNING -> READY | FAILED, plus EXPIRED and REVOKED as
--          terminal states of a finished artifact. A RUNNING job whose lease
--          has elapsed returns to QUEUED; that is the whole retry story, and it
--          is idempotent because `source` never changes.
-- source:  the frozen render input. Immutable after insert.
-- ---------------------------------------------------------------------------
CREATE TABLE ops.report_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, round_id uuid NOT NULL, series_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, comparison_id uuid,
 format text NOT NULL CHECK(format IN ('PDF','XLSX')),
 locale text NOT NULL CHECK(locale IN ('ar','en')),
 state text NOT NULL DEFAULT 'QUEUED'
  CHECK(state IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED','REVOKED')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0 AND attempt<=10),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 requested_by uuid NOT NULL REFERENCES access.staff_user,
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object' AND octet_length(source::text)<=4194304),
 source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 storage_key text CHECK(length(storage_key)<=200),
 byte_count bigint CHECK(byte_count IS NULL OR (byte_count>0 AND byte_count<=52428800)),
 content_hash bytea CHECK(content_hash IS NULL OR octet_length(content_hash)=32),
 page_count integer CHECK(page_count IS NULL OR page_count>0),
 failure_code text CHECK(length(failure_code)<=80),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 started_at timestamptz, completed_at timestamptz,
 lease_expires_at timestamptz, expires_at timestamptz,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id),
 FOREIGN KEY(organization_id,round_id) REFERENCES core.assessment_round(organization_id,id),
 FOREIGN KEY(organization_id,series_id) REFERENCES core.assessment_series(organization_id,id),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES publication.result_snapshot(organization_id,id),
 FOREIGN KEY(organization_id,comparison_id) REFERENCES publication.comparison_definition(organization_id,id),
 -- A downloadable artifact is a storage key, a size, a hash and an expiry, all
 -- or none. There is no half-ready download.
 CHECK(state<>'READY' OR (storage_key IS NOT NULL AND byte_count IS NOT NULL
   AND content_hash IS NOT NULL AND expires_at IS NOT NULL AND completed_at IS NOT NULL)),
 -- An unfinished job has no artifact columns at all, and an expired or revoked
 -- one keeps its receipt — size, hash, completion time — while losing the
 -- pointer to bytes that no longer exist.
 CHECK(state IN ('READY','EXPIRED','REVOKED') OR (storage_key IS NULL
   AND byte_count IS NULL AND content_hash IS NULL AND completed_at IS NULL)),
 CHECK(state IN ('READY','QUEUED','RUNNING','FAILED') OR storage_key IS NULL),
 CHECK(state<>'FAILED' OR failure_code IS NOT NULL),
 CHECK(state<>'RUNNING' OR lease_expires_at IS NOT NULL)
);
CREATE INDEX ON ops.report_job(organization_id,round_id,created_at DESC,id);
CREATE INDEX ON ops.report_job(state,lease_expires_at);
CREATE INDEX ON ops.report_job(organization_id,state,expires_at);
CREATE INDEX ON ops.report_job(requested_by);
CREATE INDEX ON ops.report_job(organization_id,comparison_id);

-- The render input is frozen. Only lifecycle columns may ever change, and the
-- transition itself is constrained here rather than in application code.
CREATE FUNCTION ops.report_job_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REPORT_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-'state'-'attempt'-'storage_key'-'byte_count'-'content_hash'-'page_count'
     -'failure_code'-'started_at'-'completed_at'-'lease_expires_at'-'expires_at')
  IS DISTINCT FROM
    (to_jsonb(OLD)-'state'-'attempt'-'storage_key'-'byte_count'-'content_hash'-'page_count'
     -'failure_code'-'started_at'-'completed_at'-'lease_expires_at'-'expires_at')
  THEN RAISE EXCEPTION 'REPORT_IMMUTABLE'; END IF;
 IF NOT (
   (OLD.state='QUEUED'  AND NEW.state IN ('RUNNING','FAILED','REVOKED')) OR
   (OLD.state='RUNNING' AND NEW.state IN ('QUEUED','READY','FAILED','REVOKED')) OR
   (OLD.state='READY'   AND NEW.state IN ('EXPIRED','REVOKED')) OR
   (OLD.state='FAILED'  AND NEW.state IN ('QUEUED','REVOKED'))
 ) THEN RAISE EXCEPTION 'REPORT_IMMUTABLE'; END IF;
 -- A rendered artifact is never replaced in place: once READY the bytes are
 -- what staff downloaded, so the only change expressible is the artifact's
 -- disappearance. Clearing the key on expiry or revocation is that; pointing it
 -- at different bytes is not.
 IF OLD.state='READY' AND NEW.storage_key IS NOT NULL
    AND NEW.storage_key IS DISTINCT FROM OLD.storage_key
  THEN RAISE EXCEPTION 'REPORT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle BEFORE UPDATE OR DELETE ON ops.report_job
 FOR EACH ROW EXECUTE FUNCTION ops.report_job_lifecycle();

ALTER TABLE ops.report_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.report_job FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON ops.report_job TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON ops.report_job TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON ops.report_job TO orgfit_access_executor;
-- Deliberately absent: any grant to orgfit_staff. Staff read report jobs
-- through core.report_jobs and nothing else, exactly as with publication.
-- Equally deliberately absent: any grant to orgfit_report. The renderer sees a
-- job only through the four routines below.

ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison','report']::text[]);

-- ---------------------------------------------------------------------------
-- The independent re-check of a frozen render input.
--
-- Two rules, applied to the WHOLE payload regardless of which section produced
-- it, so a future section cannot quietly opt out:
--
--   * A cell-shaped object whose status is not AVAILABLE/COMPARABLE carries no
--     value, contributor count, coverage, distribution or band. This is the
--     storage invariant of migration 010 restated for a document.
--   * Every released number the payload attributes to a round must equal the
--     aggregate cell actually stored for that round's published snapshot.
--     A projection cannot invent, round, rescale or carry forward a value.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.withheld_leak(payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE walk(node) AS (
  SELECT payload
  UNION ALL
  SELECT child FROM walk,
   LATERAL (SELECT value AS child FROM jsonb_array_elements(walk.node)
             WHERE jsonb_typeof(walk.node)='array'
            UNION ALL
            SELECT value FROM jsonb_each(walk.node)
             WHERE jsonb_typeof(walk.node)='object') s
  WHERE jsonb_typeof(walk.node) IN ('array','object')
 )
 SELECT EXISTS(
  SELECT 1 FROM walk
   WHERE jsonb_typeof(node)='object'
     AND node ? 'status'
     AND node->>'status' IN ('SUPPRESSED','INSUFFICIENT','UNSCORED','NOT_COMPARABLE','GAP')
     AND (coalesce(jsonb_typeof(node->'value'),'null')<>'null'
       OR coalesce(jsonb_typeof(node->'contributorCount'),'null')<>'null'
       OR coalesce(jsonb_typeof(node->'coverage'),'null')<>'null'
       OR coalesce(jsonb_typeof(node->'distribution'),'null')<>'null'
       OR coalesce(jsonb_typeof(node->'band'),'null')<>'null'))
$$;

CREATE FUNCTION publication.check_report_input(org uuid,payload jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE bad integer; BEGIN
 IF publication.withheld_leak(payload) THEN RAISE EXCEPTION 'REPORT_WITHHELD_VALUE'; END IF;
 -- Trend points quote a company cell of another round's published release.
 SELECT count(*) INTO bad FROM jsonb_array_elements(coalesce(payload#>'{context,history,trends}','[]'::jsonb)) t,
   jsonb_array_elements(coalesce(t.value->'points','[]'::jsonb)) p
  WHERE jsonb_typeof(p.value->'value')<>'null'
    AND NOT EXISTS(
      SELECT 1 FROM publication.result_snapshot s
        JOIN publication.snapshot_group g ON g.organization_id=s.organization_id
          AND g.snapshot_id=s.id AND g.kind='COMPANY'
        JOIN publication.aggregate_cell a ON a.organization_id=s.organization_id
          AND a.snapshot_id=s.id AND a.group_key=g.group_key
       WHERE s.organization_id=org AND s.round_id=(p.value->>'roundId')::uuid AND s.state='PUBLISHED'
         AND a.metric_key=t.value->>'metricKey' AND a.status='AVAILABLE'
         AND a.value::text=p.value->>'value');
 IF bad>0 THEN RAISE EXCEPTION 'REPORT_VALUE_MISMATCH'; END IF;
 -- Comparison cells quote one cell from each side's own snapshot.
 SELECT count(*) INTO bad FROM jsonb_array_elements(coalesce(payload#>'{context,comparison,cells}','[]'::jsonb)) c
  WHERE (jsonb_typeof(c.value#>'{left,value}')<>'null'
         AND NOT publication.cell_matches(org,(payload#>>'{context,comparison,left,snapshotId}')::uuid,
           c.value->>'leftGroupKey',c.value->>'leftMetricKey',c.value#>>'{left,value}'))
     OR (jsonb_typeof(c.value#>'{right,value}')<>'null'
         AND NOT publication.cell_matches(org,(payload#>>'{context,comparison,right,snapshotId}')::uuid,
           c.value->>'groupKey',c.value->>'metricKey',c.value#>>'{right,value}'));
 IF bad>0 THEN RAISE EXCEPTION 'REPORT_VALUE_MISMATCH'; END IF;
END $$;

CREATE FUNCTION publication.cell_matches(org uuid,snap uuid,gkey text,mkey text,val text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM publication.aggregate_cell a
   WHERE a.organization_id=org AND a.snapshot_id=snap AND a.group_key=gkey::uuid
     AND a.metric_key=mkey AND a.status='AVAILABLE' AND a.value::text=val)
$$;

-- ---------------------------------------------------------------------------
-- The published half of the render input, assembled by the database from
-- publication storage. The application never supplies a cell, a count or a
-- version string; it supplies only the history projection, which is checked
-- above against these same tables.
--
-- Participation is TOTALS ONLY. No name, no participant identifier, no
-- invitation reference and no per-person row exists in a report source.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.report_source_payload(org uuid,cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; r core.assessment_round; se core.assessment_series;
 o core.organization; s publication.result_snapshot; invited integer; completed integer; revoked integer; BEGIN
 SELECT * INTO c FROM core.campaign WHERE organization_id=org AND id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO r FROM core.assessment_round WHERE organization_id=org AND id=c.round_id;
 SELECT * INTO se FROM core.assessment_series WHERE organization_id=org AND id=r.series_id;
 SELECT * INTO o FROM core.organization WHERE id=org;
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=org AND campaign_id=cid AND state='PUBLISHED';
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT count(*) FILTER (WHERE true), count(*) FILTER (WHERE status='COMPLETED'),
        count(*) FILTER (WHERE status='REVOKED')
   INTO invited,completed,revoked
   FROM core.invitation WHERE organization_id=org AND campaign_id=cid;
 invited:=coalesce(invited,0); completed:=coalesce(completed,0); revoked:=coalesce(revoked,0);
 RETURN jsonb_build_object(
  'schemaVersion',1,
  'organization',jsonb_build_object('id',o.id,'code',o.code,'nameAr',o.name_ar,'nameEn',o.name_en,'timezone',o.timezone),
  'series',jsonb_build_object('id',se.id,'nameAr',se.name_ar,'nameEn',se.name_en,'purpose',se.purpose),
  'round',jsonb_build_object('id',r.id,'label',r.label,'periodStart',r.period_start,'periodEnd',r.period_end,
   'state',r.state,'versionId',r.questionnaire_version_id,'compatibilityGroup',r.compatibility_group),
  'campaign',jsonb_build_object('id',c.id,'timezone',c.timezone,'startsAt',c.starts_at,'endsAt',c.ends_at,
   'closedAt',c.closed_at,'threshold',c.threshold,'locales',to_jsonb(c.locales),'releaseState',c.release_state),
  -- Totals only. A named list is a different export with a different capability.
  'participation',jsonb_build_object('invited',invited,'completed',completed,'revoked',revoked,
   'outstanding',invited-completed-revoked,'eligible',invited-revoked,
   'rate',CASE WHEN invited-revoked=0 THEN NULL ELSE round(completed::numeric/(invited-revoked),4)::text END),
  'snapshot',publication.snapshot_document(org,s.id),
  'recommendations',publication.report_recommendations(org,s.id));
END $$;

-- The release itself, read exactly as publication.snapshot serves it to staff.
CREATE FUNCTION publication.snapshot_document(org uuid,snap uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',s.id,'campaignId',s.campaign_id,'roundId',s.round_id,
  'releaseRevision',s.release_revision,'threshold',s.threshold,'contributorCount',s.contributor_count,
  'generatedAt',s.generated_at,'period',s.closed_period,'manifest',s.report_manifest,
  'contentHash',encode(s.content_hash,'hex'),'reviewReference',s.review_reference,
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
    'value',CASE WHEN a.value IS NULL THEN NULL ELSE a.value::text END,
    'coverage',CASE WHEN a.coverage IS NULL THEN NULL ELSE trim_scale(a.coverage)::text END,
    'distribution',a.distribution,'band',a.band)
    ORDER BY a.metric_key,a.group_key) FROM publication.aggregate_cell a
    WHERE a.organization_id=s.organization_id AND a.snapshot_id=s.id),'[]'::jsonb))
 FROM publication.result_snapshot s WHERE s.organization_id=org AND s.id=snap
$$;

-- The frozen computed findings plus the consultant's own workflow row. The two
-- are returned as separate objects and are rendered under separate headings:
-- an opinion must never be printed as an automatic finding.
CREATE FUNCTION publication.report_recommendations(org uuid,snap uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'groupKey',i.group_key,'metricKey',i.metric_key,
   'ruleKey',i.rule_key,'ruleHash',encode(i.rule_hash,'hex'),'rulesVersion',i.rules_version,
   'priority',i.priority,'dedupKey',i.dedup_key,'exclusivityGroup',i.exclusivity_group,
   'severity',i.severity,'text',i.text,'evidence',i.evidence,
   'action',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('status',a.status,
     'ownerName',(SELECT u.display_name FROM access.staff_user u WHERE u.id=a.owner_staff_id),
     'dueDate',a.due_date,'staffNotes',a.staff_notes,'resolution',a.resolution,
     'updatedAt',a.updated_at) END)
   ORDER BY i.priority,i.id),'[]'::jsonb)
 FROM publication.recommendation_instance i
 LEFT JOIN core.recommendation_action a ON a.organization_id=i.organization_id AND a.instance_id=i.id
 WHERE i.organization_id=org AND i.snapshot_id=snap
$$;

-- ---------------------------------------------------------------------------
-- Staff surface.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.request_report(org uuid,body jsonb,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); c core.campaign; r core.assessment_round;
 s publication.result_snapshot; d publication.comparison_definition;
 payload jsonb; receipt uuid; job uuid; op text:=concat('report/',org); cmp uuid; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- Producing a distributable document is its own authority. Reading results on
 -- screen is not enough, and neither is managing campaigns.
 IF NOT (access.has_capability('results.read') AND access.has_capability('reports.manage'))
  THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN RETURN jsonb_build_object('id',receipt,'replayed',true); END IF;
 IF body->>'format' NOT IN ('PDF','XLSX') OR body->>'locale' NOT IN ('ar','en')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO r FROM core.assessment_round WHERE organization_id=org AND id=(body->>'roundId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO c FROM core.campaign WHERE organization_id=org AND round_id=r.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- Only a published release is reportable. A candidate, a revoked release, a
 -- below-threshold campaign and an open one all refuse here rather than
 -- producing an empty or provisional document.
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=org AND campaign_id=c.id AND state='PUBLISHED';
 IF NOT FOUND OR c.release_state<>'PUBLISHED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 cmp:=nullif(body->>'comparisonId','')::uuid;
 IF cmp IS NOT NULL THEN
  SELECT * INTO d FROM publication.comparison_definition WHERE organization_id=org AND id=cmp;
  -- A comparison from another series or another organization is not a report
  -- option; it is a refusal.
  IF NOT FOUND OR d.series_id<>r.series_id OR r.id NOT IN (d.left_round_id,d.right_round_id)
   THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END IF;
 payload:=publication.report_source_payload(org,c.id)
   || jsonb_build_object('locale',body->>'locale','format',body->>'format',
        'requestedAt',clock_timestamp(),
        'context',coalesce(body->'context','{}'::jsonb));
 PERFORM publication.check_report_input(org,payload);
 INSERT INTO ops.report_job(organization_id,campaign_id,round_id,series_id,snapshot_id,comparison_id,
   format,locale,requested_by,source,source_hash)
 VALUES(org,c.id,r.id,r.series_id,s.id,cmp,body->>'format',body->>'locale',actor,payload,
   sha256(convert_to(payload::text,'UTF8')))
 RETURNING id INTO job;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,job);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,'REPORT_REQUESTED',job,ARRAY['report','round']);
 RETURN jsonb_build_object('id',job,'replayed',false,'state','QUEUED',
  'format',body->>'format','locale',body->>'locale');
END $$;

-- The staff list. It reports state, size and expiry — never a storage key.
CREATE FUNCTION core.report_jobs(org uuid,rid uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('reports.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'roundId',j.round_id,'seriesId',j.series_id,
   'snapshotId',j.snapshot_id,'comparisonId',j.comparison_id,'format',j.format,'locale',j.locale,
   'state',CASE WHEN j.state='READY' AND j.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE j.state END,
   'attempt',j.attempt,'maxAttempts',j.max_attempts,'byteCount',j.byte_count,'pageCount',j.page_count,
   'contentHash',encode(j.content_hash,'hex'),'failureCode',j.failure_code,
   'requestedBy',(SELECT u.display_name FROM access.staff_user u WHERE u.id=j.requested_by),
   'createdAt',j.created_at,'completedAt',j.completed_at,'expiresAt',j.expires_at)
   ORDER BY j.created_at DESC,j.id)
  FROM ops.report_job j WHERE j.organization_id=org AND (rid IS NULL OR j.round_id=rid) LIMIT 100),'[]'::jsonb);
END $$;

-- Download authorization is decided HERE, at download time, against the
-- caller's current organization access and capability — never against the
-- access the requester happened to hold when the job was created.
CREATE FUNCTION core.report_download(org uuid,job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (access.has_capability('results.read') AND access.has_capability('reports.manage'))
  THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO j FROM ops.report_job WHERE id=job AND organization_id=org;
 IF NOT FOUND OR j.state<>'READY' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 -- A release revoked after the artifact was rendered stops being downloadable.
 IF NOT EXISTS(SELECT 1 FROM publication.result_snapshot s
   WHERE s.organization_id=org AND s.id=j.snapshot_id AND s.state='PUBLISHED')
  THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(access.actor(),org,'REPORT_DOWNLOADED',job,ARRAY['report']);
 RETURN jsonb_build_object('storageKey',j.storage_key,'format',j.format,'locale',j.locale,
  'byteCount',j.byte_count,'contentHash',encode(j.content_hash,'hex'),'roundId',j.round_id);
END $$;

-- ---------------------------------------------------------------------------
-- Named participation export. Separate kind, separate capability, separate
-- storage prefix, separate download routine. It contains identities and
-- completion status and NOTHING else: no response identifier, no score, no
-- result, no answer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.participation_export_rows(org uuid,cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- Exporting names is its own capability. campaigns.manage does not grant it.
 IF NOT access.has_capability('participation.export') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org)
  THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('displayReference',i.display_reference,
   'displayName',p.display_name,'privateReference',p.private_reference,
   'department',coalesce(d.name_ar,''),'departmentCode',coalesce(d.code,''),
   'status',i.status,'issued',i.token_generation>0)
   ORDER BY p.display_name,i.id)
  FROM core.invitation i
  JOIN core.participant p ON p.organization_id=i.organization_id AND p.id=i.participant_id
  LEFT JOIN core.department d ON d.organization_id=p.organization_id AND d.id=p.department_id
  WHERE i.organization_id=org AND i.campaign_id=cid),'[]'::jsonb);
END $$;

CREATE FUNCTION core.record_participation_export(org uuid,cid uuid,export uuid,generation_key uuid,
 storage_key text,items integer,ttl interval) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('participation.export') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF ttl>interval '24 hours' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org)
  THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO ops.private_export(id,organization_id,kind,campaign_id,requested_by,state,storage_key,item_count,expires_at,generation_key)
 VALUES(export,org,'PARTICIPATION',cid,actor,'READY',storage_key,items,clock_timestamp()+ttl,generation_key);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,'PARTICIPATION_EXPORT_CREATED',export,ARRAY['export','participant']);
END $$;

CREATE FUNCTION core.participation_export_download(org uuid,export uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e ops.private_export; BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('participation.export') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO e FROM ops.private_export WHERE id=export AND organization_id=org AND kind='PARTICIPATION';
 IF NOT FOUND OR e.state<>'READY' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(access.actor(),org,'PARTICIPATION_EXPORT_DOWNLOADED',export,ARRAY['export']);
 RETURN e.storage_key;
END $$;

-- The link-export policy predicate already admits participation.export; the
-- PARTICIPATION rows are covered by the same organization-scoped policy.

-- ---------------------------------------------------------------------------
-- Renderer surface. Four routines, and no way to name an organization, a
-- campaign, a participant or a snapshot directly: a worker addresses a JOB.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.claim_report_jobs(limit_rows integer DEFAULT 4,lease interval DEFAULT interval '10 minutes')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claimed jsonb; BEGIN
 IF limit_rows<1 OR limit_rows>20 OR lease>interval '1 hour' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 WITH due AS (
  SELECT id FROM ops.report_job
   WHERE state='QUEUED'
      OR (state='RUNNING' AND lease_expires_at<=clock_timestamp())
   ORDER BY created_at LIMIT limit_rows FOR UPDATE SKIP LOCKED),
 taken AS (
  UPDATE ops.report_job j SET state='RUNNING', attempt=j.attempt+1,
    started_at=coalesce(j.started_at,clock_timestamp()),
    lease_expires_at=clock_timestamp()+lease
   FROM due WHERE j.id=due.id RETURNING j.id,j.format,j.locale,j.attempt,j.max_attempts,j.organization_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'format',format,'locale',locale,
   'attempt',attempt,'maxAttempts',max_attempts,'organizationId',organization_id)),'[]'::jsonb)
  INTO claimed FROM taken;
 RETURN claimed;
END $$;

-- The frozen source, and only while this worker actually holds the lease.
CREATE FUNCTION publication.report_job_source(job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; BEGIN
 SELECT * INTO j FROM ops.report_job WHERE id=job;
 IF NOT FOUND OR j.state<>'RUNNING' OR j.lease_expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN j.source;
END $$;

-- Completion is idempotent: a job already READY keeps the artifact it has and
-- reports REUSED, so a duplicated delivery cannot replace bytes staff may
-- already hold.
CREATE FUNCTION publication.complete_report_job(job uuid,storage text,bytes bigint,hash bytea,
 pages integer,ttl interval DEFAULT interval '24 hours') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; BEGIN
 -- The ceiling is the retention rule. The floor only rejects a zero or negative
 -- lifetime; it is not a security property, and the suite uses a short one to
 -- exercise expiry without waiting a day.
 IF ttl>interval '24 hours' OR ttl<interval '1 second' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO j FROM ops.report_job WHERE id=job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state='READY' THEN RETURN 'REUSED'; END IF;
 IF j.state<>'RUNNING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE ops.report_job SET state='READY', storage_key=storage, byte_count=bytes, content_hash=hash,
   page_count=pages, failure_code=NULL, completed_at=clock_timestamp(),
   expires_at=clock_timestamp()+ttl, lease_expires_at=NULL
  WHERE id=job;
 RETURN 'READY';
END $$;

CREATE FUNCTION publication.fail_report_job(job uuid,code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; next_state text; BEGIN
 IF code IS NULL OR length(code)>80 OR code !~ '^[A-Z_]+$' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO j FROM ops.report_job WHERE id=job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state='READY' THEN RETURN 'READY'; END IF;
 IF j.state<>'RUNNING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 next_state:=CASE WHEN j.attempt>=j.max_attempts THEN 'FAILED' ELSE 'QUEUED' END;
 UPDATE ops.report_job SET state=next_state, failure_code=code, lease_expires_at=NULL WHERE id=job;
 RETURN next_state;
END $$;

-- Retention janitor. It returns the storage keys whose rows it just expired so
-- the operator process can delete the objects; the row keeps its history.
CREATE FUNCTION publication.expire_report_jobs(limit_rows integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; BEGIN
 IF limit_rows<1 OR limit_rows>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 WITH due AS (
  SELECT id, storage_key FROM ops.report_job
    WHERE state='READY' AND expires_at<=clock_timestamp()
    ORDER BY expires_at LIMIT limit_rows FOR UPDATE SKIP LOCKED),
 gone AS (
  UPDATE ops.report_job j SET state='EXPIRED', storage_key=NULL FROM due WHERE j.id=due.id
   RETURNING j.id,j.organization_id,due.storage_key)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'organizationId',organization_id,'storageKey',storage_key)),'[]'::jsonb)
  INTO result FROM gone;
 RETURN result;
END $$;

GRANT CREATE ON SCHEMA publication,core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='publication' AND p.proname IN ('withheld_leak','check_report_input','cell_matches',
   'report_source_payload','snapshot_document','report_recommendations','claim_report_jobs',
   'report_job_source','complete_report_job','fail_report_job','expire_report_jobs'))
    OR (n.nspname='core' AND p.proname IN ('request_report','report_jobs','report_download',
   'participation_export_rows','record_participation_export','participation_export_download'))
 LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication,core FROM orgfit_access_executor;

GRANT EXECUTE ON FUNCTION core.request_report(uuid,jsonb,uuid,bytea),core.report_jobs(uuid,uuid),
 core.report_download(uuid,uuid),core.participation_export_rows(uuid,uuid),
 core.record_participation_export(uuid,uuid,uuid,uuid,text,integer,interval),
 core.participation_export_download(uuid,uuid) TO orgfit_staff;

-- The renderer identity. USAGE on one schema and four routines; nothing else
-- anywhere. It holds no SELECT on core.participant, core.invitation, intake,
-- instrument or publication, and it has no CONNECT on the anonymous database.
GRANT USAGE ON SCHEMA publication TO orgfit_report;
GRANT EXECUTE ON FUNCTION publication.claim_report_jobs(integer,interval),
 publication.report_job_source(uuid),
 publication.complete_report_job(uuid,text,bigint,bytea,integer,interval),
 publication.fail_report_job(uuid,text),
 publication.expire_report_jobs(integer) TO orgfit_report;
