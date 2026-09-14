-- ===========================================================================
-- Post-Audit Repair Pass 3: withdrawing a published release (SEC-M5).
--
-- Migration 010 already allows PUBLISHED -> REVOKED and every staff read path
-- already serves only PUBLISHED snapshots. What was missing is the operation
-- itself and the places where "only PUBLISHED" was checked once, too early, or
-- not at all:
--
--   * nothing could revoke a release except a raw UPDATE;
--   * a report job references its own snapshot, but its frozen source can also
--     quote another round's release (trend points) and a reviewed comparison
--     (both sides). Download checked only the job's own snapshot;
--   * request_report read "PUBLISHED" without a lock, so a revocation that
--     committed between that read and the INSERT left a new job behind;
--   * download read "PUBLISHED" without a lock, so a revocation could commit
--     between authorization and the bytes being read;
--   * complete_report_job and fail_report_job raised on a job that was revoked
--     while it rendered, so the worker aborted and the bytes it had just
--     written stayed behind;
--   * a follow-up on a withdrawn recommendation could still be edited;
--   * a restore to a backup older than the revocation would have republished it.
--
-- What revocation deliberately does NOT do: it deletes no snapshot, cell,
-- recommendation, comparison review, report source or audit row. The release
-- remains immutable historical evidence, reachable only by the owner roles and
-- the restricted status routine below. It cannot recall a file that was
-- already downloaded; the revocation record counts how many downloads of the
-- affected reports had happened, so that fact is explicit.
--
-- Released migrations are not edited. Routines restated here keep their
-- signature, owner and grants.
-- ===========================================================================

-- --- vocabulary --------------------------------------------------------------
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED','INVITATION_CREATED','INVITATION_ACCEPTED','PASSWORD_SET','SETTINGS_CHANGED','AUDIT_EXPORTED','RELEASE_REVOKED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison','report','visit','followUp','attachment','password','settings','session','audit','release']::text[]);

-- A revocation is replayed after a restore like a deletion is (017).
ALTER TABLE ops.deletion_tombstone DROP CONSTRAINT deletion_tombstone_class_check;
ALTER TABLE ops.deletion_tombstone ADD CONSTRAINT deletion_tombstone_class_check
 CHECK(class IN ('ATTACHMENT','REPORT_ARTIFACT','PRIVATE_EXPORT','CAMPAIGN_INTAKE','CAMPAIGN_KEY','ANONYMOUS_CAMPAIGN','RELEASE_REVOCATION'));

-- --- the revocation record ----------------------------------------------------
-- One per release, immutable. The UNIQUE key is what makes a retried or
-- concurrent revocation of the same release land on one record.
CREATE TABLE publication.release_revocation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 snapshot_id uuid NOT NULL, campaign_id uuid NOT NULL, round_id uuid NOT NULL,
 reason_code text NOT NULL CHECK(reason_code IN ('PRIVACY_INCIDENT','CORRECTNESS_ERROR','DATA_INTEGRITY','OWNER_DECISION','RESTORE_REPLAY')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 2000),
 incident_reference text NOT NULL CHECK(length(trim(incident_reference)) BETWEEN 1 AND 200),
 -- STAFF: a signed-in Super Admin. OPERATOR: the operator command, recording
 -- the Super Admin who approved it. RESTORE_REPLAY: re-applied from the
 -- tombstone ledger after a restore lost the original record.
 channel text NOT NULL CHECK(channel IN ('STAFF','OPERATOR','RESTORE_REPLAY')),
 revoked_by uuid REFERENCES access.staff_user,
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reports_revoked integer NOT NULL CHECK(reports_revoked>=0),
 -- Downloads of the affected reports that had already happened. They cannot
 -- be recalled; this number says how many copies may exist outside OrgFit.
 downloads_before integer NOT NULL CHECK(downloads_before>=0),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,snapshot_id),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES publication.result_snapshot(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id),
 FOREIGN KEY(organization_id,round_id) REFERENCES core.assessment_round(organization_id,id),
 CHECK((channel='RESTORE_REPLAY')=(revoked_by IS NULL)),
 CHECK((channel='RESTORE_REPLAY')=(reason_code='RESTORE_REPLAY'))
);
CREATE INDEX ON publication.release_revocation(revoked_by);
CREATE INDEX ON publication.release_revocation(organization_id,campaign_id);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON publication.release_revocation
 FOR EACH ROW EXECUTE FUNCTION publication.immutable();

