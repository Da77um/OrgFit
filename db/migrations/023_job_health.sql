-- ===========================================================================
-- Post-Audit Repair Pass 3: background job health.
--
-- The job scripts of deploy/processes.json ran only when someone started them,
-- and nothing recorded whether they had. The supervisor (scripts/supervise.ts)
-- now runs them on their cadence, but it holds no database credential by
-- design, so the database learns about a run from the job itself: each job
-- records its own outcome through one routine, under its own login, and may
-- record only the jobs of its own process.
--
-- One row per job, overwritten per run: last start, last success, last
-- failure, a failure CODE (never a message), consecutive failures and a few
-- named counts. No identifier, value, file name or message is stored, so this
-- table can be shown on the administrator status screen as it is.
--
-- A job that cannot reach the database cannot record its failure. That is why
-- staleness is computed from the last SUCCESS against the job's expected
-- cadence, rather than trusted from a failure row that may never arrive.
-- ===========================================================================

CREATE TABLE ops.job_status (
 job text PRIMARY KEY CHECK(job ~ '^[a-z]+:[a-z-]+$'),
 process text NOT NULL CHECK(process IN ('processor','report','scanner','operator')),
 expected_interval_seconds integer NOT NULL CHECK(expected_interval_seconds BETWEEN 30 AND 604800),
 last_started_at timestamptz, last_finished_at timestamptz,
 last_success_at timestamptz, last_failure_at timestamptz,
 last_outcome text CHECK(last_outcome IN ('SUCCESS','FAILURE')),
 last_failure_code text CHECK(last_failure_code ~ '^[A-Z][A-Z_]{0,79}$'),
 consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
 last_duration_ms integer CHECK(last_duration_ms>=0),
 last_counts jsonb CHECK(last_counts IS NULL OR (jsonb_typeof(last_counts)='object' AND octet_length(last_counts::text)<=1024))
);
-- Cadences exactly as deploy/processes.json states them (tests/supervisor.test.ts
-- asserts the two agree). campaigns:normalize, drafts:expire, retention:run,
-- tombstones:ship and ops:check are the operator's; restore:reapply and the
-- migrations are release steps, not scheduled jobs.
INSERT INTO ops.job_status(job,process,expected_interval_seconds) VALUES
 ('privacy:process','processor',300),
 ('publication:release','processor',300),
 ('reports:generate','report',60),
 ('reports:expire','report',3600),
 ('attachments:scan','scanner',60),
 ('attachments:expire','scanner',3600),
 ('campaigns:normalize','operator',300),
 ('drafts:expire','operator',3600),
 ('retention:run','operator',86400),
 ('tombstones:ship','operator',300),
 ('ops:check','operator',120);

-- The login that runs a job decides which rows it may write. Inside a SECURITY
-- DEFINER routine current_user is the owner, so the caller is session_user:
-- the login role itself, which SET ROLE does not change.
CREATE FUNCTION ops.record_job_run(job_name text,started timestamptz,outcome text,failure_code text,counts jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected text; j ops.job_status; BEGIN
 expected:=CASE session_user::text
  WHEN 'orgfit_processor' THEN 'processor'
  WHEN 'orgfit_report' THEN 'report'
  WHEN 'orgfit_scanner' THEN 'scanner'
  WHEN 'orgfit_migrator' THEN 'operator'
  ELSE NULL END;
 SELECT * INTO j FROM ops.job_status WHERE job=job_name FOR UPDATE;
 IF NOT FOUND OR expected IS NULL OR j.process<>expected THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF outcome NOT IN ('SUCCESS','FAILURE') OR started IS NULL OR started>clock_timestamp()+interval '1 minute'
  OR (outcome='FAILURE' AND (failure_code IS NULL OR failure_code !~ '^[A-Z][A-Z_]{0,79}$'))
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 -- Counts are named numbers and nothing else: a string could carry an
 -- identifier, a name or a driver message.
 IF counts IS NOT NULL AND (jsonb_typeof(counts)<>'object'
   OR (SELECT count(*) FROM jsonb_object_keys(counts))>20
   OR EXISTS(SELECT 1 FROM jsonb_each(counts) e WHERE e.key !~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'
     OR jsonb_typeof(e.value)<>'number'))
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 -- A slower, older run finishing after a newer one does not overwrite it.
 IF j.last_started_at IS NOT NULL AND started<j.last_started_at THEN RETURN; END IF;
 UPDATE ops.job_status SET
  last_started_at=started, last_finished_at=clock_timestamp(),
  last_outcome=outcome,
  last_success_at=CASE WHEN outcome='SUCCESS' THEN clock_timestamp() ELSE last_success_at END,
  last_failure_at=CASE WHEN outcome='FAILURE' THEN clock_timestamp() ELSE last_failure_at END,
  last_failure_code=CASE WHEN outcome='FAILURE' THEN failure_code ELSE last_failure_code END,
  consecutive_failures=CASE WHEN outcome='SUCCESS' THEN 0 ELSE consecutive_failures+1 END,
  last_duration_ms=greatest(0,(extract(epoch FROM clock_timestamp()-started)*1000)::integer),
  last_counts=counts
 WHERE job=job_name;
END $$;

-- Health per job plus the backlog each one drains. A job is STALE when it has
-- not succeeded within three of its intervals (plus a minute of scheduling
-- slack), FAILING when its last run failed, NEVER_RUN when it has no run at all.
CREATE FUNCTION ops.job_health() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'jobs',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'job',s.job,'process',s.process,'expectedIntervalSeconds',s.expected_interval_seconds,
    'lastStartedAt',s.last_started_at,'lastFinishedAt',s.last_finished_at,
    'lastSuccessAt',s.last_success_at,'lastFailureAt',s.last_failure_at,
    'lastOutcome',s.last_outcome,'lastFailureCode',s.last_failure_code,
    'consecutiveFailures',s.consecutive_failures,'lastDurationMs',s.last_duration_ms,
    'lastCounts',s.last_counts,
    'health',CASE
      WHEN s.last_started_at IS NULL THEN 'NEVER_RUN'
      WHEN s.last_outcome='FAILURE' THEN 'FAILING'
      WHEN s.last_success_at < clock_timestamp()-make_interval(secs=>s.expected_interval_seconds*3+60) THEN 'STALE'
      ELSE 'OK' END) ORDER BY s.process,s.job) FROM ops.job_status s),'[]'::jsonb),
  'backlog',jsonb_build_object(
   'closedCampaignsAwaitingProcessing',(SELECT count(*) FROM core.campaign c WHERE c.state='CLOSED'
     AND c.release_state NOT IN ('PUBLISHED','REVOKED','INSUFFICIENT_DATA')),
   'reportsQueued',(SELECT count(*) FROM ops.report_job WHERE state='QUEUED'),
   'reportsRunning',(SELECT count(*) FROM ops.report_job WHERE state='RUNNING'),
   'reportPurgesPending',(SELECT count(*) FROM ops.report_artifact_purge WHERE purged_at IS NULL),
   'attachmentsQuarantined',(SELECT count(*) FROM core.attachment WHERE scan_status='QUARANTINED'),
   'revokedReleases',(SELECT count(*) FROM publication.release_revocation)),
  'readAt',clock_timestamp());
