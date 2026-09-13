-- ===========================================================================
-- Local password credentials and invitation-only staff activation.
--
-- SCOPE AND WHY THIS IS NARROW.
--
-- Phases 02-12 authenticate staff through OIDC only: access.issue_session
-- matches an ACTIVE (issuer, provider_subject) pair and every session it mints
-- is mfa_verified. That path is untouched here and remains the only one a
-- production installation may use.
--
-- This migration adds a SECOND, DELIBERATELY SWITCHED-OFF path so that the
-- product has an email/password sign-in and an invitation-based activation
-- screen to build and test against before P-005 supplies a real identity
-- provider. Three properties keep it from weakening the first path:
--
--   1. A kill switch that is OFF by default. access.local_access_setting is
--      created EMPTY. access.local_access_enabled() is therefore false in any
--      database this migration has merely been applied to, and while it is
--      false no password session can be issued, no invitation can be created
--      or accepted, and any password session that somehow exists authorizes
--      NOTHING, because access.actor() rejects it. Only
--      scripts/bootstrap-dev-admin.ts turns it on, and it refuses to run
--      against a non-loopback host or with NODE_ENV=production.
--   2. A password account and an OIDC account cannot be the same row. A local
--      account is stored with the reserved issuer 'urn:orgfit:local-password'
--      and a generated subject, so access.issue_session can never match it and
--      a real provider subject can never acquire a password.
--   3. A password session is recorded as what it is. staff_session gains
--      auth_method, and the mfa_verified CHECK is relaxed ONLY for
--      auth_method='PASSWORD'. A password session is honestly mfa_verified
--      false; it is not a session that claims a second factor it never saw.
--
-- An account's mfa_required flag is untouched and still always true: the
-- requirement on the account survives, and the OIDC path still enforces it.
-- ===========================================================================

-- --- the kill switch -------------------------------------------------------
-- One row at most, and this migration writes none.
CREATE TABLE access.local_access_setting (
 only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
 enabled boolean NOT NULL,
 note text NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
 enabled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION access.local_access_enabled() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM access.local_access_setting WHERE enabled)
$$;

-- --- the credential --------------------------------------------------------
-- The hash is produced and verified in the application by Node's built-in
-- scrypt (src/password.ts): N=2^15, r=8, p=1, a 16-byte random salt and a
-- 64-byte key, compared with timingSafeEqual. The database stores the encoded
-- string and never sees a password. The format CHECK refuses anything that is
-- not that encoding, so a plaintext password cannot land in this column by
-- accident. libsodium's Argon2id was the first choice and was dropped because
-- the pinned libsodium-wrappers build does not ship crypto_pwhash; adding the
-- sumo build for one routine was a larger change than this phase should make.
CREATE TABLE access.staff_password (
 staff_user_id uuid PRIMARY KEY REFERENCES access.staff_user ON DELETE CASCADE,
 password_hash text NOT NULL CHECK (password_hash LIKE '$scrypt$%' AND length(password_hash) BETWEEN 60 AND 512),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid REFERENCES access.staff_user
);

-- Failed sign-in attempts, counted against the address rather than the account,
-- so an address that does not exist is throttled identically to one that does
-- and the lockout cannot be used to enumerate accounts. Only a digest of the
-- address is stored.
CREATE TABLE access.password_attempt (
 email_digest bytea PRIMARY KEY CHECK (octet_length(email_digest)=32),
 failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
 first_failure_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 locked_until timestamptz
);
CREATE INDEX ON access.password_attempt(first_failure_at);

-- --- the invitation --------------------------------------------------------
-- Single use, expiring, bound to one address, and carrying the role and access
-- the ISSUING ADMINISTRATOR chose. Nothing the person activating the account
-- sends can change any of it. The token itself is never stored; the column is
-- the SHA-256 digest of a 256-bit secret, exactly as the respondent invitation
-- and the session token are handled elsewhere.
CREATE TABLE access.staff_invitation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
 email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
 role text NOT NULL CHECK (role IN ('SUPER_ADMIN','STAFF')),
 capabilities text[] NOT NULL DEFAULT '{}',
 organization_ids uuid[] NOT NULL DEFAULT '{}',
 locale text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid NOT NULL REFERENCES access.staff_user,
 consumed_at timestamptz,
 consumed_by uuid REFERENCES access.staff_user,
 revoked_at timestamptz,
 CHECK (consumed_at IS NULL OR consumed_by IS NOT NULL),
 CHECK (cardinality(capabilities) <= 8 AND cardinality(organization_ids) <= 100)
);
CREATE INDEX ON access.staff_invitation(email);
CREATE INDEX ON access.staff_invitation(created_by);
CREATE INDEX ON access.staff_invitation(consumed_by);
CREATE INDEX ON access.staff_invitation(expires_at);

