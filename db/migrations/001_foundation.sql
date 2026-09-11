CREATE SCHEMA access;
CREATE SCHEMA core;
CREATE SCHEMA ops;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE access.staff_user (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
 provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 500),
 email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
 display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 500),
 role text NOT NULL CHECK (role IN ('SUPER_ADMIN','STAFF')),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
 locale text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','en')),
 mfa_required boolean NOT NULL DEFAULT true CHECK (mfa_required),
 auth_epoch bigint NOT NULL DEFAULT 1 CHECK (auth_epoch > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE (issuer,provider_subject)
);
CREATE INDEX ON access.staff_user(status);
CREATE INDEX ON access.staff_user(created_by);
CREATE INDEX ON access.staff_user(updated_by);
CREATE TABLE core.organization (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL UNIQUE CHECK (code = upper(code) AND length(trim(code)) BETWEEN 1 AND 80),
 name_ar text NOT NULL CHECK (length(trim(name_ar)) BETWEEN 1 AND 500),
 name_en text CHECK (length(name_en) <= 500), industry text CHECK (length(industry) <= 500),
 contact jsonb NOT NULL DEFAULT '{"schemaVersion":1}' CHECK (jsonb_typeof(contact)='object' AND octet_length(contact::text)<=4096),
 timezone text NOT NULL DEFAULT 'Asia/Riyadh', notes text CHECK (length(notes)<=5000),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user
);
CREATE INDEX ON core.organization(status,name_ar,id);
CREATE INDEX ON core.organization(created_by);
CREATE INDEX ON core.organization(updated_by);
CREATE TABLE access.staff_capability (
 staff_user_id uuid NOT NULL REFERENCES access.staff_user,
 capability text NOT NULL CHECK (capability IN ('directory.manage','instruments.manage','campaigns.manage','participation.read','participation.export','results.read','reports.manage','visits.manage')),
 PRIMARY KEY(staff_user_id,capability)
);
CREATE TABLE access.organization_access (
 staff_user_id uuid NOT NULL REFERENCES access.staff_user,
 organization_id uuid NOT NULL REFERENCES core.organization,
 PRIMARY KEY(staff_user_id,organization_id)
);
CREATE INDEX ON access.organization_access(organization_id);
CREATE TABLE access.staff_session (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_digest bytea NOT NULL UNIQUE CHECK(octet_length(token_digest)=32),
 staff_user_id uuid NOT NULL REFERENCES access.staff_user, auth_epoch bigint NOT NULL,
 mfa_verified boolean NOT NULL CHECK(mfa_verified),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 idle_expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(idle_expires_at<=absolute_expires_at)
);
CREATE INDEX ON access.staff_session(staff_user_id);
CREATE INDEX ON access.staff_session(absolute_expires_at);
CREATE TABLE access.oidc_flow (
 digest bytea PRIMARY KEY CHECK(octet_length(digest)=32),
 state text NOT NULL, nonce text NOT NULL, verifier text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX ON access.oidc_flow(expires_at);
CREATE TABLE ops.audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES access.staff_user,
 organization_id uuid REFERENCES core.organization,
 action text NOT NULL CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP')),
 target_id uuid NOT NULL, field_names text[] NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership']::text[])
);
CREATE INDEX ON ops.audit_log(actor_id);
CREATE INDEX ON ops.audit_log(organization_id,occurred_at);
CREATE TABLE access.staff_mutation (
 staff_user_id uuid NOT NULL REFERENCES access.staff_user,
 operation text NOT NULL, idempotency_key uuid NOT NULL, request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
 resource_id uuid NOT NULL, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 PRIMARY KEY(staff_user_id,operation,idempotency_key)
);
CREATE INDEX ON access.staff_mutation(expires_at);

GRANT USAGE ON SCHEMA access,core,ops TO orgfit_access_executor,orgfit_staff;
GRANT USAGE ON SCHEMA access TO orgfit_auth;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA access TO orgfit_access_executor;
GRANT SELECT ON core.organization TO orgfit_access_executor;
GRANT SELECT,INSERT ON ops.audit_log TO orgfit_access_executor;
GRANT SELECT ON core.organization TO orgfit_staff;