-- --- what every report job depends on ------------------------------------------
-- The job's own release, both sides of a cited comparison, and every other
-- round whose released value the frozen source quotes. A revocation of any of
-- them revokes the job; a download re-checks all of them.
CREATE TABLE ops.report_job_dependency (
 organization_id uuid NOT NULL, job_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 PRIMARY KEY(organization_id,job_id,snapshot_id),
 FOREIGN KEY(organization_id,job_id) REFERENCES ops.report_job(organization_id,id),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES publication.result_snapshot(organization_id,id)
);
CREATE INDEX ON ops.report_job_dependency(organization_id,snapshot_id,job_id);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ops.report_job_dependency
 FOR EACH ROW EXECUTE FUNCTION publication.immutable();

-- Bytes of a revoked report that still have to be removed from storage. The
-- report worker drains it (it holds the storage credential; staff and the
-- revocation transaction do not delete objects). Download is already refused
-- by the row state, so a pending purge exposes nothing.
CREATE TABLE ops.report_artifact_purge (
 organization_id uuid NOT NULL, job_id uuid NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 purged_at timestamptz,
 PRIMARY KEY(organization_id,job_id),
 FOREIGN KEY(organization_id,job_id) REFERENCES ops.report_job(organization_id,id)
);
CREATE INDEX report_artifact_purge_pending_idx ON ops.report_artifact_purge(requested_at) WHERE purged_at IS NULL;