-- --- the session record ----------------------------------------------------
ALTER TABLE access.staff_session
 ADD COLUMN auth_method text NOT NULL DEFAULT 'OIDC' CHECK (auth_method IN ('OIDC','PASSWORD'));
-- Relaxed for exactly one value, and only so the row can tell the truth.
ALTER TABLE access.staff_session DROP CONSTRAINT staff_session_mfa_verified_check;
ALTER TABLE access.staff_session
 ADD CONSTRAINT staff_session_mfa_verified_check CHECK (mfa_verified OR auth_method='PASSWORD');

-- --- audit -----------------------------------------------------------------
-- The whole list is restated, as every migration since 003 has done, because
-- these are enum-shaped CHECKs rather than a catalogue this file can append to.
-- Three actions and one field name are NEW here; everything else is carried
-- forward from 015 unchanged. 'INVITATION_REVOKED' and 'invitation' already
-- existed for the RESPONDENT invitation and are reused deliberately: a staff
-- invitation is a different row in a different table, but the audited verb is
-- the same verb and splitting it would make the log harder to read, not safer.
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED','INVITATION_CREATED','INVITATION_ACCEPTED','PASSWORD_SET'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison','report','visit','followUp','attachment','password']::text[]);

-- --- actor(): a password session authorizes nothing while the switch is off --
CREATE OR REPLACE FUNCTION access.actor() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id FROM access.staff_session s JOIN access.staff_user u ON u.id=s.staff_user_id
 WHERE s.token_digest=decode(nullif(current_setting('orgfit.session_digest',true),''),'hex')
 AND u.status='ACTIVE' AND u.auth_epoch=s.auth_epoch AND s.revoked_at IS NULL
 AND (s.mfa_verified OR (s.auth_method='PASSWORD' AND access.local_access_enabled()))
 AND s.idle_expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()
$$;

