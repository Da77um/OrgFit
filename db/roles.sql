-- Run once with a cluster administrator, never from the web process.
-- Set LOGIN passwords out of band using your secret manager or psql \password.
-- Idempotent: re-running adds roles introduced by a later phase without
-- disturbing existing role attributes, memberships or passwords.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('orgfit_core_owner',      false),
  ('orgfit_access_executor', false),
  ('orgfit_migrator',        true),
  ('orgfit_staff',           true),
  ('orgfit_auth',            true),
  -- Phase 07. The respondent gateway and the privacy processor are separate
  -- deployment identities with their own credentials. Neither is a member of
  -- the other, and neither is a member of orgfit_staff.
  ('orgfit_gateway',         true),
  ('orgfit_processor',       true),
  -- Anonymous answer database. Its owner and writer exist as cluster roles but
  -- are granted CONNECT only on the anonymous database.
  ('orgfit_anon_owner',      false),
  ('orgfit_anon_migrator',   true),
  -- Phase 11. The report renderer is a fourth deployment identity. It holds no
  -- table privilege anywhere, executes only the report job routines, and must
  -- never be granted CONNECT on the anonymous database.
  ('orgfit_report',          true),
  -- Phase 12. The attachment scanner is a fifth deployment identity. It holds
  -- no table privilege anywhere, executes only the three attachment scan and
  -- retention routines, and must never be granted CONNECT on the anonymous
  -- database.
  ('orgfit_scanner',         true)
 ) AS t(name, login) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r.name) THEN
  EXECUTE format('CREATE ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
   r.name, CASE WHEN r.login THEN 'LOGIN' ELSE 'NOLOGIN' END);
 END IF;
 END LOOP;
END $$;
GRANT orgfit_core_owner TO orgfit_migrator;
GRANT orgfit_access_executor TO orgfit_core_owner;
GRANT orgfit_anon_owner TO orgfit_anon_migrator;
-- Database ownership/CONNECT grants are applied by scripts/provision.ts in tests.
-- Production operator must grant CREATE on the core DB to orgfit_core_owner,
-- revoke PUBLIC CONNECT/TEMP/CREATE, and grant CONNECT only to these logins.
-- The anonymous database must grant CONNECT to orgfit_anon_migrator and
-- orgfit_processor ONLY: no staff, auth or report credential may connect there.
-- orgfit_report and orgfit_scanner need CONNECT on the core database, and nothing else.