-- The snapshots a frozen source quotes, other than the job's own and the
-- comparison's: trend points that carry a value. A point without a value
-- quotes nothing and therefore depends on nothing (a revoked round becomes a
-- gap in later trends and must not block every later report of the series).
CREATE FUNCTION publication.report_source_snapshots(org uuid,source jsonb) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg(DISTINCT (p.value->>'roundId')::uuid),'{}')
   FROM jsonb_array_elements(coalesce(source#>'{context,history,trends}','[]'::jsonb)) t,
        jsonb_array_elements(coalesce(t.value->'points','[]'::jsonb)) p
  WHERE jsonb_typeof(p.value->'value') IS DISTINCT FROM 'null' AND p.value ? 'roundId'
$$;

-- Runs inside the INSERT of every new report job, after request_report built
-- and checked its source. It takes SHARE locks on every release the job depends
-- on, in snapshot-id order, and re-reads their state under the lock. A
-- revocation holds the row lock of its snapshot until it commits, so either the
-- revocation committed first and this refuses, or this commits first and the
-- revocation (which locks jobs after its snapshot) sees and revokes the job.
CREATE FUNCTION ops.report_job_dependencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d publication.comparison_definition; rounds uuid[]; wanted uuid[]; locked record; n integer; BEGIN
 wanted:=ARRAY[NEW.snapshot_id];
 IF NEW.comparison_id IS NOT NULL THEN
  SELECT * INTO d FROM publication.comparison_definition WHERE organization_id=NEW.organization_id AND id=NEW.comparison_id;
  wanted:=wanted||d.left_snapshot_id||d.right_snapshot_id;
 END IF;
 rounds:=publication.report_source_snapshots(NEW.organization_id,NEW.source);
 IF cardinality(rounds)>0 THEN
  -- One release per round: resolve each quoted round to its snapshot. A
  -- quoted value whose round has no release at all is refused.
  SELECT count(DISTINCT s.round_id) INTO n FROM publication.result_snapshot s
   WHERE s.organization_id=NEW.organization_id AND s.round_id=ANY(rounds) AND s.state IN ('PUBLISHED','REVOKED');
  IF n<>cardinality(rounds) THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
  wanted:=wanted||ARRAY(SELECT s.id FROM publication.result_snapshot s
   WHERE s.organization_id=NEW.organization_id AND s.round_id=ANY(rounds) AND s.state IN ('PUBLISHED','REVOKED'));
 END IF;
 FOR locked IN SELECT s.id, s.state FROM publication.result_snapshot s
   WHERE s.organization_id=NEW.organization_id AND s.id=ANY(wanted)
   ORDER BY s.id FOR SHARE OF s LOOP
  IF locked.state<>'PUBLISHED' THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
  INSERT INTO ops.report_job_dependency(organization_id,job_id,snapshot_id)
  VALUES(NEW.organization_id,NEW.id,locked.id) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER dependencies AFTER INSERT ON ops.report_job
 FOR EACH ROW EXECUTE FUNCTION ops.report_job_dependencies();

-- Jobs that already exist: the same three sources, without the lock (nothing
-- else runs during a migration). A revoked dependency is recorded too, so a
-- job whose release was withdrawn before this migration stays refused.
INSERT INTO ops.report_job_dependency(organization_id,job_id,snapshot_id)
SELECT j.organization_id,j.id,j.snapshot_id FROM ops.report_job j
UNION
SELECT j.organization_id,j.id,x.sid FROM ops.report_job j
 JOIN publication.comparison_definition d ON d.organization_id=j.organization_id AND d.id=j.comparison_id
 CROSS JOIN LATERAL (VALUES (d.left_snapshot_id),(d.right_snapshot_id)) x(sid)
UNION
SELECT j.organization_id,j.id,s.id FROM ops.report_job j
 JOIN publication.result_snapshot s ON s.organization_id=j.organization_id
  AND s.round_id=ANY(publication.report_source_snapshots(j.organization_id,j.source))
ON CONFLICT DO NOTHING;

-- --- guards that make "revoked" final -----------------------------------------
-- A revoked campaign never returns to another release state. The processor's
-- queue already skips REVOKED (010); this also stops a stale publication run
-- that picked the campaign before it was published and revoked.
CREATE FUNCTION core.campaign_release_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.release_state='REVOKED' AND NEW.release_state IS DISTINCT FROM 'REVOKED' THEN
  RAISE EXCEPTION 'RELEASE_REVOKED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER release_revoked BEFORE UPDATE OF release_state ON core.campaign
 FOR EACH ROW EXECUTE FUNCTION core.campaign_release_revoked();

-- No new release for a campaign whose release was revoked. A corrected
-- release is a reviewed new revision (state-machines.md) and needs its own
-- workflow; until one exists, the processor cannot silently republish.
CREATE FUNCTION publication.snapshot_after_revocation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM publication.result_snapshot s
   WHERE s.organization_id=NEW.organization_id AND s.campaign_id=NEW.campaign_id AND s.state='REVOKED')
  THEN RAISE EXCEPTION 'RELEASE_REVOKED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER after_revocation BEFORE INSERT ON publication.result_snapshot
 FOR EACH ROW EXECUTE FUNCTION publication.snapshot_after_revocation();

-- A follow-up belongs to a published finding. Once the release is withdrawn the
-- workflow row is frozen with it (still readable by the owner roles as history).
CREATE FUNCTION core.recommendation_action_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE st text; BEGIN
 SELECT s.state INTO st FROM publication.recommendation_instance i
  JOIN publication.result_snapshot s ON s.organization_id=i.organization_id AND s.id=i.snapshot_id
  WHERE i.organization_id=NEW.organization_id AND i.id=NEW.instance_id
  FOR SHARE OF s;
 IF st IS DISTINCT FROM 'PUBLISHED' THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER release_published BEFORE INSERT OR UPDATE ON core.recommendation_action
 FOR EACH ROW EXECUTE FUNCTION core.recommendation_action_release();

-- --- the operation --------------------------------------------------------------
-- Internal. Not executable by any login role; the three wrappers below decide
-- who is asking. Lock order: campaign, snapshot, report jobs (by id) — the
-- same campaign-first order publish_release uses, and the snapshot-before-job
-- order every report routine below uses, so none of them can deadlock with it.
CREATE FUNCTION publication.apply_revocation(org uuid,snap uuid,code text,why text,reference text,
 via text,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; s publication.result_snapshot; existing publication.release_revocation;
 rid uuid; revoked_jobs uuid[]; purge_jobs uuid[]; downloads integer; BEGIN
 SELECT * INTO s FROM publication.result_snapshot WHERE organization_id=org AND id=snap;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO c FROM core.campaign WHERE organization_id=org AND id=s.campaign_id FOR UPDATE;
 SELECT * INTO s FROM publication.result_snapshot WHERE organization_id=org AND id=snap FOR UPDATE;
 SELECT * INTO existing FROM publication.release_revocation WHERE organization_id=org AND snapshot_id=snap;
 IF FOUND THEN
  -- The same request again (a retry after a lost answer, or two operators
  -- entering the same decision) returns the one record. A different decision
  -- about a release that is already withdrawn is a conflict, not an overwrite.
  IF existing.reason_code=code AND existing.reason=why AND existing.incident_reference=reference THEN
   RETURN jsonb_build_object('id',existing.id,'snapshotId',snap,'replayed',true,
    'reportsRevoked',existing.reports_revoked,'downloadsBefore',existing.downloads_before);
  END IF;
  RAISE EXCEPTION 'RELEASE_ALREADY_REVOKED';
 END IF;
 IF s.state='REVOKED' THEN
  -- Withdrawn without a record: only possible through a raw update or a
  -- restore. The record is written now so the history is complete.
  NULL;
 ELSIF s.state<>'PUBLISHED' THEN RAISE EXCEPTION 'STATE_CONFLICT';
 END IF;
 IF code NOT IN ('PRIVACY_INCIDENT','CORRECTNESS_ERROR','DATA_INTEGRITY','OWNER_DECISION','RESTORE_REPLAY')
  OR why IS NULL OR length(trim(why)) NOT BETWEEN 10 AND 2000
  OR reference IS NULL OR length(trim(reference)) NOT BETWEEN 1 AND 200
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 rid:=gen_random_uuid();
 IF s.state='PUBLISHED' THEN
  UPDATE publication.result_snapshot SET state='REVOKED', revoked_reason=concat(code,' / revocation ',rid)
   WHERE organization_id=org AND id=snap;
 END IF;
 IF c.release_state<>'REVOKED' THEN
  UPDATE core.campaign SET release_state='REVOKED',revision=revision+1,updated_at=clock_timestamp()
   WHERE organization_id=org AND id=c.id;
 END IF;
 -- Every job that quotes this release, whatever round it was requested for.
 -- READY bytes and possibly-written RUNNING bytes are queued for removal.
 SELECT coalesce(array_agg(j.id ORDER BY j.id) FILTER (WHERE j.state IN ('READY','RUNNING')),'{}'),
        coalesce(array_agg(j.id ORDER BY j.id),'{}')
   INTO purge_jobs, revoked_jobs
   FROM (SELECT j.id,j.state FROM ops.report_job j
          JOIN ops.report_job_dependency x ON x.organization_id=j.organization_id AND x.job_id=j.id
         WHERE x.organization_id=org AND x.snapshot_id=snap AND j.state IN ('QUEUED','RUNNING','READY','FAILED')
         ORDER BY j.id FOR UPDATE OF j) j;
 UPDATE ops.report_job SET state='REVOKED',storage_key=NULL,lease_expires_at=NULL
  WHERE organization_id=org AND id=ANY(revoked_jobs);
 INSERT INTO ops.report_artifact_purge(organization_id,job_id)
  SELECT org,unnest(purge_jobs) ON CONFLICT DO NOTHING;
 SELECT count(*) INTO downloads FROM ops.audit_log a
  WHERE a.organization_id=org AND a.action='REPORT_DOWNLOADED'
    AND a.target_id IN (SELECT x.job_id FROM ops.report_job_dependency x WHERE x.organization_id=org AND x.snapshot_id=snap);
 INSERT INTO publication.release_revocation(id,organization_id,snapshot_id,campaign_id,round_id,reason_code,reason,
  incident_reference,channel,revoked_by,reports_revoked,downloads_before)
 VALUES(rid,org,snap,s.campaign_id,s.round_id,code,why,reference,via,actor,cardinality(revoked_jobs),downloads);
 PERFORM ops.tombstone('RELEASE_REVOCATION',org,snap);
 IF actor IS NOT NULL THEN
  INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
  VALUES(actor,org,'RELEASE_REVOKED',snap,ARRAY['release','report']);
 END IF;
 RETURN jsonb_build_object('id',rid,'snapshotId',snap,'replayed',false,
  'reportsRevoked',cardinality(revoked_jobs),'downloadsBefore',downloads);
END $$;

-- Staff: a signed-in Super Admin with access to the organization, a reason
-- category, a written reason, an incident reference, and the snapshot's content
-- hash prefix as a typed confirmation that the right release is being
-- withdrawn. Receipt-backed like every other staff mutation.
CREATE FUNCTION publication.revoke_release(org uuid,cid uuid,body jsonb,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); s publication.result_snapshot; receipt uuid; result jsonb; op text:=concat('release-revocation/',org); BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE organization_id=org AND id=cid) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN
  RETURN (SELECT jsonb_build_object('id',r.id,'snapshotId',r.snapshot_id,'replayed',true,
    'reportsRevoked',r.reports_revoked,'downloadsBefore',r.downloads_before)
   FROM publication.release_revocation r WHERE r.organization_id=org AND r.id=receipt);
 END IF;
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=org AND campaign_id=cid AND state IN ('PUBLISHED','REVOKED')
  ORDER BY (state='PUBLISHED') DESC, release_revision DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF body->>'snapshotId' IS DISTINCT FROM s.id::text
  OR lower(coalesce(body->>'confirmation','')) IS DISTINCT FROM left(encode(s.content_hash,'hex'),8)
  THEN RAISE EXCEPTION 'CONFIRMATION_MISMATCH'; END IF;
 result:=publication.apply_revocation(org,s.id,body->>'reasonCode',body->>'reason',body->>'incidentReference','STAFF',actor);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,(result->>'id')::uuid);
 RETURN result;
