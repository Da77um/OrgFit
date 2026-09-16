-- ===========================================================================
-- Employee messages: a written channel from a client organization's employees
-- to the consultants working on that organization.
--
-- WHAT THIS IS NOT. It is not a survey answer and it never touches the
-- anonymous database. Nothing here names, references or can be joined to a
-- participant, an invitation, a campaign, a token digest of an invitation, a
-- respondent session, a draft, an envelope or an anonymous response.
--
-- How a message arrives. OrgFit issues ONE bearer link per organization
-- (core.message_link). The link's token lives in the URL fragment of the
-- respondent origin; only its keyed digest is stored, exactly like an
-- invitation's. The employee confirms the organization the link belongs to,
-- chooses one of that organization's ACTIVE departments or types a short
-- "other" department, and writes the message. No cookie, no session.
--
-- What a stored message deliberately does NOT carry:
--   the link it came through (a rotation would otherwise split messages into
--   before and after cohorts), participant, invitation, campaign, session, IP
--   address, user agent, request or correlation id, locale, and any time finer
--   than a calendar DAY. Core records when a named invitation was completed; a
--   message stamped to the minute could be lined up against that record without
--   any key joining them. The day is taken in the organization's own timezone,
--   and within a day messages are ordered by a random id, i.e. not at all.
--
-- What the schema cannot prevent, and the sending page says so in both
-- languages: free text tagged to a small department can identify its writer.
--
-- Lifecycle:
--   * retention class employee_message (365 days, unapproved default, P-004),
--     purged by ops.purge_employee_messages, run from runRetention;
--   * revoking a link records a MESSAGE_LINK tombstone, and the restore replay
--     revokes it again, so a restore cannot reopen a closed channel;
--   * an archived organization's link stops resolving at once.
--
-- Issuing, rotating and revoking a link is a Super Admin decision. Reading
-- messages needs the new capability messages.read (a Super Admin holds every
-- capability). Released migrations are not edited; vocabulary is restated.
-- ===========================================================================

-- --- vocabulary --------------------------------------------------------------
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED','INVITATION_CREATED','INVITATION_ACCEPTED','PASSWORD_SET','SETTINGS_CHANGED','AUDIT_EXPORTED','RELEASE_REVOKED','INTAKE_ERASED','MESSAGE_LINK_ISSUED','MESSAGE_LINK_REVOKED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison','report','visit','followUp','attachment','password','settings','session','audit','release','messageLink']::text[]);

ALTER TABLE ops.deletion_tombstone DROP CONSTRAINT deletion_tombstone_class_check;
ALTER TABLE ops.deletion_tombstone ADD CONSTRAINT deletion_tombstone_class_check
 CHECK(class IN ('ATTACHMENT','REPORT_ARTIFACT','PRIVATE_EXPORT','CAMPAIGN_INTAKE','CAMPAIGN_KEY','ANONYMOUS_CAMPAIGN','RELEASE_REVOCATION','MESSAGE_LINK'));

-- The capability list (001) and the invitation's capability bound (016) were
-- declared inline, so their generated names are looked up rather than assumed.
DO $$ DECLARE c text; BEGIN
 FOR c IN SELECT conname FROM pg_constraint
   WHERE conrelid='access.staff_capability'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%visits.manage%' LOOP
  EXECUTE format('ALTER TABLE access.staff_capability DROP CONSTRAINT %I',c);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint
   WHERE conrelid='access.staff_invitation'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%cardinality(capabilities)%' LOOP
  EXECUTE format('ALTER TABLE access.staff_invitation DROP CONSTRAINT %I',c);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint
   WHERE conrelid='intake.rate_limit'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%exchange_ip%' LOOP
  EXECUTE format('ALTER TABLE intake.rate_limit DROP CONSTRAINT %I',c);
 END LOOP;
END $$;
ALTER TABLE access.staff_capability ADD CONSTRAINT staff_capability_capability_check
 CHECK (capability IN ('directory.manage','instruments.manage','campaigns.manage','participation.read','participation.export','results.read','reports.manage','visits.manage','messages.read'));
ALTER TABLE access.staff_invitation ADD CONSTRAINT staff_invitation_bounds_check
 CHECK (cardinality(capabilities) <= 9 AND cardinality(organization_ids) <= 100);

-- Public rate-limit buckets for the message channel. Counted by the same
-- window-bound HMAC keys as every gateway bucket (017).
ALTER TABLE intake.rate_limit ADD CONSTRAINT rate_limit_bucket_check
 CHECK(bucket IN ('exchange_ip','exchange_token','draft_session','final_session','message_ip','message_link_open','message_link_send'));

