-- ===========================================================================
-- 030: participation export files (named lists of who was invited) may be kept in the core
-- database (D-194). Forward only; no earlier migration is edited.
--
-- An export file is already encrypted by the application under
-- PARTICIPATION_EXPORT_ENCRYPTION_KEY (AES-256-GCM, the object name as associated data)
-- before it is stored. Until now the ciphertext went to a private bucket, or a
-- local directory that production refuses, so a deployment without object
-- storage answered every export with 503. With PARTICIPATION_EXPORT_STORAGE=database the
-- same ciphertext is kept here; the bucket path is unchanged.
--
-- Staff gains no table privilege: it stores and reads through two definer
-- routines that check the session, the organization and participation.export,
-- exactly as the export routes do. A file lives one day, as the bucket
-- lifecycle rule and the local janitor already allow: every store sweeps
-- older files, and an organization's files go with the organization.
-- ===========================================================================

CREATE TABLE ops.participation_blob (
 organization_id uuid NOT NULL REFERENCES core.organization(id) ON DELETE CASCADE,
 export_id uuid NOT NULL,
 bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 28 AND 4194332),
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id, export_id)
);
ALTER TABLE ops.participation_blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.participation_blob FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON ops.participation_blob TO orgfit_access_executor USING (true) WITH CHECK (true);
CREATE POLICY migration ON ops.participation_blob TO orgfit_core_owner USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON ops.participation_blob TO orgfit_access_executor;

CREATE FUNCTION core.put_participation_blob(org uuid, export uuid, blob bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('participation.export') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF blob IS NULL OR octet_length(blob)<28 OR octet_length(blob)>4194332 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 DELETE FROM ops.participation_blob WHERE stored_at<=clock_timestamp()-interval '1 day';
 INSERT INTO ops.participation_blob(organization_id,export_id,bytes) VALUES(org,export,blob)
 ON CONFLICT (organization_id,export_id) DO UPDATE SET bytes=excluded.bytes, stored_at=clock_timestamp();
END $$;

CREATE FUNCTION core.participation_blob(org uuid, export uuid) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result bytea; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('participation.export') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT b.bytes INTO result FROM ops.participation_blob b
  WHERE b.organization_id=org AND b.export_id=export AND b.stored_at>clock_timestamp()-interval '1 day';
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN result;
END $$;

GRANT CREATE ON SCHEMA core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='core' AND p.proname IN ('put_participation_blob','participation_blob')
 LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA core FROM orgfit_access_executor;

GRANT EXECUTE ON FUNCTION core.put_participation_blob(uuid,uuid,bytea), core.participation_blob(uuid,uuid) TO orgfit_staff;