END $$;

-- Operator: the command line run under the operator credential, for when no
-- Super Admin can sign in. It still names the Super Admin who approved the
-- decision, and refuses one who is not an active Super Admin.
CREATE FUNCTION publication.operator_revoke_release(org uuid,snap uuid,approver_email text,code text,why text,reference text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE approver uuid; BEGIN
 SELECT id INTO approver FROM access.staff_user
  WHERE lower(email)=lower(approver_email) AND role='SUPER_ADMIN' AND status='ACTIVE';
 IF approver IS NULL THEN RAISE EXCEPTION 'APPROVER_REQUIRED'; END IF;
 IF code='RESTORE_REPLAY' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 RETURN publication.apply_revocation(org,snap,code,why,reference,'OPERATOR',approver);
END $$;

-- Restore replay: a revocation in the tombstone ledger whose release the
-- restored database shows as published again is withdrawn again. The original
-- reason was in the lost record; this one says where it came from.
CREATE FUNCTION publication.reapply_revocation(org uuid,snap uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM publication.release_revocation WHERE organization_id=org AND snapshot_id=snap) THEN
  RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM publication.result_snapshot WHERE organization_id=org AND id=snap) THEN
  RETURN false; END IF;
 PERFORM publication.apply_revocation(org,snap,'RESTORE_REPLAY',
  'Re-applied from the tombstone ledger after a restore; the original revocation record was newer than the backup.',
  'tombstone-ledger','RESTORE_REPLAY',NULL);
 RETURN true;
