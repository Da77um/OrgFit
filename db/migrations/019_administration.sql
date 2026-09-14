-- ===========================================================================
-- Post-Audit Repair Pass 1: administration screens and real pagination.
--
-- WHAT THIS REPLACES, AND WHAT IT DOES NOT.
--
-- access.list_staff(), access.audit() (001) and access.list_invitations() (016)
-- each return at most 100 rows with no way to reach the 101st: the audit trail
-- became partly unreachable as it grew. They are left in place, unchanged,
-- because released migrations are never edited; the application stops calling
-- them. The routines below replace them with keyset pages:
--
--   * a bounded page size (1..100), enforced here as well as in the route;
--   * a cursor made of the ORDER BY key itself, so a row inserted or removed
--     between two requests cannot shift a later page (no OFFSET anywhere);
--   * a total order: every sort ends in the primary key, so two audit events
--     written in the same microsecond are still ordered and never skipped;
--   * an allowlist of filter keys, refused rather than ignored when unknown.
--
-- It also adds the three things the new screens need and the schema lacked:
-- the caller's own sessions (scoped to access.actor(), never to an argument),
-- a versioned global settings record whose history cannot be rewritten, and an
-- administrator-only operational status read. Nothing here widens a runtime
-- role's table privileges: every read goes through a SECURITY DEFINER routine.
-- ===========================================================================

-- --- indexes for the keyset orders -----------------------------------------
CREATE INDEX audit_log_recent_idx ON ops.audit_log(occurred_at DESC, id DESC);
CREATE INDEX audit_log_action_recent_idx ON ops.audit_log(action, occurred_at DESC, id DESC);
CREATE INDEX audit_log_target_recent_idx ON ops.audit_log(target_id, occurred_at DESC, id DESC);
CREATE INDEX staff_invitation_recent_idx ON access.staff_invitation(created_at DESC, id DESC);

-- --- audit vocabulary --------------------------------------------------------
-- Restated whole, as every migration since 003 has done. New actions:
-- SETTINGS_CHANGED and AUDIT_EXPORTED. New field names: settings, session, audit.
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED','INVITATION_CREATED','INVITATION_ACCEPTED','PASSWORD_SET','SETTINGS_CHANGED','AUDIT_EXPORTED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison','report','visit','followUp','attachment','password','settings','session','audit']::text[]);

-- --- global settings: append-only versions ---------------------------------
-- Each save inserts a new revision; no row is ever updated or deleted, so what
-- the defaults were on any past date stays answerable. These are DEFAULTS for
-- new work only. A campaign freezes its own threshold and timezone at creation
-- (008), so changing a default here cannot reach a launched campaign, and the
-- threshold floor of five is a CHECK here exactly as it is on the campaign.
CREATE TABLE ops.system_setting (
 revision bigint PRIMARY KEY CHECK (revision > 0),
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 default_timezone text NOT NULL CHECK (length(default_timezone) BETWEEN 1 AND 100),
 default_campaign_threshold integer NOT NULL CHECK (default_campaign_threshold BETWEEN 5 AND 1000),
 staff_invitation_hours integer NOT NULL CHECK (staff_invitation_hours BETWEEN 1 AND 168),
 changed_by uuid REFERENCES access.staff_user,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (revision = 1 OR changed_by IS NOT NULL)
);
CREATE INDEX ON ops.system_setting(changed_by);
-- The values 008 and 016 already used as their built-in defaults.
INSERT INTO ops.system_setting(revision, default_timezone, default_campaign_threshold, staff_invitation_hours)
VALUES (1, 'Asia/Riyadh', 5, 72);

CREATE FUNCTION ops.system_setting_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'SETTINGS_IMMUTABLE';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ops.system_setting
 FOR EACH ROW EXECUTE FUNCTION ops.system_setting_immutable();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ops.system_setting
 FOR EACH STATEMENT EXECUTE FUNCTION ops.system_setting_immutable();