-- All tables use FORCE RLS. Only narrow, fixed-search-path routines may use
-- the executor role. Runtime roles have no membership in either NOLOGIN role.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('access','core','ops') LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.schemaname,t.tablename);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',t.schemaname,t.tablename);
  EXECUTE format('CREATE POLICY executor ON %I.%I TO orgfit_access_executor USING (true) WITH CHECK (true)',t.schemaname,t.tablename);
  EXECUTE format('CREATE POLICY migration ON %I.%I TO orgfit_core_owner USING (true) WITH CHECK (true)',t.schemaname,t.tablename);
 END LOOP;
END $$;

CREATE FUNCTION access.actor() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id FROM access.staff_session s JOIN access.staff_user u ON u.id=s.staff_user_id
 WHERE s.token_digest=decode(nullif(current_setting('orgfit.session_digest',true),''),'hex')
 AND u.status='ACTIVE' AND u.auth_epoch=s.auth_epoch AND s.mfa_verified AND s.revoked_at IS NULL
 AND s.idle_expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()
$$;
CREATE FUNCTION access.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM access.staff_user WHERE id=access.actor() AND role='SUPER_ADMIN')
$$;
CREATE FUNCTION access.has_org(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT access.actor() IS NOT NULL AND (access.is_admin() OR EXISTS(SELECT 1 FROM access.organization_access WHERE staff_user_id=access.actor() AND organization_id=org))
$$;
CREATE FUNCTION access.has_capability(cap text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT access.actor() IS NOT NULL AND (access.is_admin() OR EXISTS(SELECT 1 FROM access.staff_capability WHERE staff_user_id=access.actor() AND capability=cap))
$$;
CREATE POLICY staff_read ON core.organization TO orgfit_staff USING(access.has_org(id));

CREATE FUNCTION access.profile() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); result jsonb; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED' USING ERRCODE='P0001'; END IF;
 UPDATE access.staff_session SET last_seen_at=clock_timestamp(),idle_expires_at=least(absolute_expires_at,clock_timestamp()+interval '30 minutes')
 WHERE token_digest=decode(current_setting('orgfit.session_digest'),'hex');
 SELECT jsonb_build_object('id',u.id,'displayName',u.display_name,'email',u.email,'role',u.role,'locale',u.locale,'revision',u.revision,
 'capabilities',coalesce((SELECT jsonb_agg(capability ORDER BY capability) FROM access.staff_capability WHERE staff_user_id=u.id),'[]'),
 'organizationIds',coalesce((SELECT jsonb_agg(organization_id ORDER BY organization_id) FROM access.organization_access WHERE staff_user_id=u.id),'[]')) INTO result
 FROM access.staff_user u WHERE u.id=actor;
 RETURN result;
END $$;
CREATE FUNCTION access.set_locale(loc text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 UPDATE access.staff_user SET locale=loc,revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=actor;
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES(actor,'PROFILE_UPDATED',actor,ARRAY['locale']);
END $$;
CREATE FUNCTION access.logout() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 UPDATE access.staff_session SET revoked_at=clock_timestamp() WHERE token_digest=decode(current_setting('orgfit.session_digest'),'hex');
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES(actor,'LOGOUT',actor,ARRAY['authEpoch']);
END $$;
CREATE FUNCTION access.list_staff() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(x),'[]') FROM (SELECT id,email,display_name AS "displayName",role,status,locale,revision FROM access.staff_user ORDER BY id LIMIT 100) x);
END $$;
CREATE FUNCTION access.audit() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(x),'[]') FROM (SELECT id,actor_id,organization_id,action,target_id,field_names,occurred_at FROM ops.audit_log ORDER BY occurred_at DESC,id LIMIT 100) x);
END $$;
CREATE FUNCTION access.save_staff(target uuid, expected bigint, body jsonb, idem uuid, req_hash bytea) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); old access.staff_mutation; s access.staff_user; result uuid; BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 -- Serialize access administration including last-admin checks and retry receipts.
 PERFORM pg_advisory_xact_lock(80202);
 SELECT * INTO old FROM access.staff_mutation WHERE staff_user_id=actor AND operation='save_staff' AND idempotency_key=idem;
 IF FOUND THEN
  IF old.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  RETURN old.resource_id;
 END IF;
 IF body - ARRAY['issuer','subject','email','displayName','role','status','capabilities','organizationIds'] <> '{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF jsonb_typeof(body->'capabilities')<>'array' OR jsonb_typeof(body->'organizationIds')<>'array' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF target IS NULL THEN
  INSERT INTO access.staff_user(issuer,provider_subject,email,display_name,role,status,created_by,updated_by)
  VALUES(body->>'issuer',body->>'subject',lower(body->>'email'),body->>'displayName',body->>'role',coalesce(body->>'status','ACTIVE'),actor,actor) RETURNING id INTO result;
 ELSE
  SELECT * INTO s FROM access.staff_user WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF s.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  IF s.role='SUPER_ADMIN' AND s.status='ACTIVE' AND (body->>'role'<>'SUPER_ADMIN' OR body->>'status'<>'ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM access.staff_user WHERE id<>target AND role='SUPER_ADMIN' AND status='ACTIVE') THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
  UPDATE access.staff_user SET role=body->>'role',status=body->>'status',auth_epoch=auth_epoch+1,revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=target;
  UPDATE access.staff_session SET revoked_at=clock_timestamp() WHERE staff_user_id=target AND revoked_at IS NULL;
  result:=target;
  DELETE FROM access.staff_capability WHERE staff_user_id=result;
  DELETE FROM access.organization_access WHERE staff_user_id=result;
 END IF;
 INSERT INTO access.staff_capability SELECT result,value FROM jsonb_array_elements_text(body->'capabilities');
 INSERT INTO access.organization_access SELECT result,value::uuid FROM jsonb_array_elements_text(body->'organizationIds');
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES(actor,CASE WHEN target IS NULL THEN 'STAFF_CREATED' ELSE 'ACCESS_CHANGED' END,result,ARRAY['role','status','capabilities','organizationIds']);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,'save_staff',idem,req_hash,result);
 RETURN result;