END $$;

-- What any results reader may know about a campaign's release, and what only a
-- Super Admin may know about its withdrawal. No cell, count or value.
CREATE FUNCTION publication.release_status(org uuid,cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; s publication.result_snapshot; r publication.release_revocation; admin boolean; BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO c FROM core.campaign WHERE organization_id=org AND id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 admin:=access.is_admin();
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=org AND campaign_id=cid AND state IN ('PUBLISHED','REVOKED')
  ORDER BY (state='PUBLISHED') DESC, release_revision DESC LIMIT 1;
 SELECT * INTO r FROM publication.release_revocation WHERE organization_id=org AND snapshot_id=s.id;
 RETURN jsonb_build_object('campaignId',c.id,'roundId',c.round_id,'releaseState',c.release_state,
  'snapshotId',s.id,'snapshotState',s.state,
  -- The same eight characters the results header shows as SNAPSHOT; typed back
  -- to confirm a withdrawal. A hash prefix of published aggregate content.
  'fingerprint',left(encode(s.content_hash,'hex'),8),
  'canRevoke',coalesce(admin AND s.state='PUBLISHED',false),
  'revocation',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
    'revokedAt',r.revoked_at,'reasonCode',r.reason_code,'channel',r.channel,
    'reportsRevoked',r.reports_revoked,'downloadsBefore',r.downloads_before)
   || CASE WHEN admin THEN jsonb_build_object('id',r.id,'reason',r.reason,'incidentReference',r.incident_reference,
     'revokedBy',(SELECT u.display_name FROM access.staff_user u WHERE u.id=r.revoked_by)) ELSE '{}'::jsonb END END);