-- --- staff: one keyset page --------------------------------------------------
CREATE FUNCTION access.staff_page(filters jsonb, after_email text, after_id uuid, page_size integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q text; r text; st text; page_rows jsonb; n integer; last_row jsonb; BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF filters IS NULL OR jsonb_typeof(filters) <> 'object' OR filters - ARRAY['q','role','status'] <> '{}'::jsonb
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF page_size IS NULL OR page_size < 1 OR page_size > 100 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (after_email IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 q := nullif(btrim(filters->>'q'), ''); r := filters->>'role'; st := filters->>'status';
 IF length(q) > 200 OR (r IS NOT NULL AND r NOT IN ('SUPER_ADMIN','STAFF'))
  OR (st IS NOT NULL AND st NOT IN ('ACTIVE','DISABLED')) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.email, x.id), '[]'::jsonb), count(*) INTO page_rows, n FROM (
  SELECT u.email, u.id, jsonb_build_object(
   'id', u.id, 'email', u.email, 'displayName', u.display_name, 'role', u.role, 'status', u.status,
   'locale', u.locale, 'revision', u.revision,
   'authMethod', CASE WHEN u.issuer = 'urn:orgfit:local-password' THEN 'PASSWORD' ELSE 'OIDC' END,
   'capabilities', coalesce((SELECT jsonb_agg(c.capability ORDER BY c.capability) FROM access.staff_capability c WHERE c.staff_user_id = u.id), '[]'::jsonb),
   'organizationIds', coalesce((SELECT jsonb_agg(a.organization_id ORDER BY a.organization_id) FROM access.organization_access a WHERE a.staff_user_id = u.id), '[]'::jsonb),
   'activeSessions', (SELECT count(*) FROM access.staff_session s WHERE s.staff_user_id = u.id AND s.revoked_at IS NULL
      AND s.auth_epoch = u.auth_epoch AND s.idle_expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp()),
   'createdAt', u.created_at) AS item
  FROM access.staff_user u
  WHERE (r IS NULL OR u.role = r) AND (st IS NULL OR u.status = st)
   AND (q IS NULL OR strpos(lower(u.email), lower(q)) > 0 OR strpos(lower(u.display_name), lower(q)) > 0)
   AND (after_email IS NULL OR (u.email, u.id) > (after_email, after_id))
  ORDER BY u.email, u.id
  LIMIT page_size + 1) x;
 IF n > page_size THEN
  page_rows := page_rows - page_size;
  last_row := page_rows -> (page_size - 1);
  RETURN jsonb_build_object('items', page_rows, 'next', jsonb_build_array(last_row->>'email', last_row->>'id'));
 END IF;
 RETURN jsonb_build_object('items', page_rows, 'next', NULL);
END $$;