-- --- sign-in ---------------------------------------------------------------
-- Returns the stored hash for the application to verify, plus the lockout
-- state. It answers for an unknown address in the same shape as for a known
-- one, so the caller cannot tell them apart.
CREATE FUNCTION access.password_challenge(addr text, addr_digest bytea)
 RETURNS TABLE(staff_user_id uuid, password_hash text, locked boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a access.password_attempt; BEGIN
 IF NOT access.local_access_enabled() THEN
  RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN;
 END IF;
 DELETE FROM access.password_attempt WHERE first_failure_at < clock_timestamp() - interval '1 day';
 SELECT * INTO a FROM access.password_attempt WHERE email_digest=addr_digest;
 IF FOUND AND a.locked_until IS NOT NULL AND a.locked_until > clock_timestamp() THEN
  RETURN QUERY SELECT NULL::uuid, NULL::text, true; RETURN;
 END IF;
 RETURN QUERY
  SELECT p.staff_user_id, p.password_hash, false
  FROM access.staff_password p JOIN access.staff_user u ON u.id=p.staff_user_id
  WHERE u.email=lower(addr) AND u.status='ACTIVE' AND u.issuer='urn:orgfit:local-password';
END $$;

-- Five failures inside fifteen minutes locks the address for fifteen minutes.
CREATE FUNCTION access.password_failed(addr_digest bytea) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO access.password_attempt(email_digest,failures) VALUES(addr_digest,1)
 ON CONFLICT (email_digest) DO UPDATE SET
  failures = CASE WHEN access.password_attempt.first_failure_at < clock_timestamp() - interval '15 minutes'
                  THEN 1 ELSE access.password_attempt.failures + 1 END,
  first_failure_at = CASE WHEN access.password_attempt.first_failure_at < clock_timestamp() - interval '15 minutes'
                  THEN clock_timestamp() ELSE access.password_attempt.first_failure_at END;
 UPDATE access.password_attempt SET locked_until=clock_timestamp()+interval '15 minutes'
 WHERE email_digest=addr_digest AND failures>=5;
END $$;

CREATE FUNCTION access.issue_password_session(target uuid, addr_digest bytea, d bytea) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u access.staff_user; BEGIN
 IF NOT access.local_access_enabled() THEN RETURN false; END IF;
 SELECT * INTO u FROM access.staff_user
 WHERE id=target AND status='ACTIVE' AND issuer='urn:orgfit:local-password' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 DELETE FROM access.staff_session WHERE absolute_expires_at<clock_timestamp();
 DELETE FROM access.password_attempt WHERE email_digest=addr_digest;
 -- mfa_verified is false and says so. The account's own mfa_required flag is
 -- unchanged; this session simply did not satisfy it, which is why it exists
 -- only while the development switch is on.
 INSERT INTO access.staff_session(token_digest,staff_user_id,auth_epoch,mfa_verified,auth_method,idle_expires_at,absolute_expires_at)
 VALUES(d,u.id,u.auth_epoch,false,'PASSWORD',clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '12 hours');
 RETURN true;
END $$;

-- --- invitations -----------------------------------------------------------
-- Read-only inspection for the activation screen. It reveals the invited
-- address and role for a token the caller already holds, and nothing else.
CREATE FUNCTION access.inspect_invitation(d bytea) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i access.staff_invitation; BEGIN
 IF NOT access.local_access_enabled() THEN RETURN jsonb_build_object('state','INVALID'); END IF;
 SELECT * INTO i FROM access.staff_invitation WHERE token_digest=d;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','INVALID'); END IF;
 IF i.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('state','REVOKED'); END IF;
 IF i.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('state','CONSUMED'); END IF;
 IF i.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('state','EXPIRED'); END IF;
 RETURN jsonb_build_object('state','VALID','email',i.email,'role',i.role,'locale',i.locale,
  'expiresAt',to_char(i.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END $$;

-- Activation. The invitation supplies the address, the role, the capabilities
-- and the organizations; the person supplies a display name and a password and
-- nothing else. Single use is enforced by the row lock plus the consumed_at
-- test inside the same transaction, so two simultaneous activations cannot both
-- win. A session is NOT issued here: the caller signs in afterwards through the
-- same password path as everyone else.
CREATE FUNCTION access.accept_invitation(d bytea, name text, hash text, subject text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i access.staff_invitation; created uuid; BEGIN
 IF NOT access.local_access_enabled() THEN RETURN jsonb_build_object('state','INVALID'); END IF;
 SELECT * INTO i FROM access.staff_invitation WHERE token_digest=d FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','INVALID'); END IF;
 IF i.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('state','REVOKED'); END IF;
 IF i.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('state','CONSUMED'); END IF;
 IF i.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('state','EXPIRED'); END IF;
 IF EXISTS(SELECT 1 FROM access.staff_user WHERE email=i.email) THEN
  RETURN jsonb_build_object('state','ALREADY_REGISTERED');
 END IF;
 INSERT INTO access.staff_user(issuer,provider_subject,email,display_name,role,status,locale,created_by,updated_by)
 VALUES('urn:orgfit:local-password',subject,i.email,name,i.role,'ACTIVE',i.locale,i.created_by,i.created_by)
 RETURNING id INTO created;
 INSERT INTO access.staff_capability SELECT created, c FROM unnest(i.capabilities) c;
 INSERT INTO access.organization_access SELECT created, o FROM unnest(i.organization_ids) o;
 INSERT INTO access.staff_password(staff_user_id,password_hash,updated_by) VALUES(created,hash,created);
 UPDATE access.staff_invitation SET consumed_at=clock_timestamp(), consumed_by=created WHERE id=i.id;
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names)
 VALUES(created,'INVITATION_ACCEPTED',created,ARRAY['invitation','role','capabilities','organizationIds']);
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names)
 VALUES(created,'PASSWORD_SET',created,ARRAY['password']);
 RETURN jsonb_build_object('state','ACTIVATED','email',i.email);
END $$;

-- Issuing an invitation is a Super Admin action through an authenticated
-- session, guarded by the same advisory lock the rest of staff administration
-- serializes on. It sends nothing: the caller is handed the activation URL once
-- and is responsible for delivering it out of band.
CREATE FUNCTION access.create_invitation(d bytea, body jsonb, idem uuid, req_hash bytea) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); old access.staff_mutation; created uuid; BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT access.local_access_enabled() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM pg_advisory_xact_lock(80202);
 SELECT * INTO old FROM access.staff_mutation WHERE staff_user_id=actor AND operation='create_invitation' AND idempotency_key=idem;
 IF FOUND THEN
  IF old.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  RETURN old.resource_id;
 END IF;
 IF body - ARRAY['email','role','capabilities','organizationIds','locale','expiresInHours'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF EXISTS(SELECT 1 FROM access.staff_user WHERE email=lower(body->>'email')) THEN
  RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 INSERT INTO access.staff_invitation(token_digest,email,role,capabilities,organization_ids,locale,expires_at,created_by)
 VALUES(d,lower(body->>'email'),body->>'role',
  ARRAY(SELECT jsonb_array_elements_text(body->'capabilities')),
  ARRAY(SELECT (jsonb_array_elements_text(body->'organizationIds'))::uuid),
  coalesce(body->>'locale','ar'),
  clock_timestamp() + ((body->>'expiresInHours')::int * interval '1 hour'),
  actor)
 RETURNING id INTO created;
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names)
 VALUES(actor,'INVITATION_CREATED',created,ARRAY['invitation','role','capabilities','organizationIds']);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,'create_invitation',idem,req_hash,created);
 RETURN created;