END $$;

-- --- report routines, restated ---------------------------------------------------
-- Download: SHARE-lock every release the job depends on (by id), then the job,
-- then decide. A revocation that has not committed waits for this transaction,
-- which ends only after the staff route has read the bytes; one that committed
-- first is seen here. A revoked job says so rather than "not found".
CREATE OR REPLACE FUNCTION core.report_download(org uuid,job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; unpublished integer; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (access.has_capability('results.read') AND access.has_capability('reports.manage'))
  THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT count(*) FILTER (WHERE q.state<>'PUBLISHED') INTO unpublished FROM (
  SELECT s.state FROM publication.result_snapshot s
   JOIN ops.report_job_dependency x ON x.organization_id=s.organization_id AND x.snapshot_id=s.id
  WHERE x.organization_id=org AND x.job_id=job
  ORDER BY s.id FOR SHARE OF s) q;
 SELECT * INTO j FROM ops.report_job WHERE id=job AND organization_id=org FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state='REVOKED' THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
 IF j.state<>'READY' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 IF unpublished>0 OR NOT EXISTS(SELECT 1 FROM publication.result_snapshot s
   WHERE s.organization_id=org AND s.id=j.snapshot_id AND s.state='PUBLISHED')
  THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(access.actor(),org,'REPORT_DOWNLOADED',job,ARRAY['report']);
 RETURN jsonb_build_object('storageKey',j.storage_key,'format',j.format,'locale',j.locale,
  'byteCount',j.byte_count,'contentHash',encode(j.content_hash,'hex'),'roundId',j.round_id);
END $$;

-- A job revoked while it rendered answers REVOKED instead of raising, so the
-- worker removes the bytes it just wrote and carries on with the next job.
CREATE OR REPLACE FUNCTION publication.complete_report_job(job uuid,storage text,bytes bigint,hash bytea,
 pages integer,ttl interval DEFAULT interval '24 hours') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; BEGIN
 IF ttl>interval '24 hours' OR ttl<interval '1 second' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO j FROM ops.report_job WHERE id=job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state='READY' THEN RETURN 'REUSED'; END IF;
 IF j.state='REVOKED' THEN RETURN 'REVOKED'; END IF;
 IF j.state<>'RUNNING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE ops.report_job SET state='READY', storage_key=storage, byte_count=bytes, content_hash=hash,
   page_count=pages, failure_code=NULL, completed_at=clock_timestamp(),
   expires_at=clock_timestamp()+ttl, lease_expires_at=NULL
  WHERE id=job;
 RETURN 'READY';
END $$;

CREATE OR REPLACE FUNCTION publication.fail_report_job(job uuid,code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; next_state text; BEGIN
 IF code IS NULL OR length(code)>80 OR code !~ '^[A-Z_]+$' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO j FROM ops.report_job WHERE id=job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state='READY' THEN RETURN 'READY'; END IF;
 IF j.state='REVOKED' THEN RETURN 'REVOKED'; END IF;
 IF j.state<>'RUNNING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 next_state:=CASE WHEN j.attempt>=j.max_attempts THEN 'FAILED' ELSE 'QUEUED' END;
 UPDATE ops.report_job SET state=next_state, failure_code=code, lease_expires_at=NULL WHERE id=job;
 RETURN next_state;
END $$;

-- The renderer's purge queue: identifiers only, then a confirmation per job.
CREATE FUNCTION publication.pending_report_purges(limit_rows integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF limit_rows<1 OR limit_rows>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',p.organization_id,'id',p.job_id) ORDER BY p.requested_at,p.job_id)
  FROM (SELECT * FROM ops.report_artifact_purge WHERE purged_at IS NULL ORDER BY requested_at,job_id LIMIT limit_rows) p),'[]'::jsonb);
END $$;
CREATE FUNCTION publication.confirm_report_purge(org uuid,job uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH done AS (UPDATE ops.report_artifact_purge SET purged_at=clock_timestamp()
  WHERE organization_id=org AND job_id=job AND purged_at IS NULL RETURNING 1)
 SELECT EXISTS(SELECT 1 FROM done)
$$;

-- The comparison list says whether each review can still be opened.
CREATE OR REPLACE FUNCTION publication.comparisons(org uuid,sid uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'seriesId',d.series_id,
   'leftRoundId',d.left_round_id,'rightRoundId',d.right_round_id,'classification',d.classification,
   'rationale',d.rationale,'reviewedAt',d.created_at,
   'reviewedBy',(SELECT u.display_name FROM access.staff_user u WHERE u.id=d.reviewed_by),
   'available',NOT EXISTS(SELECT 1 FROM publication.result_snapshot s
     WHERE s.organization_id=d.organization_id AND s.id IN (d.left_snapshot_id,d.right_snapshot_id) AND s.state<>'PUBLISHED'))
   ORDER BY d.created_at DESC,d.id)
  FROM publication.comparison_definition d
  WHERE d.organization_id=org AND (sid IS NULL OR d.series_id=sid) LIMIT 100),'[]'::jsonb);
