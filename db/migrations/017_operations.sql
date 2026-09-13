-- Phase 14: operations — public rate limits, retention, deletion tombstones and
-- the restore gate.
--
-- Nothing here reads, stores or reports an answer, a draft, a token, an IP
-- address or a participant. Rate-limit keys are keyed HMAC digests computed by
-- the gateway and bound to their window; tombstones name only the object that
-- was deleted (an attachment, a report, an export, a campaign) and never a
-- person. Retention durations below are NON-PRODUCTION DEFAULTS: every row is
-- seeded approved=false and stays that way until the owner approves it (P-004).

-- ---------------------------------------------------------------------------
-- 1. Public gateway rate limits.
--
-- A fixed window per (bucket, key). The key is an HMAC the gateway computes
-- over the IP bucket, token digest or session digest TOGETHER WITH the window
-- start, so a key from one window cannot be joined to the same client's key in
-- the next, and rows older than two windows are pruned. A limit event never
-- consumes, rotates or revokes an invitation: the routine is called before any
-- session or intake routine and changes nothing but its own counter.
-- ---------------------------------------------------------------------------
CREATE TABLE intake.rate_limit (
 bucket text NOT NULL CHECK(bucket IN ('exchange_ip','exchange_token','draft_session','final_session')),
 key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32),
 window_start timestamptz NOT NULL,
 hits integer NOT NULL CHECK(hits>=1),
 PRIMARY KEY(bucket,key_digest,window_start)
);
CREATE INDEX ON intake.rate_limit(window_start);