END $$;

CREATE FUNCTION access.list_invitations() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(x),'[]') FROM (
  SELECT id, email, role, expires_at AS "expiresAt", consumed_at AS "consumedAt", revoked_at AS "revokedAt"
  FROM access.staff_invitation ORDER BY created_at DESC LIMIT 100) x);
END $$;

CREATE FUNCTION access.revoke_invitation(target uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 UPDATE access.staff_invitation SET revoked_at=clock_timestamp()
 WHERE id=target AND consumed_at IS NULL AND revoked_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names)
 VALUES(actor,'INVITATION_REVOKED',target,ARRAY['invitation']);
END $$;

-- --- ownership, RLS and grants ---------------------------------------------
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='access'
   AND tablename IN ('local_access_setting','staff_password','password_attempt','staff_invitation') LOOP
  EXECUTE format('ALTER TABLE access.%I ENABLE ROW LEVEL SECURITY',t.tablename);
  EXECUTE format('ALTER TABLE access.%I FORCE ROW LEVEL SECURITY',t.tablename);
  EXECUTE format('CREATE POLICY executor ON access.%I TO orgfit_access_executor USING (true) WITH CHECK (true)',t.tablename);
  EXECUTE format('CREATE POLICY migration ON access.%I TO orgfit_core_owner USING (true) WITH CHECK (true)',t.tablename);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON access.local_access_setting,access.staff_password,access.password_attempt,access.staff_invitation TO orgfit_access_executor;

GRANT CREATE ON SCHEMA access TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='access' AND p.proname IN ('local_access_enabled','password_challenge','password_failed',
   'issue_password_session','inspect_invitation','accept_invitation','create_invitation','list_invitations',
   'revoke_invitation','actor') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA access FROM orgfit_access_executor;

-- The pre-session routines belong to orgfit_auth, exactly like the OIDC flow.
-- orgfit_staff gets only the administered ones, and never the challenge.
GRANT EXECUTE ON FUNCTION access.password_challenge(text,bytea),access.password_failed(bytea),
 access.issue_password_session(uuid,bytea,bytea),access.inspect_invitation(bytea),
 access.accept_invitation(bytea,text,text,text),access.local_access_enabled() TO orgfit_auth;
GRANT EXECUTE ON FUNCTION access.actor(),access.local_access_enabled() TO orgfit_staff;
GRANT EXECUTE ON FUNCTION access.create_invitation(bytea,jsonb,uuid,bytea),
 access.list_invitations(),access.revoke_invitation(uuid) TO orgfit_staff;