CREATE OR REPLACE FUNCTION intake.rate_hit(bucket_in text,key_in bytea,window_start_in timestamptz,
 max_hits integer,window_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; ts timestamptz:=clock_timestamp(); BEGIN
 IF bucket_in NOT IN ('exchange_ip','exchange_token','draft_session','final_session','message_ip','message_link_open','message_link_send')
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

INSERT INTO ops.retention_policy(class,retain,basis) VALUES
 ('employee_message', interval '365 days', 'employee messages by received day; the link record is kept');

-- --- the organization's link -------------------------------------------------
CREATE TABLE core.message_link (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 token_digest bytea NOT NULL UNIQUE CHECK(octet_length(token_digest)=32),
 key_version text NOT NULL CHECK(key_version ~ '^[A-Za-z0-9_.-]{1,40}$'),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')),
 created_by uuid REFERENCES access.staff_user,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_by uuid REFERENCES access.staff_user,
 revoked_at timestamptz,
 UNIQUE(organization_id,id),
 CHECK((state='REVOKED')=(revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX message_link_one_active ON core.message_link(organization_id) WHERE state='ACTIVE';
CREATE INDEX ON core.message_link(created_by);
CREATE INDEX ON core.message_link(revoked_by);

-- --- the messages ------------------------------------------------------------
CREATE TABLE core.employee_message (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- fresh random, unrelated to any input
 organization_id uuid NOT NULL REFERENCES core.organization,
 department_id uuid,
 other_department text CHECK(length(btrim(other_department)) BETWEEN 1 AND 120),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 2000),
 received_on date NOT NULL,                        -- a day, never an instant
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,department_id) REFERENCES core.department(organization_id,id),
 CHECK((department_id IS NULL) <> (other_department IS NULL))
);
CREATE INDEX employee_message_inbox_idx ON core.employee_message(organization_id,received_on DESC,id DESC);
CREATE INDEX ON core.employee_message(organization_id,department_id);
CREATE INDEX ON core.employee_message(received_on);

-- A message is what the employee sent. No one edits it; retention removes it.
CREATE FUNCTION core.employee_message_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'MESSAGE_IMMUTABLE';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE ON core.employee_message
 FOR EACH ROW EXECUTE FUNCTION core.employee_message_immutable();

-- --- gateway: resolve a link -------------------------------------------------
-- Internal. An unknown digest, a revoked link and an archived organization are
-- the same answer (NULL), so a link holder learns nothing about which it was.
CREATE FUNCTION core.message_link_organization(d bytea) RETURNS core.organization
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.* FROM core.message_link l JOIN core.organization o ON o.id=l.organization_id
  WHERE l.token_digest=d AND l.state='ACTIVE' AND o.status='ACTIVE'
$$;

-- What the page may show: the organization's names and its ACTIVE departments.
-- No code, no count, no participant, no other organization.
CREATE FUNCTION core.gateway_message_context(d bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o core.organization; BEGIN
 IF d IS NULL OR octet_length(d)<>32 THEN RETURN jsonb_build_object('access','UNAVAILABLE'); END IF;
 o:=core.message_link_organization(d);
 IF o.id IS NULL THEN RETURN jsonb_build_object('access','UNAVAILABLE'); END IF;
 RETURN jsonb_build_object('access','OPEN',
  'organization',jsonb_build_object('nameAr',o.name_ar,'nameEn',o.name_en),
  'departments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'nameAr',x.name_ar,'nameEn',x.name_en) ORDER BY x.name_ar,x.id)
    FROM (SELECT id,name_ar,name_en FROM core.department WHERE organization_id=o.id AND status='ACTIVE' ORDER BY name_ar,id LIMIT 500) x),'[]'::jsonb));
END $$;

-- Accept one message. The organization comes from the link, never the request;
-- a department must be one of that organization's ACTIVE departments. The
-- answer carries no identifier and no time.
CREATE FUNCTION core.gateway_submit_message(d bytea,dept uuid,other text,message text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o core.organization; other_value text:=nullif(btrim(other),''); body_value text:=btrim(message); BEGIN
 IF d IS NULL OR octet_length(d)<>32 THEN RAISE EXCEPTION 'MESSAGE_LINK_UNAVAILABLE'; END IF;
 o:=core.message_link_organization(d);
 IF o.id IS NULL THEN RAISE EXCEPTION 'MESSAGE_LINK_UNAVAILABLE'; END IF;
 IF (dept IS NULL)=(other_value IS NULL)
  OR (other_value IS NOT NULL AND length(other_value) NOT BETWEEN 1 AND 120)
  OR body_value IS NULL OR length(body_value) NOT BETWEEN 1 AND 2000
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF dept IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.department WHERE organization_id=o.id AND id=dept AND status='ACTIVE')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO core.employee_message(organization_id,department_id,other_department,body,received_on)
 VALUES(o.id,dept,other_value,body_value,(clock_timestamp() AT TIME ZONE o.timezone)::date);
 RETURN jsonb_build_object('accepted',true);
END $$;

-- --- staff: the inbox ----------------------------------------------------------
-- One keyset page, newest day first. The cursor is the ORDER BY key itself.
-- filters: {} or {"department": "<uuid>"} or {"department": "OTHER"}.
CREATE FUNCTION core.message_page(org uuid,filters jsonb,after_on date,after_id uuid,page_size integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE dept text; dept_id uuid; page_rows jsonb; n integer; last_row jsonb; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('messages.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF filters IS NULL OR jsonb_typeof(filters)<>'object' OR filters-ARRAY['department']<>'{}'::jsonb
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF page_size IS NULL OR page_size<1 OR page_size>100 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (after_on IS NULL)<>(after_id IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 dept:=filters->>'department';
 IF dept IS NOT NULL AND dept<>'OTHER' THEN
  IF dept !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
  dept_id:=dept::uuid;
 END IF;
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.received_on DESC,x.id DESC),'[]'::jsonb),count(*) INTO page_rows,n FROM (
  SELECT m.received_on,m.id,jsonb_build_object(
   'id',m.id,'receivedOn',to_char(m.received_on,'YYYY-MM-DD'),
   'departmentId',m.department_id,'departmentNameAr',d.name_ar,'departmentNameEn',d.name_en,
   'otherDepartment',m.other_department,'body',m.body) AS item
  FROM core.employee_message m
  LEFT JOIN core.department d ON d.organization_id=m.organization_id AND d.id=m.department_id
  WHERE m.organization_id=org
   AND (dept IS NULL OR (dept='OTHER' AND m.department_id IS NULL) OR (dept_id IS NOT NULL AND m.department_id=dept_id))
   AND (after_on IS NULL OR (m.received_on,m.id)<(after_on,after_id))
  ORDER BY m.received_on DESC,m.id DESC
  LIMIT page_size+1) x;
 IF n>page_size THEN
  page_rows:=page_rows-page_size;
  last_row:=page_rows->(page_size-1);
  RETURN jsonb_build_object('items',page_rows,'next',jsonb_build_array(last_row->>'receivedOn',last_row->>'id'));
 END IF;
 RETURN jsonb_build_object('items',page_rows,'next',NULL);
END $$;

-- The departments a reader may filter by: every department that ever received
-- a message plus the ACTIVE ones, names only.
CREATE FUNCTION core.message_departments(org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('messages.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'nameAr',d.name_ar,'nameEn',d.name_en) ORDER BY d.name_ar,d.id)
  FROM core.department d WHERE d.organization_id=org
   AND (d.status='ACTIVE' OR EXISTS(SELECT 1 FROM core.employee_message m WHERE m.organization_id=org AND m.department_id=d.id))),'[]'::jsonb);
END $$;

-- --- staff: the link ------------------------------------------------------------
CREATE FUNCTION core.message_link_status(org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE l core.message_link; o core.organization; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('messages.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO o FROM core.organization WHERE id=org;
 SELECT * INTO l FROM core.message_link WHERE organization_id=org AND state='ACTIVE';
 RETURN jsonb_build_object(
  'active',l.id IS NOT NULL,
  'issuedAt',l.created_at,
  'issuedByName',(SELECT display_name FROM access.staff_user WHERE id=l.created_by),
  'organizationActive',o.status='ACTIVE',
  'canManage',access.is_admin());
END $$;

-- Issue (or rotate): revoke the active link, if any, and record a new digest.
-- A retry with the same key answers "replayed" — the first attempt's token was
-- shown once and never stored, so a retry cannot hand out a link again.
CREATE FUNCTION core.issue_message_link(org uuid,d bytea,version_in text,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); receipt uuid; old_id uuid; created uuid:=gen_random_uuid(); op text:=concat('message-link/issue/',org); BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM core.organization WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN RETURN jsonb_build_object('id',receipt,'replayed',true); END IF;
 IF NOT EXISTS(SELECT 1 FROM core.organization WHERE id=org AND status='ACTIVE') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF d IS NULL OR octet_length(d)<>32 OR version_in IS NULL OR version_in !~ '^[A-Za-z0-9_.-]{1,40}$'
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 UPDATE core.message_link SET state='REVOKED',revoked_by=actor,revoked_at=clock_timestamp()
  WHERE organization_id=org AND state='ACTIVE' RETURNING id INTO old_id;
 IF old_id IS NOT NULL THEN
  PERFORM ops.tombstone('MESSAGE_LINK',org,old_id);
  INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
  VALUES(actor,org,'MESSAGE_LINK_REVOKED',old_id,ARRAY['messageLink']);
 END IF;
 INSERT INTO core.message_link(id,organization_id,token_digest,key_version,created_by)
 VALUES(created,org,d,version_in,actor);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,'MESSAGE_LINK_ISSUED',created,ARRAY['messageLink']);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,created);
 RETURN jsonb_build_object('id',created,'replayed',false);
END $$;

CREATE FUNCTION core.revoke_message_link(org uuid,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); receipt uuid; old_id uuid; op text:=concat('message-link/revoke/',org); BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM core.organization WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN RETURN jsonb_build_object('id',receipt,'replayed',true); END IF;
 UPDATE core.message_link SET state='REVOKED',revoked_by=actor,revoked_at=clock_timestamp()
  WHERE organization_id=org AND state='ACTIVE' RETURNING id INTO old_id;
 IF old_id IS NULL THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 PERFORM ops.tombstone('MESSAGE_LINK',org,old_id);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,'MESSAGE_LINK_REVOKED',old_id,ARRAY['messageLink']);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,old_id);
 RETURN jsonb_build_object('id',old_id,'replayed',false);
