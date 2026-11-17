-- ===========================================================================
-- 028: report artifacts may be kept in the core database (D-191). Forward
-- only; no earlier migration is edited.
--
-- A rendered report is already encrypted by the application under
-- REPORT_ENCRYPTION_KEY (AES-256-GCM, the object name as associated data)
-- before it is stored anywhere. Until now the ciphertext went to a private
-- bucket. A deployment without object storage may set REPORT_STORAGE=database
-- and keep the same ciphertext here instead; the bucket path is unchanged.
--
-- Nobody gains a table privilege. The renderer (orgfit_report) still holds
-- none: it stores and removes bytes through two definer routines that address
-- a job, never an organization. Staff reads bytes through one definer routine
-- that repeats every check core.report_download makes. The bytes live only as
-- long as their job: a cascade removes them with the job row, the renderer
-- removes them when a job expires, fails or is revoked, and a READY job's
-- bytes cannot be removed by the renderer at all.
-- ===========================================================================

CREATE TABLE ops.report_blob (
 job_id uuid PRIMARY KEY REFERENCES ops.report_job(id) ON DELETE CASCADE,
 organization_id uuid NOT NULL,
 bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 28 AND 52428828),
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE ops.report_blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.report_blob FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON ops.report_blob TO orgfit_access_executor USING (true) WITH CHECK (true);
CREATE POLICY migration ON ops.report_blob TO orgfit_core_owner USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON ops.report_blob TO orgfit_access_executor;

-- The renderer stores the ciphertext of the job it is rendering. Only a
-- RUNNING job accepts bytes; the organization is the job's own.
CREATE FUNCTION publication.put_report_blob(job uuid, blob bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; BEGIN
 SELECT * INTO j FROM ops.report_job WHERE id=job FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state<>'RUNNING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF blob IS NULL OR octet_length(blob)<28 OR octet_length(blob)>52428828 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO ops.report_blob(job_id,organization_id,bytes) VALUES(job,j.organization_id,blob)
 ON CONFLICT (job_id) DO UPDATE SET bytes=excluded.bytes, stored_at=clock_timestamp();
 RETURN 'db:reports/'||j.organization_id::text||'/'||job::text||'.bin';
END $$;

-- The renderer removes bytes of a job that is not READY: a failed, expired,
-- revoked or re-queued job, or the loser of a duplicated delivery. A READY
-- job's bytes are the ones staff may download and stay until it expires.
CREATE FUNCTION publication.delete_report_blob(job uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 DELETE FROM ops.report_blob b USING ops.report_job j
  WHERE b.job_id=job AND j.id=b.job_id AND j.state<>'READY';
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN n>0;
END $$;

-- Orphans: bytes whose job is not READY and that were stored more than a day
-- ago (a renderer that crashed between storing and completing).
CREATE FUNCTION publication.sweep_report_blobs(limit_rows integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 IF limit_rows<1 OR limit_rows>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 WITH gone AS (
  SELECT b.job_id FROM ops.report_blob b JOIN ops.report_job j ON j.id=b.job_id
  WHERE (j.state IN ('EXPIRED','REVOKED','FAILED','QUEUED')
         OR (j.state='READY' AND j.expires_at<=clock_timestamp()))
    AND b.stored_at<=clock_timestamp()-interval '1 hour'
  ORDER BY b.stored_at LIMIT limit_rows)
 DELETE FROM ops.report_blob b USING gone WHERE b.job_id=gone.job_id;
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN n;
END $$;

-- Staff reads the ciphertext of one READY, unexpired, still-published report of
-- an organization it may read, with the same checks as core.report_download
-- (which the download route calls first, in the same transaction, and which
-- writes the audit row).
CREATE FUNCTION core.report_blob(org uuid, job uuid) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.report_job; result bytea; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (access.has_capability('results.read') AND access.has_capability('reports.manage'))
  THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO j FROM ops.report_job WHERE id=job AND organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.state='REVOKED' THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
 IF j.state<>'READY' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF j.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM publication.result_snapshot s
   WHERE s.organization_id=org AND s.id=j.snapshot_id AND s.state='PUBLISHED')
  THEN RAISE EXCEPTION 'RESULTS_UNAVAILABLE'; END IF;
 SELECT b.bytes INTO result FROM ops.report_blob b WHERE b.job_id=job AND b.organization_id=org;
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN result;
END $$;

GRANT CREATE ON SCHEMA publication,core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='publication' AND p.proname IN ('put_report_blob','delete_report_blob','sweep_report_blobs'))
    OR (n.nspname='core' AND p.proname='report_blob')
 LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication,core FROM orgfit_access_executor;

GRANT EXECUTE ON FUNCTION publication.put_report_blob(uuid,bytea),
 publication.delete_report_blob(uuid),
 publication.sweep_report_blobs(integer) TO orgfit_report;
GRANT EXECUTE ON FUNCTION core.report_blob(uuid,uuid) TO orgfit_staff;