$$;

-- ---------------------------------------------------------------------------
-- Defect found by this pass (PR3-001): a crashed renderer blocked every report.
--
-- claim_report_jobs (014) selects "QUEUED, or RUNNING with an elapsed lease"
-- and sets both to RUNNING. The lifecycle trigger of the same migration does not
-- allow RUNNING -> RUNNING, so the moment one worker died holding a lease, the
-- whole claim statement raised REPORT_IMMUTABLE — for that job AND for every
-- queued job behind it. No report was drawn again until someone intervened.
-- The retry story the 014 comment describes ("a RUNNING job whose lease has
-- elapsed returns to QUEUED") was never what the code did.
--
-- Restated: first return elapsed leases to QUEUED (an allowed transition), or
-- to FAILED with LEASE_EXPIRED once the job has used its attempts — so a job
-- that crashes its worker every time cannot be claimed forever — then claim.
-- Found by the supervisor end-to-end run (tests/supervisor.test.ts SV-9).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION publication.claim_report_jobs(limit_rows integer DEFAULT 4,lease interval DEFAULT interval '10 minutes')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claimed jsonb; BEGIN
 IF limit_rows<1 OR limit_rows>20 OR lease>interval '1 hour' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 WITH abandoned AS (
  SELECT id FROM ops.report_job
   WHERE state='RUNNING' AND lease_expires_at<=clock_timestamp()
   ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)
 UPDATE ops.report_job j SET
   state=CASE WHEN j.attempt>=j.max_attempts THEN 'FAILED' ELSE 'QUEUED' END,
   failure_code=CASE WHEN j.attempt>=j.max_attempts THEN 'LEASE_EXPIRED' ELSE j.failure_code END,
   lease_expires_at=NULL
  FROM abandoned WHERE j.id=abandoned.id;
 WITH due AS (
  SELECT id FROM ops.report_job
   WHERE state='QUEUED'
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

-- The administrator status screen, restated from 019 with job health added.
CREATE OR REPLACE FUNCTION access.system_status() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN jsonb_build_object(
  'alerts', ops.alert_inputs(),
  'jobs', ops.job_health(),
  'localAccessEnabled', access.local_access_enabled(),
  'retention', (SELECT coalesce(jsonb_agg(jsonb_build_object(
     'class', p.class, 'retain', p.retain::text, 'basis', p.basis,
     'approved', p.approved, 'approvedAt', p.approved_at, 'approvedBy', p.approved_by) ORDER BY p.class), '[]'::jsonb)
   FROM ops.retention_policy p),
  'readAt', clock_timestamp());
END $$;

ALTER TABLE ops.job_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.job_status FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON ops.job_status TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON ops.job_status TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE ON ops.job_status TO orgfit_access_executor;

GRANT CREATE ON SCHEMA ops TO orgfit_access_executor;
ALTER FUNCTION ops.record_job_run(text,timestamptz,text,text,jsonb) OWNER TO orgfit_access_executor;
ALTER FUNCTION ops.job_health() OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA ops FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION ops.record_job_run(text,timestamptz,text,text,jsonb),ops.job_health() FROM PUBLIC;

-- Each job login gets USAGE on ops and this one routine; still no table
-- privilege (the renderer's and scanner's readiness checks assert that).
GRANT USAGE ON SCHEMA ops TO orgfit_processor,orgfit_report,orgfit_scanner;
GRANT EXECUTE ON FUNCTION ops.record_job_run(text,timestamptz,text,text,jsonb)
 TO orgfit_processor,orgfit_report,orgfit_scanner,orgfit_core_owner;
GRANT EXECUTE ON FUNCTION ops.job_health() TO orgfit_core_owner;