CREATE FUNCTION intake.rate_hit(bucket_in text,key_in bytea,window_start_in timestamptz,
 max_hits integer,window_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; ts timestamptz:=clock_timestamp(); BEGIN
 IF bucket_in NOT IN ('exchange_ip','exchange_token','draft_session','final_session')
  OR key_in IS NULL OR octet_length(key_in)<>32
  OR max_hits<1 OR max_hits>100000 OR window_seconds<1 OR window_seconds>3600
  OR window_start_in>ts+interval '5 seconds' OR window_start_in<ts-make_interval(secs=>window_seconds*2)
 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO intake.rate_limit(bucket,key_digest,window_start,hits) VALUES(bucket_in,key_in,window_start_in,1)
 ON CONFLICT(bucket,key_digest,window_start) DO UPDATE SET hits=intake.rate_limit.hits+1
 RETURNING hits INTO n;
 RETURN jsonb_build_object('allowed',n<=max_hits,
  'retryAfter',greatest(1,ceil(extract(epoch FROM window_start_in+make_interval(secs=>window_seconds)-ts))::integer));
END $$;

-- ---------------------------------------------------------------------------
-- 2. Retention policy and its run ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE ops.retention_policy (
 class text PRIMARY KEY CHECK(class ~ '^[a-z_]{3,40}$'),
 retain interval NOT NULL CHECK(retain>interval '0'),
 basis text NOT NULL CHECK(length(basis) BETWEEN 3 AND 200),
 approved boolean NOT NULL DEFAULT false,
 approved_by text CHECK(approved_by IS NULL OR length(approved_by) BETWEEN 1 AND 200),
 approved_at timestamptz,
 CHECK(approved = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
INSERT INTO ops.retention_policy(class,retain,basis) VALUES
 ('respondent_draft',        interval '30 days', 'idle TTL, renewed by a save, capped at campaign end + 7 days; deleted on acceptance'),
 ('respondent_session',      interval '12 hours','absolute session limit; pruned when it passes'),
 ('rate_limit_window',       interval '10 minutes','two windows of the longest limit'),
 ('staff_session',           interval '7 days',  'after expiry or revocation'),
 ('oidc_flow',               interval '1 day',   'after the flow expires'),
 ('password_attempt',        interval '1 day',   'after the first failure in a lock window'),
 ('staff_mutation',          interval '1 day',   'idempotency receipts after they expire'),
 ('private_export',          interval '24 hours','link, participation and directory exports after creation'),
 ('report_artifact',         interval '24 hours','rendered report bytes'),
 ('attachment',              interval '365 days','clean visit attachments'),
 ('insufficient_intake',     interval '30 days', 'below-threshold intake after closure; purged by the processor, alerted if overdue'),
 ('anonymous_response',      interval '365 days','finalized anonymous answers and scores after batch commit; published aggregates remain'),
 ('audit_log',               interval '365 days','administrative audit records'),
 ('retention_run',           interval '365 days','this ledger'),
 ('deletion_tombstone',      interval '36 days', 'must outlive the oldest restorable backup (35 days) by one day'),
 ('backup',                  interval '35 days', 'encrypted rolling backups and archived WAL');

CREATE TABLE ops.retention_run (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 class text NOT NULL REFERENCES ops.retention_policy(class),
 removed integer NOT NULL CHECK(removed>=0),
 ran_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON ops.retention_run(ran_at);

-- ---------------------------------------------------------------------------
-- 3. Deletion tombstones.
--
-- A restore brings back whatever existed when the backup was taken, including
-- objects deleted since. Every deletion that is NOT recomputable from time
-- alone leaves a tombstone here; scripts/ship-tombstones.ts copies new rows to
-- a ledger kept OUTSIDE the database backups, and scripts/restore-reapply.ts
-- replays that ledger into a restored environment before it is opened.
-- Time-based expiry (drafts, sessions, exports) needs no tombstone: re-running
-- the retention jobs after a restore removes it again.
-- ---------------------------------------------------------------------------
CREATE TABLE ops.deletion_tombstone (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 class text NOT NULL CHECK(class IN ('ATTACHMENT','REPORT_ARTIFACT','PRIVATE_EXPORT','CAMPAIGN_INTAKE','CAMPAIGN_KEY','ANONYMOUS_CAMPAIGN')),
 organization_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(class,subject_id)
);

CREATE FUNCTION ops.tombstone(class_in text,org uuid,subject uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO ops.deletion_tombstone(class,organization_id,subject_id) VALUES(class_in,org,subject)
 ON CONFLICT(class,subject_id) DO NOTHING;
$$;

-- One branch per table: PL/pgSQL resolves NEW.<column> at run time even inside
-- a condition guarded by TG_TABLE_NAME, so each table's column is read only in
-- its own branch.
CREATE FUNCTION ops.tombstone_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE after_row jsonb:=to_jsonb(NEW); before_row jsonb:=to_jsonb(OLD); BEGIN
 CASE TG_TABLE_NAME
  WHEN 'attachment' THEN
   IF after_row->>'scan_status'='EXPIRED' AND before_row->>'scan_status'<>'EXPIRED' THEN
    PERFORM ops.tombstone('ATTACHMENT',(after_row->>'organization_id')::uuid,(after_row->>'id')::uuid);
   END IF;
  WHEN 'report_job' THEN
   IF after_row->>'state'='EXPIRED' AND before_row->>'state'<>'EXPIRED' THEN
    PERFORM ops.tombstone('REPORT_ARTIFACT',(after_row->>'organization_id')::uuid,(after_row->>'id')::uuid);
   END IF;
  WHEN 'private_export' THEN
   IF after_row->>'state'='EXPIRED' AND before_row->>'state'<>'EXPIRED' THEN
    PERFORM ops.tombstone('PRIVATE_EXPORT',(after_row->>'organization_id')::uuid,(after_row->>'id')::uuid);
   END IF;
  WHEN 'campaign_key' THEN
   IF after_row->>'state'='DESTROYED' AND before_row->>'state'<>'DESTROYED' THEN
    PERFORM ops.tombstone('CAMPAIGN_KEY',(after_row->>'organization_id')::uuid,(after_row->>'campaign_id')::uuid);
   END IF;
  WHEN 'processing_batch' THEN
   IF after_row->>'state'='CLEANED' AND before_row->>'state'<>'CLEANED' THEN
    PERFORM ops.tombstone('CAMPAIGN_INTAKE',(after_row->>'organization_id')::uuid,(after_row->>'campaign_id')::uuid);
   END IF;
  ELSE NULL;
 END CASE;
 RETURN NEW;
END $$;
CREATE TRIGGER tombstone AFTER UPDATE OF scan_status ON core.attachment FOR EACH ROW EXECUTE FUNCTION ops.tombstone_trigger();
CREATE TRIGGER tombstone AFTER UPDATE OF state ON ops.report_job FOR EACH ROW EXECUTE FUNCTION ops.tombstone_trigger();
CREATE TRIGGER tombstone AFTER UPDATE OF state ON ops.private_export FOR EACH ROW EXECUTE FUNCTION ops.tombstone_trigger();
CREATE TRIGGER tombstone AFTER UPDATE OF state ON intake.campaign_key FOR EACH ROW EXECUTE FUNCTION ops.tombstone_trigger();
CREATE TRIGGER tombstone AFTER UPDATE OF state ON intake.processing_batch FOR EACH ROW EXECUTE FUNCTION ops.tombstone_trigger();

-- ---------------------------------------------------------------------------
-- 4. The restore gate. A restored environment starts REAPPLY_PENDING and the
--    staff readiness check fails until the tombstone replay has completed.
-- ---------------------------------------------------------------------------
CREATE TABLE ops.restore_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 state text NOT NULL CHECK(state IN ('NORMAL','REAPPLY_PENDING')),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO ops.restore_state(state) VALUES('NORMAL');

CREATE FUNCTION ops.ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT state='NORMAL' FROM ops.restore_state;
$$;
CREATE FUNCTION ops.set_restore_state(target_state text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF target_state NOT IN ('NORMAL','REAPPLY_PENDING') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE ops.restore_state SET state=target_state,changed_at=clock_timestamp();
 RETURN target_state;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Core purge. Time-based and idempotent; records counts only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.retain(class_in text) RETURNS interval
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT retain FROM ops.retention_policy WHERE class=class_in;
$$;

CREATE FUNCTION ops.purge_core(limit_rows integer DEFAULT 5000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ts timestamptz:=clock_timestamp(); n integer; result jsonb:='{}'::jsonb;
BEGIN
 IF limit_rows<1 OR limit_rows>100000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;

 DELETE FROM intake.rate_limit WHERE ctid IN (SELECT ctid FROM intake.rate_limit
  WHERE window_start < ts-ops.retain('rate_limit_window') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('rate_limit_window',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('rate_limit_window',n);

 DELETE FROM intake.respondent_session WHERE id IN (SELECT id FROM intake.respondent_session
  WHERE absolute_expires_at<=ts LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('respondent_session',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('respondent_session',n);

 DELETE FROM intake.draft_blob WHERE id IN (SELECT id FROM intake.draft_blob WHERE expires_at<=ts LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('respondent_draft',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('respondent_draft',n);

 DELETE FROM access.staff_session WHERE id IN (SELECT id FROM access.staff_session
  WHERE coalesce(revoked_at,least(idle_expires_at,absolute_expires_at)) < ts-ops.retain('staff_session') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('staff_session',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('staff_session',n);

 DELETE FROM access.oidc_flow WHERE ctid IN (SELECT ctid FROM access.oidc_flow
  WHERE expires_at < ts-ops.retain('oidc_flow') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('oidc_flow',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('oidc_flow',n);

 DELETE FROM access.password_attempt WHERE ctid IN (SELECT ctid FROM access.password_attempt
  WHERE first_failure_at < ts-ops.retain('password_attempt') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('password_attempt',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('password_attempt',n);

 DELETE FROM access.staff_mutation WHERE ctid IN (SELECT ctid FROM access.staff_mutation
  WHERE expires_at < ts LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('staff_mutation',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('staff_mutation',n);

 -- An export row outlives its bytes only as an EXPIRED record; the transition
 -- leaves a tombstone so a restore cannot revive a downloadable export.
 UPDATE ops.private_export SET state='EXPIRED' WHERE id IN (SELECT id FROM ops.private_export
  WHERE state NOT IN ('EXPIRED','REVOKED') AND expires_at<=ts LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('private_export',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('private_export',n);

 DELETE FROM ops.audit_log WHERE id IN (SELECT id FROM ops.audit_log
  WHERE occurred_at < ts-ops.retain('audit_log') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('audit_log',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('audit_log',n);

 DELETE FROM ops.deletion_tombstone WHERE seq IN (SELECT seq FROM ops.deletion_tombstone
  WHERE recorded_at < ts-ops.retain('deletion_tombstone') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('deletion_tombstone',n);
 INSERT INTO ops.retention_run(class,removed) VALUES('deletion_tombstone',n);

 DELETE FROM ops.retention_run WHERE id IN (SELECT id FROM ops.retention_run
  WHERE ran_at < ts-ops.retain('retention_run') LIMIT limit_rows);
 RETURN result;
END $$;

-- Tombstones the privacy processor cannot record itself: the anonymous purge
-- runs in the other database under its own credential.
CREATE FUNCTION ops.record_anonymous_purge(org uuid,cid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM ops.tombstone('ANONYMOUS_CAMPAIGN',org,cid);
 INSERT INTO ops.retention_run(class,removed) VALUES('anonymous_response',1);
END $$;

-- Tombstones not yet shipped to the external ledger. Campaign/object level only.
CREATE FUNCTION ops.tombstones_after(after_seq bigint,limit_rows integer DEFAULT 1000) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('seq',seq,'class',class,'organizationId',organization_id,
  'subjectId',subject_id,'recordedAt',recorded_at) ORDER BY seq),'[]'::jsonb)
 FROM (SELECT * FROM ops.deletion_tombstone WHERE seq>after_seq ORDER BY seq LIMIT limit_rows) t;
$$;

-- ---------------------------------------------------------------------------
-- 6. Operator alert inputs: campaign-level counts and ages only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ops.alert_inputs() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'restoreState',(SELECT state FROM ops.restore_state),
  'countMismatch',(SELECT count(*) FROM core.campaign c
     WHERE c.state='CLOSED' AND EXISTS(SELECT 1 FROM intake.processing_batch b WHERE b.campaign_id=c.id
       AND (b.processed_count IS NOT NULL AND b.processed_count<>b.accepted_count))),
  'blockedReleases',(SELECT count(*) FROM core.campaign WHERE release_state='BLOCKED'),
  'closedUnprocessedOverdue',(SELECT count(*) FROM core.campaign c WHERE c.state='CLOSED'
     AND coalesce(c.closed_at,c.updated_at) < clock_timestamp()-interval '24 hours'
     AND EXISTS(SELECT 1 FROM intake.submission_inbox e WHERE e.campaign_id=c.id)),
  'insufficientIntakeOverdue',(SELECT count(*) FROM core.campaign c WHERE c.state='CLOSED'
     AND coalesce(c.closed_at,c.updated_at) < clock_timestamp()-ops.retain('insufficient_intake')
     AND EXISTS(SELECT 1 FROM intake.submission_inbox e WHERE e.campaign_id=c.id)),
  'reportQueueOldestSeconds',(SELECT coalesce(extract(epoch FROM clock_timestamp()-min(created_at))::integer,0)
     FROM ops.report_job WHERE state IN ('QUEUED','RUNNING')),
  'reportFailedLastDay',(SELECT count(*) FROM ops.report_job WHERE state='FAILED' AND coalesce(completed_at,created_at)>clock_timestamp()-interval '1 day'),
  'attachmentQuarantineOldestSeconds',(SELECT coalesce(extract(epoch FROM clock_timestamp()-min(created_at))::integer,0)
     FROM core.attachment WHERE scan_status IN ('QUARANTINED','FAILED')),
  'rateLimitedLastWindow',(SELECT coalesce(sum(hits),0) FROM intake.rate_limit r WHERE window_start>clock_timestamp()-interval '10 minutes'
     AND hits>CASE bucket WHEN 'exchange_token' THEN 10 WHEN 'final_session' THEN 5 WHEN 'draft_session' THEN 30 ELSE 600 END),
  'lastRetentionRun',(SELECT max(ran_at) FROM ops.retention_run),
  'unapprovedRetentionClasses',(SELECT count(*) FROM ops.retention_policy WHERE NOT approved));
$$;

-- ---------------------------------------------------------------------------
-- Ownership, RLS and grants.
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intake.rate_limit','ops.retention_policy','ops.retention_run','ops.deletion_tombstone','ops.restore_state'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON intake.rate_limit,ops.retention_run,ops.deletion_tombstone,ops.restore_state TO orgfit_access_executor;
GRANT SELECT ON ops.retention_policy TO orgfit_access_executor;
-- The purge routine reaches tables earlier migrations granted the executor only
-- SELECT/INSERT on, or nothing at all.
GRANT SELECT,DELETE ON ops.audit_log,access.staff_session,access.oidc_flow,access.staff_mutation,
 intake.respondent_session,intake.draft_blob TO orgfit_access_executor;
GRANT SELECT,UPDATE ON ops.private_export TO orgfit_access_executor;

GRANT CREATE ON SCHEMA intake,ops TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='intake' AND p.proname='rate_hit')
    OR (n.nspname='ops' AND p.proname IN ('tombstone','tombstone_trigger','ready','set_restore_state','retain',
        'purge_core','record_anonymous_purge','tombstones_after','alert_inputs')) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA intake,ops FROM orgfit_access_executor;

-- The gateway: one more routine, still no table privilege.
GRANT EXECUTE ON FUNCTION intake.rate_hit(text,bytea,timestamptz,integer,integer) TO orgfit_gateway;
-- The respondent readiness check reads the restore gate too, so a restored
-- environment receives no respondent traffic before its tombstones are replayed.
GRANT USAGE ON SCHEMA ops TO orgfit_gateway;
GRANT EXECUTE ON FUNCTION ops.ready() TO orgfit_gateway;
-- The staff application: readiness only.
GRANT USAGE ON SCHEMA ops TO orgfit_staff;
GRANT EXECUTE ON FUNCTION ops.ready() TO orgfit_staff;
-- Operators (orgfit_migrator via orgfit_core_owner) run retention, shipping,
-- alerting and the restore replay.
GRANT EXECUTE ON FUNCTION ops.purge_core(integer),ops.record_anonymous_purge(uuid,uuid),
 ops.tombstones_after(bigint,integer),ops.alert_inputs(),ops.set_restore_state(text),ops.ready(),ops.tombstone(text,uuid,uuid)
 TO orgfit_core_owner;