-- --- staff: one record -------------------------------------------------------
CREATE FUNCTION access.staff_record(target uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u access.staff_user; is_local boolean; BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO u FROM access.staff_user WHERE id = target;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 is_local := u.issuer = 'urn:orgfit:local-password';
 RETURN jsonb_build_object(
  'id', u.id, 'email', u.email, 'displayName', u.display_name, 'role', u.role, 'status', u.status,
  'locale', u.locale, 'revision', u.revision, 'createdAt', u.created_at, 'updatedAt', u.updated_at,
  'createdByName', (SELECT display_name FROM access.staff_user WHERE id = u.created_by),
  'updatedByName', (SELECT display_name FROM access.staff_user WHERE id = u.updated_by),
  'authMethod', CASE WHEN is_local THEN 'PASSWORD' ELSE 'OIDC' END,
  -- A provider identity is an identifier, not a credential; a local account's
  -- generated subject means nothing to anyone and is not shown.
  'issuer', CASE WHEN is_local THEN NULL ELSE u.issuer END,
  'subject', CASE WHEN is_local THEN NULL ELSE u.provider_subject END,
  'isSelf', u.id = access.actor(),
  'capabilities', coalesce((SELECT jsonb_agg(c.capability ORDER BY c.capability) FROM access.staff_capability c WHERE c.staff_user_id = u.id), '[]'::jsonb),
  'organizationIds', coalesce((SELECT jsonb_agg(a.organization_id ORDER BY a.organization_id) FROM access.organization_access a WHERE a.staff_user_id = u.id), '[]'::jsonb),
  'activeSessions', (SELECT count(*) FROM access.staff_session s WHERE s.staff_user_id = u.id AND s.revoked_at IS NULL
     AND s.auth_epoch = u.auth_epoch AND s.idle_expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp()),
  'lastSeenAt', (SELECT max(s.last_seen_at) FROM access.staff_session s WHERE s.staff_user_id = u.id),
  'otherActiveSuperAdmins', (SELECT count(*) FROM access.staff_user o WHERE o.id <> u.id AND o.role = 'SUPER_ADMIN' AND o.status = 'ACTIVE'));
END $$;

-- --- staff invitations: one keyset page -------------------------------------
CREATE FUNCTION access.invitation_page(filters jsonb, after_at timestamptz, after_id uuid, page_size integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q text; st text; page_rows jsonb; n integer; last_row jsonb; ts timestamptz := statement_timestamp(); BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF filters IS NULL OR jsonb_typeof(filters) <> 'object' OR filters - ARRAY['q','state'] <> '{}'::jsonb
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF page_size IS NULL OR page_size < 1 OR page_size > 100 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (after_at IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 q := nullif(btrim(filters->>'q'), ''); st := filters->>'state';
 IF length(q) > 320 OR (st IS NOT NULL AND st NOT IN ('PENDING','EXPIRED','CONSUMED','REVOKED'))
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*) INTO page_rows, n FROM (
  SELECT i.created_at, i.id, jsonb_build_object(
   'id', i.id, 'email', i.email, 'role', i.role, 'locale', i.locale,
   'capabilities', to_jsonb(i.capabilities), 'organizationIds', to_jsonb(i.organization_ids),
   'createdAt', i.created_at, 'expiresAt', i.expires_at, 'consumedAt', i.consumed_at, 'revokedAt', i.revoked_at,
   'createdByName', (SELECT display_name FROM access.staff_user WHERE id = i.created_by),
   'cursorAt', to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'state', CASE WHEN i.revoked_at IS NOT NULL THEN 'REVOKED' WHEN i.consumed_at IS NOT NULL THEN 'CONSUMED'
                 WHEN i.expires_at <= ts THEN 'EXPIRED' ELSE 'PENDING' END) AS item
  FROM access.staff_invitation i
  WHERE (q IS NULL OR strpos(i.email, lower(q)) > 0)
   AND (st IS NULL
    OR (st = 'REVOKED' AND i.revoked_at IS NOT NULL)
    OR (st = 'CONSUMED' AND i.revoked_at IS NULL AND i.consumed_at IS NOT NULL)
    OR (st = 'EXPIRED' AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at <= ts)
    OR (st = 'PENDING' AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at > ts))
   AND (after_at IS NULL OR (i.created_at, i.id) < (after_at, after_id))
  ORDER BY i.created_at DESC, i.id DESC
  LIMIT page_size + 1) x;
 IF n > page_size THEN
  page_rows := page_rows - page_size;
  last_row := page_rows -> (page_size - 1);
  RETURN jsonb_build_object('items', page_rows, 'next', jsonb_build_array(last_row->>'cursorAt', last_row->>'id'));
 END IF;
 RETURN jsonb_build_object('items', page_rows, 'next', NULL);
END $$;

-- Whether an invitation row was created with THIS token. create_invitation (016)
-- answers an idempotent retry with the original row's id; the secret of that
-- first attempt was returned once and never stored, so a retry must not hand
-- out a freshly generated link that matches nothing. The route asks this and,
-- on a replay, says the link cannot be shown again.
CREATE FUNCTION access.invitation_token_matches(target uuid, d bytea) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN EXISTS(SELECT 1 FROM access.staff_invitation WHERE id = target AND token_digest = d);
END $$;

-- --- audit: filtered keyset rows (internal) ----------------------------------
-- Not granted to any runtime role; called only from the two routines below,
-- which check the administrator first.
--
-- A respondent invitation's id is identity-side participation data. The audit
-- trail never carried an answer or a response id, and it still does not; the
-- target of a respondent-invitation event is withheld from browsing and export
-- all the same, so neither can be used to line up a named person's link with
-- anything else.
CREATE FUNCTION access.audit_select(filters jsonb, after_at timestamptz, after_id uuid, lim integer) RETURNS SETOF jsonb
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'id', a.id, 'action', a.action, 'fieldNames', to_jsonb(a.field_names),
  'occurredAt', to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'actorId', a.actor_id, 'actorName', u.display_name, 'actorEmail', u.email,
  'organizationId', a.organization_id, 'organizationCode', o.code,
  'organizationNameAr', o.name_ar, 'organizationNameEn', o.name_en,
  'targetId', CASE WHEN a.action IN ('INVITATION_ISSUED','INVITATION_ROTATED')
                     OR (a.action = 'INVITATION_REVOKED' AND NOT EXISTS(SELECT 1 FROM access.staff_invitation si WHERE si.id = a.target_id))
                   THEN NULL ELSE a.target_id END,
  'targetWithheld', a.action IN ('INVITATION_ISSUED','INVITATION_ROTATED')
                     OR (a.action = 'INVITATION_REVOKED' AND NOT EXISTS(SELECT 1 FROM access.staff_invitation si WHERE si.id = a.target_id)),
  'targetStaffName', t.display_name)
 FROM ops.audit_log a
 LEFT JOIN access.staff_user u ON u.id = a.actor_id
 LEFT JOIN core.organization o ON o.id = a.organization_id
 LEFT JOIN access.staff_user t ON t.id = a.target_id
 WHERE (filters->>'action' IS NULL OR a.action = filters->>'action')
  AND (filters->>'actorId' IS NULL OR a.actor_id = (filters->>'actorId')::uuid)
  AND (filters->>'targetId' IS NULL OR a.target_id = (filters->>'targetId')::uuid)
  AND (filters->>'organizationId' IS NULL OR a.organization_id = (filters->>'organizationId')::uuid)
  AND (filters->>'from' IS NULL OR a.occurred_at >= (filters->>'from')::timestamptz)
  AND (filters->>'to' IS NULL OR a.occurred_at < (filters->>'to')::timestamptz)
  AND (after_at IS NULL OR (a.occurred_at, a.id) < (after_at, after_id))
 ORDER BY a.occurred_at DESC, a.id DESC
 LIMIT lim
$$;

CREATE FUNCTION access.audit_filters_valid(filters jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT filters IS NOT NULL AND jsonb_typeof(filters) = 'object'
  AND filters - ARRAY['action','actorId','targetId','organizationId','from','to'] = '{}'::jsonb
  AND (filters->>'action' IS NULL OR (filters->>'action') ~ '^[A-Z_]{3,60}$')
$$;

CREATE FUNCTION access.audit_page(filters jsonb, after_at timestamptz, after_id uuid, page_size integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE page_rows jsonb; n integer; last_row jsonb; BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT access.audit_filters_valid(filters) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF page_size IS NULL OR page_size < 1 OR page_size > 100 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (after_at IS NULL) <> (after_id IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT coalesce(jsonb_agg(s.r ORDER BY s.ord), '[]'::jsonb), count(*) INTO page_rows, n
 FROM access.audit_select(filters, after_at, after_id, page_size + 1) WITH ORDINALITY AS s(r, ord);
 IF n > page_size THEN
  page_rows := page_rows - page_size;
  last_row := page_rows -> (page_size - 1);
  RETURN jsonb_build_object('items', page_rows, 'next', jsonb_build_array(last_row->>'occurredAt', last_row->>'id'));
 END IF;
 RETURN jsonb_build_object('items', page_rows, 'next', NULL);
END $$;

-- An export is itself an audited administrative event. It returns the same
-- sanitized fields the browser shows, bounded; the caller learns whether the
-- selection was larger than the bound instead of receiving a silently short file.
CREATE FUNCTION access.audit_export(filters jsonb, max_rows integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid := access.actor(); page_rows jsonb; n integer; export_id uuid := gen_random_uuid(); BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT access.audit_filters_valid(filters) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF max_rows IS NULL OR max_rows < 1 OR max_rows > 5000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT coalesce(jsonb_agg(s.r ORDER BY s.ord), '[]'::jsonb), count(*) INTO page_rows, n
 FROM access.audit_select(filters, NULL, NULL, max_rows + 1) WITH ORDINALITY AS s(r, ord);
 INSERT INTO ops.audit_log(actor_id, action, target_id, field_names) VALUES (actor, 'AUDIT_EXPORTED', export_id, ARRAY['audit']);
 IF n > max_rows THEN
  RETURN jsonb_build_object('exportId', export_id, 'items', page_rows - max_rows, 'truncated', true);
 END IF;
 RETURN jsonb_build_object('exportId', export_id, 'items', page_rows, 'truncated', false);
END $$;

-- --- the caller's own sessions ------------------------------------------------
-- Every routine here derives the account from access.actor(). None takes a
-- staff id, so none can be pointed at somebody else.
CREATE FUNCTION access.my_sessions() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid := access.actor(); current_digest bytea; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 current_digest := decode(current_setting('orgfit.session_digest'), 'hex');
 RETURN (SELECT coalesce(jsonb_agg(x.item ORDER BY x.is_current DESC, x.last_seen_at DESC, x.id), '[]'::jsonb) FROM (
  SELECT s.id, s.last_seen_at, s.token_digest = current_digest AS is_current, jsonb_build_object(
   'id', s.id, 'authMethod', s.auth_method, 'mfaVerified', s.mfa_verified,
   'createdAt', s.created_at, 'lastSeenAt', s.last_seen_at,
   'idleExpiresAt', s.idle_expires_at, 'absoluteExpiresAt', s.absolute_expires_at,
   'current', s.token_digest = current_digest) AS item
  FROM access.staff_session s JOIN access.staff_user u ON u.id = s.staff_user_id
  WHERE s.staff_user_id = actor AND s.revoked_at IS NULL AND s.auth_epoch = u.auth_epoch
   AND s.idle_expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp()
  ORDER BY s.token_digest = current_digest DESC, s.last_seen_at DESC, s.id
  LIMIT 50) x);
END $$;

CREATE FUNCTION access.revoke_my_session(target uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid := access.actor(); current_digest bytea; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 current_digest := decode(current_setting('orgfit.session_digest'), 'hex');
 -- The session in use ends through logout, which also clears its cookie.
 IF EXISTS(SELECT 1 FROM access.staff_session WHERE id = target AND staff_user_id = actor AND token_digest = current_digest)
  THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE access.staff_session SET revoked_at = clock_timestamp()
 WHERE id = target AND staff_user_id = actor AND revoked_at IS NULL;
 -- Another person's session and a session that does not exist answer alike.
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO ops.audit_log(actor_id, action, target_id, field_names) VALUES (actor, 'SESSIONS_REVOKED', actor, ARRAY['session']);
END $$;

CREATE FUNCTION access.revoke_my_other_sessions() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid := access.actor(); n integer; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 UPDATE access.staff_session SET revoked_at = clock_timestamp()
 WHERE staff_user_id = actor AND revoked_at IS NULL
  AND token_digest <> decode(current_setting('orgfit.session_digest'), 'hex');
 GET DIAGNOSTICS n = ROW_COUNT;
 INSERT INTO ops.audit_log(actor_id, action, target_id, field_names) VALUES (actor, 'SESSIONS_REVOKED', actor, ARRAY['session']);
 RETURN n;
END $$;

-- --- settings ------------------------------------------------------------------
CREATE FUNCTION access.settings_json(s ops.system_setting) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('revision', s.revision, 'id', s.id,
  'defaultTimezone', s.default_timezone, 'defaultCampaignThreshold', s.default_campaign_threshold,
  'staffInvitationHours', s.staff_invitation_hours, 'changedAt', s.changed_at,
  'changedByName', (SELECT display_name FROM access.staff_user WHERE id = s.changed_by),
  'thresholdFloor', 5, 'defaultLocale', 'ar')
$$;

-- Readable by any signed-in staff member: the forms that create campaigns and
-- invitations use these defaults. They are not secret and grant nothing.
CREATE FUNCTION access.settings() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ops.system_setting; BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 SELECT * INTO s FROM ops.system_setting ORDER BY revision DESC LIMIT 1;
 RETURN access.settings_json(s);
END $$;

CREATE FUNCTION access.save_settings(expected bigint, body jsonb, idem uuid, req_hash bytea) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid := access.actor(); old access.staff_mutation; cur ops.system_setting; created ops.system_setting;
 tz text; threshold integer; hours integer; BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM pg_advisory_xact_lock(80203);
 SELECT * INTO old FROM access.staff_mutation WHERE staff_user_id = actor AND operation = 'save_settings' AND idempotency_key = idem;
 IF FOUND THEN
  IF old.request_digest <> req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  SELECT * INTO created FROM ops.system_setting WHERE id = old.resource_id;
  RETURN access.settings_json(created);
 END IF;
 IF body IS NULL OR jsonb_typeof(body) <> 'object'
  OR body - ARRAY['defaultTimezone','defaultCampaignThreshold','staffInvitationHours'] <> '{}'::jsonb
  OR jsonb_typeof(body->'defaultTimezone') IS DISTINCT FROM 'string'
  OR jsonb_typeof(body->'defaultCampaignThreshold') IS DISTINCT FROM 'number'
  OR jsonb_typeof(body->'staffInvitationHours') IS DISTINCT FROM 'number'
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 tz := body->>'defaultTimezone';
 IF (body->>'defaultCampaignThreshold') !~ '^[0-9]{1,4}$' OR (body->>'staffInvitationHours') !~ '^[0-9]{1,3}$'
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 threshold := (body->>'defaultCampaignThreshold')::integer;
 hours := (body->>'staffInvitationHours')::integer;
 -- The floor is restated here so the refusal is a validation answer rather than
 -- a constraint name; the CHECK remains the authority.
 IF threshold < 5 OR threshold > 1000 OR hours < 1 OR hours > 168 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name = tz) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO cur FROM ops.system_setting ORDER BY revision DESC LIMIT 1;
 IF expected IS NULL OR cur.revision <> expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 INSERT INTO ops.system_setting(revision, default_timezone, default_campaign_threshold, staff_invitation_hours, changed_by)
 VALUES (cur.revision + 1, tz, threshold, hours, actor) RETURNING * INTO created;
 INSERT INTO ops.audit_log(actor_id, action, target_id, field_names) VALUES (actor, 'SETTINGS_CHANGED', created.id, ARRAY['settings']);
 INSERT INTO access.staff_mutation(staff_user_id, operation, idempotency_key, request_digest, resource_id)
 VALUES (actor, 'save_settings', idem, req_hash, created.id);
 RETURN access.settings_json(created);
END $$;

CREATE FUNCTION access.settings_history() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(access.settings_json(s) ORDER BY s.revision DESC), '[]'::jsonb)
  FROM (SELECT * FROM ops.system_setting ORDER BY revision DESC LIMIT 20) s);
END $$;

-- Operational status for the settings screen: the same campaign-level counts
-- and ages the operator alert job reads, the retention policy exactly as
-- recorded (an unapproved default is reported as unapproved), and whether the
-- development-only password path is switched on. No secret, key, credential or
-- respondent-level value is reachable from here.
CREATE FUNCTION access.system_status() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN jsonb_build_object(
  'alerts', ops.alert_inputs(),
  'localAccessEnabled', access.local_access_enabled(),
  'retention', (SELECT coalesce(jsonb_agg(jsonb_build_object(
     'class', p.class, 'retain', p.retain::text, 'basis', p.basis,
     'approved', p.approved, 'approvedAt', p.approved_at, 'approvedBy', p.approved_by) ORDER BY p.class), '[]'::jsonb)
   FROM ops.retention_policy p),
  'readAt', clock_timestamp());
END $$;

-- --- ownership, RLS and grants ---------------------------------------------
ALTER TABLE ops.system_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.system_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON ops.system_setting TO orgfit_access_executor USING (true) WITH CHECK (true);
CREATE POLICY migration ON ops.system_setting TO orgfit_core_owner USING (true) WITH CHECK (true);
-- Append-only by privilege as well as by trigger.
GRANT SELECT, INSERT ON ops.system_setting TO orgfit_access_executor;

GRANT CREATE ON SCHEMA access, ops TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE (n.nspname = 'access' AND p.proname IN ('staff_page','staff_record','invitation_page','invitation_token_matches',
    'audit_select','audit_filters_valid','audit_page','audit_export','my_sessions','revoke_my_session',
    'revoke_my_other_sessions','settings_json','settings','save_settings','settings_history','system_status'))
   OR (n.nspname = 'ops' AND p.proname = 'system_setting_immutable') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor', f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA access, ops FROM orgfit_access_executor;

GRANT EXECUTE ON FUNCTION
 access.staff_page(jsonb,text,uuid,integer), access.staff_record(uuid),
 access.invitation_page(jsonb,timestamptz,uuid,integer), access.invitation_token_matches(uuid,bytea),
 access.audit_page(jsonb,timestamptz,uuid,integer), access.audit_export(jsonb,integer),
 access.my_sessions(), access.revoke_my_session(uuid), access.revoke_my_other_sessions(),
 access.settings(), access.save_settings(bigint,jsonb,uuid,bytea), access.settings_history(),
 access.system_status()
TO orgfit_staff;