END $$;

-- --- operators: restore replay and retention -------------------------------------
-- A link revoked after the backup was taken is ACTIVE again in the restored
-- database. It is revoked again before readiness opens.
CREATE FUNCTION core.reapply_message_link_revocation(org uuid,link uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH done AS (UPDATE core.message_link SET state='REVOKED',revoked_at=clock_timestamp()
  WHERE organization_id=org AND id=link AND state='ACTIVE' RETURNING 1)
 SELECT EXISTS(SELECT 1 FROM done)
$$;

-- Time-based and idempotent, like ops.purge_core; needs no tombstone because a
-- re-run after a restore removes the same rows again.
CREATE FUNCTION ops.purge_employee_messages(limit_rows integer DEFAULT 5000) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 IF limit_rows<1 OR limit_rows>100000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 DELETE FROM core.employee_message WHERE id IN (SELECT id FROM core.employee_message
  WHERE received_on < (clock_timestamp()-ops.retain('employee_message'))::date LIMIT limit_rows);
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO ops.retention_run(class,removed) VALUES('employee_message',n);
 RETURN n;
END $$;

-- --- ownership, row security and grants -------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['core.message_link','core.employee_message'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('CREATE POLICY staff_read ON %s TO orgfit_staff USING((SELECT access.has_org(organization_id)) AND (SELECT access.has_capability(''messages.read'')))',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON core.message_link TO orgfit_access_executor;
GRANT SELECT,INSERT,DELETE ON core.employee_message TO orgfit_access_executor;
-- Staff read the inbox through the routines above; the table grant exists so the
-- read policy is the boundary for any direct query too. The link's digest is
-- not a column staff can select.
GRANT SELECT ON core.employee_message TO orgfit_staff;
GRANT SELECT(id,organization_id,key_version,state,created_by,created_at,revoked_by,revoked_at) ON core.message_link TO orgfit_staff;

GRANT CREATE ON SCHEMA core,ops TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE (n.nspname='core' AND p.proname IN ('employee_message_immutable','message_link_organization','gateway_message_context',
     'gateway_submit_message','message_page','message_departments','message_link_status','issue_message_link',
     'revoke_message_link','reapply_message_link_revocation'))
     OR (n.nspname='ops' AND p.proname='purge_employee_messages') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA core,ops FROM orgfit_access_executor;

-- The gateway: two more routines, still no table privilege.
GRANT EXECUTE ON FUNCTION core.gateway_message_context(bytea),
 core.gateway_submit_message(bytea,uuid,text,text) TO orgfit_gateway;
-- Staff.
GRANT EXECUTE ON FUNCTION core.message_page(uuid,jsonb,date,uuid,integer),core.message_departments(uuid),
 core.message_link_status(uuid),core.issue_message_link(uuid,bytea,text,uuid,bytea),
 core.revoke_message_link(uuid,uuid,bytea) TO orgfit_staff;
-- Operators.
GRANT EXECUTE ON FUNCTION core.reapply_message_link_revocation(uuid,uuid),
 ops.purge_employee_messages(integer) TO orgfit_core_owner;