END $$;

-- --- ownership, RLS and grants ----------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['publication.release_revocation','ops.report_job_dependency','ops.report_artifact_purge'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON publication.release_revocation,ops.report_job_dependency TO orgfit_access_executor;
GRANT SELECT,INSERT,UPDATE ON ops.report_artifact_purge TO orgfit_access_executor;

GRANT CREATE ON SCHEMA publication,ops,core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE (n.nspname='publication' AND p.proname IN ('report_source_snapshots','snapshot_after_revocation','apply_revocation',
     'revoke_release','operator_revoke_release','reapply_revocation','release_status','pending_report_purges','confirm_report_purge'))
     OR (n.nspname='ops' AND p.proname='report_job_dependencies')
     OR (n.nspname='core' AND p.proname IN ('campaign_release_revoked','recommendation_action_release')) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication,ops,core FROM orgfit_access_executor;

GRANT EXECUTE ON FUNCTION publication.revoke_release(uuid,uuid,jsonb,uuid,bytea),
 publication.release_status(uuid,uuid) TO orgfit_staff;
GRANT EXECUTE ON FUNCTION publication.operator_revoke_release(uuid,uuid,text,text,text,text),
 publication.reapply_revocation(uuid,uuid) TO orgfit_core_owner;
GRANT EXECUTE ON FUNCTION publication.pending_report_purges(integer),
 publication.confirm_report_purge(uuid,uuid) TO orgfit_report;