END $$;
CREATE FUNCTION access.revoke_sessions(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 UPDATE access.staff_user SET auth_epoch=auth_epoch+1,revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 UPDATE access.staff_session SET revoked_at=clock_timestamp() WHERE staff_user_id=target AND revoked_at IS NULL;
 INSERT INTO ops.audit_log(actor_id,action,target_id,field_names) VALUES(actor,'SESSIONS_REVOKED',target,ARRAY['authEpoch']);
END $$;
CREATE FUNCTION access.begin_oidc(d bytea, st text, n text, v text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 DELETE FROM access.oidc_flow WHERE expires_at<clock_timestamp();
 INSERT INTO access.oidc_flow(digest,state,nonce,verifier) VALUES(d,st,n,v);
END $$;
CREATE FUNCTION access.consume_oidc(d bytea) RETURNS TABLE(state text,nonce text,verifier text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DELETE FROM access.oidc_flow WHERE digest=d AND expires_at>clock_timestamp() RETURNING state,nonce,verifier
$$;
CREATE FUNCTION access.issue_session(iss text, sub text, d bytea) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u access.staff_user; BEGIN
 SELECT * INTO u FROM access.staff_user WHERE issuer=iss AND provider_subject=sub AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 DELETE FROM access.staff_session WHERE absolute_expires_at<clock_timestamp();
 INSERT INTO access.staff_session(token_digest,staff_user_id,auth_epoch,mfa_verified,idle_expires_at,absolute_expires_at)
 VALUES(d,u.id,u.auth_epoch,true,clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '12 hours');
 RETURN true;
END $$;

-- Change routine owners after creation; grant no generic runtime DML.
GRANT CREATE ON SCHEMA access TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='access' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA access FROM orgfit_access_executor;
GRANT EXECUTE ON FUNCTION access.actor(),access.is_admin(),access.has_org(uuid),access.has_capability(text),access.profile(),access.set_locale(text),access.logout(),access.list_staff(),access.audit(),access.save_staff(uuid,bigint,jsonb,uuid,bytea),access.revoke_sessions(uuid) TO orgfit_staff;
GRANT EXECUTE ON FUNCTION access.begin_oidc(bytea,text,text,text),access.consume_oidc(bytea),access.issue_session(text,text,bytea) TO orgfit_auth;
