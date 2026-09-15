-- ===========================================================================
-- Post-Audit Repair Pass 4: production-security adapters.
--
--   1. Attachment scan provenance. A verdict now records WHICH engine produced
--      it (and the engine's signature version when it reports one), so a CLEAN
--      file checked only by the development heuristic can always be told apart
--      from one checked by a maintained malware engine. An engine outage
--      releases its claim without spending the attempt budget.
--   2. Staff-side application rate limits for the pre-session endpoints and
--      the signed-in API (SEC-M1), counted like the public gateway's (017).
--   3. A narrowly authorized, audited whole-campaign intake erasure for an
--      approved restore incident (SEC-M6).
--   4. Tombstone delivery evidence and a sequence repair for restores (SEC-M3,
--      PR4-001): the external ledger's last shipped position is recorded in the
--      database, and a restored database's tombstone sequence can be advanced
--      past what the ledger already holds.
--
-- Nothing here reads, stores or reports an answer, a draft, a token, an IP
-- address or a participant. Released migrations are not edited.
-- ===========================================================================

-- --- vocabulary --------------------------------------------------------------
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED','INVITATION_CREATED','INVITATION_ACCEPTED','PASSWORD_SET','SETTINGS_CHANGED','AUDIT_EXPORTED','RELEASE_REVOKED','INTAKE_ERASED'));

-- ===========================================================================
-- 1. Attachment scan provenance
-- ===========================================================================
ALTER TABLE core.attachment
 ADD COLUMN scan_engine text CHECK(scan_engine ~ '^[a-z][a-z0-9-]{1,39}$'),
 ADD COLUMN scan_engine_version text CHECK(scan_engine_version ~ '^[ -~]{1,200}$');
-- Rows scanned before this migration were checked by the bundled content
-- verifier and its EICAR marker only. They are labelled as such rather than
-- left looking like an engine verdict.
-- (CLEAN→CLEAN and REJECTED→REJECTED are permitted by the 015 lifecycle
-- trigger when type, size and checksum are unchanged.) Expired rows keep NULL:
-- their bytes are gone and nothing about them is downloadable.
UPDATE core.attachment SET scan_engine='development-heuristic'
 WHERE scan_status IN ('CLEAN','REJECTED') AND scan_engine IS NULL;
ALTER TABLE core.attachment ADD CONSTRAINT attachment_clean_engine
 CHECK(scan_status<>'CLEAN' OR scan_engine IS NOT NULL);

-- The scanner's verdict routine. The provenance is written while the row is
-- still QUARANTINED, then the unchanged 015 routine records the verdict (and
-- its audit row) exactly as before. A CLEAN verdict without an engine name is
-- refused. An engine that could not give a verdict is not a verdict at all:
-- the caller uses release_scan_claim instead.
CREATE FUNCTION core.record_scan_result(att uuid,verdict text,verified_type text,code text,
 ttl interval,engine text,engine_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core.attachment; BEGIN
 IF verdict NOT IN ('CLEAN','REJECTED','FAILED') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF engine IS NOT NULL AND engine !~ '^[a-z][a-z0-9-]{1,39}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF engine_version IS NOT NULL AND engine_version !~ '^[ -~]{1,200}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF verdict='CLEAN' AND engine IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO a FROM core.attachment WHERE id=att FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF a.scan_status<>'QUARANTINED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF verdict IN ('CLEAN','REJECTED') THEN
  UPDATE core.attachment SET scan_engine=engine,scan_engine_version=engine_version WHERE id=att;
 END IF;
 RETURN core.record_scan(att,verdict,verified_type,code,ttl);
END $$;

-- An engine outage (unreachable, refused the connection) says nothing about
-- the file, so it must not spend the file's three attempts: a long outage
-- would otherwise turn every waiting upload into FAILED, which the retention
-- job deletes after a day. The claim is undone and the file stays QUARANTINED.
-- A timeout or an indeterminate answer about THIS file is different and does
-- spend an attempt (record_scan_result with FAILED).
CREATE FUNCTION core.release_scan_claim(att uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core.attachment; BEGIN
 SELECT * INTO a FROM core.attachment WHERE id=att FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF a.scan_status<>'QUARANTINED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE core.attachment SET scan_attempt=greatest(a.scan_attempt-1,0) WHERE id=att;
 RETURN jsonb_build_object('id',att,'scanStatus','QUARANTINED','attempt',greatest(a.scan_attempt-1,0));
END $$;

-- ===========================================================================
-- 2. Staff-side rate limits (SEC-M1)
--
-- The same fixed-window, HMAC-keyed design as intake.rate_limit (017): the
-- staff process computes the key over the bucket, the window start and the
-- client material (a trusted-proxy address bucket, or a session digest), so a
-- row can be joined neither across windows nor to a person. `denied` counts
-- the requests refused in the window, which is what the operator alert reads.
-- ===========================================================================
CREATE TABLE access.staff_rate_limit (
 bucket text NOT NULL CHECK(bucket IN ('auth_start_ip','auth_callback_ip','password_ip','invitation_ip','activate_ip','api_session')),
 key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32),
 window_start timestamptz NOT NULL,
 hits integer NOT NULL CHECK(hits>=1),
 denied integer NOT NULL DEFAULT 0 CHECK(denied>=0),
 PRIMARY KEY(bucket,key_digest,window_start)
);
CREATE INDEX ON access.staff_rate_limit(window_start);

CREATE FUNCTION access.staff_rate_hit(bucket_in text,key_in bytea,window_start_in timestamptz,
 max_hits integer,window_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; ts timestamptz:=clock_timestamp(); BEGIN
 IF bucket_in NOT IN ('auth_start_ip','auth_callback_ip','password_ip','invitation_ip','activate_ip','api_session')
  OR key_in IS NULL OR octet_length(key_in)<>32
  OR max_hits<1 OR max_hits>100000 OR window_seconds<1 OR window_seconds>3600
  OR window_start_in>ts+interval '5 seconds' OR window_start_in<ts-make_interval(secs=>window_seconds*2)
 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO access.staff_rate_limit AS r(bucket,key_digest,window_start,hits) VALUES(bucket_in,key_in,window_start_in,1)
 ON CONFLICT(bucket,key_digest,window_start) DO UPDATE SET hits=r.hits+1,
  denied=r.denied+CASE WHEN r.hits+1>max_hits THEN 1 ELSE 0 END
 RETURNING hits INTO n;
 RETURN jsonb_build_object('allowed',n<=max_hits,
  'retryAfter',greatest(1,ceil(extract(epoch FROM window_start_in+make_interval(secs=>window_seconds)-ts))::integer));
END $$;

-- Retention for the staff counters, on the same policy class as the gateway's.
CREATE FUNCTION ops.purge_staff_rate_limit(limit_rows integer DEFAULT 5000) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 IF limit_rows<1 OR limit_rows>100000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 DELETE FROM access.staff_rate_limit WHERE ctid IN (SELECT ctid FROM access.staff_rate_limit
  WHERE window_start < clock_timestamp()-ops.retain('rate_limit_window') LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO ops.retention_run(class,removed) VALUES('rate_limit_window',n);
 RETURN n;
END $$;

-- ===========================================================================
-- 3. Whole-campaign intake erasure for an approved restore incident (SEC-M6)
--
-- The restore replay (scripts/restore-reapply.ts) keeps encrypted envelopes
-- and the environment closed when the ledger says a campaign's intake was
-- erased but the restored anonymous store lacks its output
-- (ANONYMOUS_OUTPUT_MISSING_FOR_ERASED_INTAKE). Those accepted answers are
-- then unrecoverable; if the owner decides to erase what the restore brought
-- back rather than attempt another recovery, this is the only supported way.
--
-- It refuses unless: the environment is still closed for a restore
-- (REAPPLY_PENDING), the campaign is CLOSED, an active Super Admin is named as
-- approver, an incident reference and a written reason are given, and the
-- caller states the exact number of envelopes it expects to erase. It deletes
-- the campaign's envelopes, drafts and respondent sessions only — never an
-- invitation, a participant, a batch record or anything anonymous — writes an
-- immutable erasure record and an INTAKE_ERASED audit row, and (re)records the
-- CAMPAIGN_INTAKE tombstone so a later restore erases it again. Whether the
-- ledger actually reports the incident for this campaign is checked by the
-- operator command before it calls this routine.
-- ===========================================================================
CREATE TABLE ops.intake_erasure (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL,
 incident_reference text NOT NULL CHECK(length(trim(incident_reference)) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 2000),
 approved_by uuid NOT NULL REFERENCES access.staff_user,
 envelopes_erased integer NOT NULL CHECK(envelopes_erased>=0),
 drafts_erased integer NOT NULL CHECK(drafts_erased>=0),
 sessions_erased integer NOT NULL CHECK(sessions_erased>=0),
 erased_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,campaign_id,incident_reference),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id)
);
CREATE INDEX ON ops.intake_erasure(approved_by);
CREATE FUNCTION ops.intake_erasure_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'INTAKE_ERASURE_IMMUTABLE'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ops.intake_erasure
 FOR EACH ROW EXECUTE FUNCTION ops.intake_erasure_immutable();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ops.intake_erasure
 FOR EACH STATEMENT EXECUTE FUNCTION ops.intake_erasure_immutable();

CREATE FUNCTION ops.erase_campaign_intake(org uuid,cid uuid,approver_email text,reference text,
 why text,expected_envelopes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE approver uuid; c core.campaign; existing ops.intake_erasure; env_n integer; draft_n integer;
 session_n integer; rid uuid; BEGIN
 IF reference IS NULL OR length(trim(reference)) NOT BETWEEN 1 AND 200
  OR why IS NULL OR length(trim(why)) NOT BETWEEN 10 AND 2000
  OR expected_envelopes IS NULL OR expected_envelopes<0
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT id INTO approver FROM access.staff_user
  WHERE lower(email)=lower(approver_email) AND role='SUPER_ADMIN' AND status='ACTIVE';
 IF approver IS NULL THEN RAISE EXCEPTION 'APPROVER_REQUIRED'; END IF;
 SELECT * INTO c FROM core.campaign WHERE organization_id=org AND id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- The same decision again (a retried command) returns the one record.
 SELECT * INTO existing FROM ops.intake_erasure
  WHERE organization_id=org AND campaign_id=cid AND incident_reference=trim(reference);
 IF FOUND THEN
  RETURN jsonb_build_object('id',existing.id,'campaignId',cid,'replayed',true,
   'envelopesErased',existing.envelopes_erased,'draftsErased',existing.drafts_erased,
   'sessionsErased',existing.sessions_erased);
 END IF;
 IF (SELECT state FROM ops.restore_state)<>'REAPPLY_PENDING' THEN RAISE EXCEPTION 'RESTORE_INCIDENT_REQUIRED'; END IF;
 IF c.state<>'CLOSED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- A batch being processed right now is not a restore leftover.
 IF EXISTS(SELECT 1 FROM intake.processing_batch WHERE campaign_id=cid AND state='PROCESSING'
            AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT count(*)::int INTO env_n FROM intake.submission_inbox WHERE campaign_id=cid;
 IF env_n<>expected_envelopes THEN RAISE EXCEPTION 'CONFIRMATION_MISMATCH'; END IF;
 DELETE FROM intake.submission_inbox WHERE campaign_id=cid;
 DELETE FROM intake.draft_blob WHERE campaign_id=cid;
 GET DIAGNOSTICS draft_n=ROW_COUNT;
 DELETE FROM intake.respondent_session WHERE campaign_id=cid;
 GET DIAGNOSTICS session_n=ROW_COUNT;
 rid:=gen_random_uuid();
 INSERT INTO ops.intake_erasure(id,organization_id,campaign_id,incident_reference,reason,approved_by,
  envelopes_erased,drafts_erased,sessions_erased)
 VALUES(rid,org,cid,trim(reference),why,approver,env_n,draft_n,session_n);
 -- Preserved if the ledger replay already recreated it; recreated otherwise.
 PERFORM ops.tombstone('CAMPAIGN_INTAKE',org,cid);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(approver,org,'INTAKE_ERASED',cid,ARRAY['campaign']);
 RETURN jsonb_build_object('id',rid,'campaignId',cid,'replayed',false,
  'envelopesErased',env_n,'draftsErased',draft_n,'sessionsErased',session_n);
END $$;

-- ===========================================================================
-- 4. Tombstone delivery evidence and the restore sequence repair
-- ===========================================================================
-- One row per successful shipment: how far the external ledger is known to
-- reach, through which kind of sink, and when. Positions and counts only.
CREATE TABLE ops.tombstone_shipment (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shipped_through bigint NOT NULL CHECK(shipped_through>=0),
 sink text NOT NULL CHECK(sink IN ('local-file','s3')),
 shipped integer NOT NULL CHECK(shipped>=0),
 shipped_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON ops.tombstone_shipment(shipped_at);

CREATE FUNCTION ops.record_tombstone_shipment(through bigint,sink_in text,shipped_in integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF through IS NULL OR through<0 OR shipped_in IS NULL OR shipped_in<0 OR sink_in NOT IN ('local-file','s3')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO ops.tombstone_shipment(shipped_through,sink,shipped) VALUES(through,sink_in,shipped_in);
 DELETE FROM ops.tombstone_shipment WHERE shipped_at<clock_timestamp()-ops.retain('retention_run');
END $$;

-- What the operator alert needs: the newest tombstone, the furthest shipped
-- position, and the age of the oldest tombstone not yet known to be shipped.
CREATE FUNCTION ops.tombstone_delivery_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH shipped AS (SELECT coalesce(max(shipped_through),0) AS through, max(shipped_at) AS last_at FROM ops.tombstone_shipment)
 SELECT jsonb_build_object(
  'maxSeq',(SELECT coalesce(max(seq),0) FROM ops.deletion_tombstone),
  'shippedThrough',(SELECT through FROM shipped),
  'lastShippedAt',(SELECT last_at FROM shipped),
  'unshipped',(SELECT count(*) FROM ops.deletion_tombstone WHERE seq>(SELECT through FROM shipped)),
  'oldestUnshippedSeconds',(SELECT coalesce(extract(epoch FROM clock_timestamp()-min(recorded_at))::integer,0)
     FROM ops.deletion_tombstone WHERE seq>(SELECT through FROM shipped)));
$$;

-- PR4-001. A restored database's tombstone identity is back at the backup's
-- value while the external ledger already holds higher sequence numbers. New
-- tombstones would reuse those numbers and sit behind the shipping cursor,
-- never shipped. The replay advances the sequence past the ledger first.
CREATE FUNCTION ops.advance_tombstone_sequence(at_least bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s regclass:=pg_get_serial_sequence('ops.deletion_tombstone','seq')::regclass; target bigint; BEGIN
 IF at_least IS NULL OR at_least<0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 -- Never moves the sequence backwards: the larger of the ledger's position,
 -- the table's largest row and the sequence's own last value.
 target:=greatest(at_least,(SELECT coalesce(max(seq),0) FROM ops.deletion_tombstone),
  coalesce(pg_sequence_last_value(s),0));
 IF target=0 THEN RETURN 0; END IF;
 RETURN setval(s,target,true);
END $$;

-- Staff-side abuse signal for ops:check: refused staff requests in the last ten
-- minutes, by bucket kind. Counts only.
CREATE FUNCTION ops.staff_rate_limited_recent() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'preSession',(SELECT coalesce(sum(denied),0) FROM access.staff_rate_limit
     WHERE bucket<>'api_session' AND window_start>clock_timestamp()-interval '10 minutes'),
  'api',(SELECT coalesce(sum(denied),0) FROM access.staff_rate_limit
     WHERE bucket='api_session' AND window_start>clock_timestamp()-interval '10 minutes'));
$$;

-- ===========================================================================
-- Ownership, row security and grants
-- ===========================================================================
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['access.staff_rate_limit','ops.intake_erasure','ops.tombstone_shipment'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON access.staff_rate_limit TO orgfit_access_executor;
GRANT SELECT,INSERT ON ops.intake_erasure TO orgfit_access_executor;
GRANT SELECT,INSERT,DELETE ON ops.tombstone_shipment TO orgfit_access_executor;
GRANT SELECT,DELETE ON intake.submission_inbox,intake.draft_blob,intake.respondent_session TO orgfit_access_executor;
GRANT SELECT,UPDATE ON SEQUENCE ops.deletion_tombstone_seq_seq TO orgfit_access_executor;

GRANT CREATE ON SCHEMA core,access,ops TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE (n.nspname='core' AND p.proname IN ('record_scan_result','release_scan_claim'))
     OR (n.nspname='access' AND p.proname='staff_rate_hit')
     OR (n.nspname='ops' AND p.proname IN ('purge_staff_rate_limit','intake_erasure_immutable','erase_campaign_intake',
        'record_tombstone_shipment','tombstone_delivery_status','advance_tombstone_sequence',
        'staff_rate_limited_recent')) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA core,access,ops FROM orgfit_access_executor;

-- The scanner: the provenance-recording routine replaces record_scan, so a
-- verdict without an engine name can no longer be written by the scanner.
REVOKE EXECUTE ON FUNCTION core.record_scan(uuid,text,text,text,interval) FROM orgfit_scanner;
GRANT EXECUTE ON FUNCTION core.record_scan_result(uuid,text,text,text,interval,text,text),
 core.release_scan_claim(uuid) TO orgfit_scanner;
-- The staff process's pre-session credential counts staff requests.
GRANT EXECUTE ON FUNCTION access.staff_rate_hit(text,bytea,timestamptz,integer,integer) TO orgfit_auth;
-- Operators.
GRANT EXECUTE ON FUNCTION ops.purge_staff_rate_limit(integer),
 ops.erase_campaign_intake(uuid,uuid,text,text,text,integer),
 ops.record_tombstone_shipment(bigint,text,integer),ops.tombstone_delivery_status(),
 ops.advance_tombstone_sequence(bigint),ops.staff_rate_limited_recent() TO orgfit_core_owner;
