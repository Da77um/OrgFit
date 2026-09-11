-- Phase 12: physical field visits, follow-up actions and private attachments.
--
-- A visit is CONSULTING material about an organization: who went, when, what
-- was found, what was recommended and what has to happen next. It is identified
-- by design — a consultant, an owner, a named organization — and that is
-- exactly why it is kept structurally away from survey data.
--
-- The separation is a property of the schema, not a rule someone remembers:
--
--   * core.field_visit may reference core.assessment_round and nothing else.
--     There is no column here that can name a response, an invitation, a
--     participant, a draft, an intake envelope or an anonymous row, so no
--     future query can join a visit note to an answer.
--   * An attachment hangs off a visit and only off a visit. There is no
--     polymorphic parent, no caller-supplied storage path and no respondent-
--     reachable route to one.
--   * Nothing in this migration reads publication, intake or instrument data,
--     and nothing in publication, intake or the anonymous database learns that
--     a visit exists.
--
-- Attachment bytes are quarantined on arrival and are downloadable only after a
-- separate credential has verified the declared type against the actual content
-- and scanned them. Failure is fail-closed: an unscanned, failed or rejected
-- attachment is not downloadable, and a scanner outage produces a retryable
-- QUARANTINED row rather than an available one.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='orgfit_scanner') THEN
  RAISE EXCEPTION 'Apply db/roles.sql before migration 015: role orgfit_scanner is missing';
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. The visit.
--
-- state: DRAFT -> SCHEDULED -> IN_PROGRESS -> COMPLETED, with CANCELLED
--        reachable from the three open states and from nowhere else. COMPLETED
--        and CANCELLED are terminal: an amendment records a correction, it does
--        not reopen the visit, and it never rewrites the original completion.
-- ---------------------------------------------------------------------------
CREATE TABLE core.field_visit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 -- The ONLY relationship a visit may have to assessment work. Same organization
 -- by composite key, so a guessed round identifier from another organization
 -- cannot be attached even when the UUID is valid.
 related_round_id uuid,
 assigned_consultant_id uuid NOT NULL REFERENCES access.staff_user,
 scheduled_start timestamptz NOT NULL,
 scheduled_end timestamptz,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
 purpose text NOT NULL CHECK(length(btrim(purpose)) BETWEEN 1 AND 500),
 notes text CHECK(length(notes)<=5000),
 findings text CHECK(length(findings)<=5000),
 recommendations text CHECK(length(recommendations)<=5000),
 follow_up_date date,
 state text NOT NULL DEFAULT 'DRAFT'
  CHECK(state IN ('DRAFT','SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')),
 completed_at timestamptz, cancelled_at timestamptz,
 cancellation_reason text CHECK(length(btrim(cancellation_reason)) BETWEEN 1 AND 500),
 -- An amendment to a completed visit is counted, timestamped and justified. The
 -- original completion instant is never touched.
 amendment_count integer NOT NULL DEFAULT 0 CHECK(amendment_count>=0),
 last_amended_at timestamptz,
 last_amendment_reason text CHECK(length(btrim(last_amendment_reason)) BETWEEN 1 AND 500),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,related_round_id) REFERENCES core.assessment_round(organization_id,id),
 CHECK(scheduled_end IS NULL OR scheduled_end>scheduled_start),
 CHECK((state='COMPLETED')=(completed_at IS NOT NULL)),
 CHECK((state='CANCELLED')=(cancelled_at IS NOT NULL)),
 CHECK((state='CANCELLED')=(cancellation_reason IS NOT NULL)),
 CHECK((amendment_count>0)=(last_amended_at IS NOT NULL))
);
CREATE INDEX ON core.field_visit(organization_id,scheduled_start DESC,id);
CREATE INDEX ON core.field_visit(organization_id,assigned_consultant_id,state);
CREATE INDEX ON core.field_visit(organization_id,state,follow_up_date);
CREATE INDEX ON core.field_visit(organization_id,related_round_id);
CREATE INDEX ON core.field_visit(created_by);
CREATE INDEX ON core.field_visit(updated_by);

CREATE FUNCTION core.field_visit_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VISIT_IMMUTABLE'; END IF;
 IF NEW.organization_id<>OLD.organization_id OR NEW.created_at<>OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN RAISE EXCEPTION 'VISIT_IMMUTABLE'; END IF;
 -- The completion and cancellation events survive every later correction.
 IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at
  THEN RAISE EXCEPTION 'VISIT_IMMUTABLE'; END IF;
 IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
  THEN RAISE EXCEPTION 'VISIT_IMMUTABLE'; END IF;
 -- A cancelled visit is a closed record. Nothing about it changes afterwards.
 IF OLD.state='CANCELLED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF NEW.state<>OLD.state AND NOT (
   (OLD.state='DRAFT'       AND NEW.state IN ('SCHEDULED','CANCELLED')) OR
   (OLD.state='SCHEDULED'   AND NEW.state IN ('IN_PROGRESS','CANCELLED')) OR
   (OLD.state='IN_PROGRESS' AND NEW.state IN ('COMPLETED','CANCELLED'))
 ) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle BEFORE UPDATE OR DELETE ON core.field_visit
 FOR EACH ROW EXECUTE FUNCTION core.field_visit_lifecycle();

ALTER TABLE core.field_visit ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.field_visit FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON core.field_visit TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON core.field_visit TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON core.field_visit TO orgfit_access_executor;
-- Deliberately absent: any grant to orgfit_staff, orgfit_gateway, orgfit_processor,
-- orgfit_report or orgfit_scanner. Staff reach visits only through the routines
-- below, and no other deployment identity may see that a visit exists at all.

-- ---------------------------------------------------------------------------
-- 2. Follow-up actions. Internal task list only: there is no address, no
--    message body, no send state and no outbound anything in this table.
-- ---------------------------------------------------------------------------
CREATE TABLE core.visit_follow_up (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 visit_id uuid NOT NULL,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 300),
 owner_staff_id uuid NOT NULL REFERENCES access.staff_user,
 due_date date NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DONE','CANCELLED')),
 notes text CHECK(length(notes)<=4000),
 closure_reason text CHECK(length(btrim(closure_reason)) BETWEEN 1 AND 500),
 closed_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,visit_id) REFERENCES core.field_visit(organization_id,id),
 CHECK((status='OPEN')=(closed_at IS NULL)),
 CHECK(status<>'CANCELLED' OR closure_reason IS NOT NULL)
);
CREATE INDEX ON core.visit_follow_up(organization_id,status,due_date);
CREATE INDEX ON core.visit_follow_up(organization_id,visit_id);
CREATE INDEX ON core.visit_follow_up(owner_staff_id);
CREATE INDEX ON core.visit_follow_up(created_by);
CREATE INDEX ON core.visit_follow_up(updated_by);
ALTER TABLE core.visit_follow_up ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.visit_follow_up FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON core.visit_follow_up TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON core.visit_follow_up TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON core.visit_follow_up TO orgfit_access_executor;

-- ---------------------------------------------------------------------------
-- 3. Attachments.
--
-- scan_status: UPLOADING -> QUARANTINED -> CLEAN | REJECTED | FAILED, with
--              FAILED -> QUARANTINED as the whole retry story and EXPIRED as
--              the terminal state of bytes that no longer exist. Only CLEAN is
--              downloadable, and the download routine re-checks it.
--
-- declared_type is what the browser said. content_type is what the scanner
-- proved by reading the first bytes. They are separate columns because a
-- mislabelled file is the normal case this module has to survive, and CLEAN
-- requires the verified column to be present.
-- ---------------------------------------------------------------------------
CREATE TABLE core.attachment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 visit_id uuid NOT NULL,
 original_name text NOT NULL CHECK(length(btrim(original_name)) BETWEEN 1 AND 255),
 declared_type text NOT NULL CHECK(length(declared_type) BETWEEN 1 AND 150),
 content_type text CHECK(length(content_type) BETWEEN 1 AND 150),
 -- Generated, never derived from the uploaded name. UNIQUE so two rows can
 -- never point at one object, and shape-checked so no row can address another
 -- module's storage prefix.
 storage_key text NOT NULL UNIQUE
  CHECK(storage_key ~ '^attachments/[0-9a-f-]{36}/[0-9a-f-]{36}[.]bin$'),
 size bigint CHECK(size IS NULL OR (size>0 AND size<=20971520)),
 checksum bytea CHECK(checksum IS NULL OR octet_length(checksum)=32),
 scan_status text NOT NULL DEFAULT 'UPLOADING'
  CHECK(scan_status IN ('UPLOADING','QUARANTINED','CLEAN','REJECTED','FAILED','EXPIRED')),
 scan_attempt integer NOT NULL DEFAULT 0 CHECK(scan_attempt>=0 AND scan_attempt<=10),
 scanned_at timestamptz,
 rejection_code text CHECK(rejection_code ~ '^[A-Z][A-Z_]{0,39}$'),
 uploaded_by uuid NOT NULL REFERENCES access.staff_user,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz, expires_at timestamptz,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,visit_id) REFERENCES core.field_visit(organization_id,id),
 -- A downloadable attachment is a verified type, a size, a checksum and a
 -- retention date, all or none. There is no half-clean file.
 CHECK(scan_status<>'CLEAN' OR (content_type IS NOT NULL AND size IS NOT NULL
   AND checksum IS NOT NULL AND expires_at IS NOT NULL AND scanned_at IS NOT NULL)),
 -- Nothing has been scanned until the bytes finished arriving.
 CHECK(scan_status='UPLOADING' OR completed_at IS NOT NULL),
 CHECK(scan_status IN ('UPLOADING','QUARANTINED','FAILED','EXPIRED') OR scanned_at IS NOT NULL),
 CHECK(scan_status<>'REJECTED' OR rejection_code IS NOT NULL)
);
CREATE INDEX ON core.attachment(organization_id,visit_id,scan_status);
CREATE INDEX ON core.attachment(scan_status,created_at);
CREATE INDEX ON core.attachment(scan_status,expires_at);
CREATE INDEX ON core.attachment(uploaded_by);

CREATE FUNCTION core.attachment_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE'; END IF;
 IF NEW.organization_id<>OLD.organization_id OR NEW.visit_id<>OLD.visit_id
    OR NEW.storage_key<>OLD.storage_key OR NEW.original_name<>OLD.original_name
    OR NEW.declared_type<>OLD.declared_type OR NEW.uploaded_by<>OLD.uploaded_by
    OR NEW.created_at<>OLD.created_at
  THEN RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE'; END IF;
 IF NOT (
   (OLD.scan_status='UPLOADING'   AND NEW.scan_status IN ('UPLOADING','QUARANTINED','EXPIRED')) OR
   (OLD.scan_status='QUARANTINED' AND NEW.scan_status IN ('QUARANTINED','CLEAN','REJECTED','FAILED','EXPIRED')) OR
   (OLD.scan_status='FAILED'      AND NEW.scan_status IN ('FAILED','QUARANTINED','EXPIRED')) OR
   (OLD.scan_status='CLEAN'       AND NEW.scan_status IN ('CLEAN','EXPIRED')) OR
   (OLD.scan_status='REJECTED'    AND NEW.scan_status IN ('REJECTED','EXPIRED'))
 ) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- A verified file is never re-verified into different bytes: once CLEAN the
 -- only expressible change is the file's disappearance.
 IF OLD.scan_status='CLEAN' AND NEW.scan_status='CLEAN'
    AND (NEW.content_type IS DISTINCT FROM OLD.content_type
      OR NEW.size IS DISTINCT FROM OLD.size
      OR NEW.checksum IS DISTINCT FROM OLD.checksum)
  THEN RAISE EXCEPTION 'ATTACHMENT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lifecycle BEFORE UPDATE OR DELETE ON core.attachment
 FOR EACH ROW EXECUTE FUNCTION core.attachment_lifecycle();

ALTER TABLE core.attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON core.attachment TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON core.attachment TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON core.attachment TO orgfit_access_executor;

ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison','report','visit','followUp','attachment']::text[]);

-- ---------------------------------------------------------------------------
-- 4. The staff surface.
--
-- Every routine begins with the same three checks — an actor, an organization
-- the actor may see, and visits.manage — because a visit is confidential
-- consulting material and no other capability implies access to it. Holding
-- results.read, campaigns.manage, directory.manage or reports.manage grants
-- nothing here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.visit_guard(org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('visits.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
END $$;

-- Who may actually be assigned: active, holding visits.manage, and authorized on
-- THIS organization. It exists so an assignment cannot silently name someone who
-- could not open the visit afterwards. These are colleagues' names, never a
-- participant's.
CREATE FUNCTION core.visit_eligible_consultant(staff uuid,org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM access.staff_user u
   WHERE u.id=staff AND u.status='ACTIVE'
     AND (u.role='SUPER_ADMIN'
       OR (EXISTS(SELECT 1 FROM access.organization_access a
                   WHERE a.staff_user_id=u.id AND a.organization_id=org)
       AND EXISTS(SELECT 1 FROM access.staff_capability c
                   WHERE c.staff_user_id=u.id AND c.capability='visits.manage'))))
$$;

CREATE FUNCTION core.visit_consultants(org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; BEGIN
 PERFORM core.visit_guard(org);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'displayName',u.display_name)
   ORDER BY u.display_name),'[]'::jsonb)
  INTO result FROM access.staff_user u
  WHERE u.status='ACTIVE' AND core.visit_eligible_consultant(u.id,org);
 RETURN result;
END $$;

CREATE FUNCTION core.visit_document(v core.field_visit) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',v.id,'organizationId',v.organization_id,'relatedRoundId',v.related_round_id,
  'relatedRoundLabel',(SELECT r.label FROM core.assessment_round r
    WHERE r.id=v.related_round_id AND r.organization_id=v.organization_id),
  'assignedConsultantId',v.assigned_consultant_id,
  'assignedConsultantName',(SELECT u.display_name FROM access.staff_user u WHERE u.id=v.assigned_consultant_id),
  'assignedConsultantActive',(SELECT u.status='ACTIVE' FROM access.staff_user u WHERE u.id=v.assigned_consultant_id),
  'scheduledStart',v.scheduled_start,'scheduledEnd',v.scheduled_end,'timezone',v.timezone,
  'purpose',v.purpose,'notes',v.notes,'findings',v.findings,'recommendations',v.recommendations,
  'followUpDate',v.follow_up_date,'state',v.state,'completedAt',v.completed_at,'cancelledAt',v.cancelled_at,
  'cancellationReason',v.cancellation_reason,'amendmentCount',v.amendment_count,
  'lastAmendedAt',v.last_amended_at,'lastAmendmentReason',v.last_amendment_reason,'revision',v.revision,
  'createdAt',v.created_at,'updatedAt',v.updated_at)
$$;

-- Create or edit. `expected` is NULL only on create. Editing a COMPLETED visit
-- is an AMENDMENT: it requires an explicit reason, it is counted and audited
-- under its own action, and it cannot change the state or the completion time.
CREATE FUNCTION core.save_visit(org uuid,visit uuid,expected bigint,body jsonb,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); existing core.field_visit; result uuid; consultant uuid;
 op text:=concat('visit/',org); receipt uuid; amendment boolean:=false; reason text; BEGIN
 PERFORM core.visit_guard(org);
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN
  RETURN (SELECT core.visit_document(v)||jsonb_build_object('replayed',true)
          FROM core.field_visit v WHERE v.id=receipt);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=body->>'timezone')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 consultant:=(body->>'assignedConsultantId')::uuid;
 -- An inactive or unauthorized consultant cannot be assigned, on create or on
 -- any later edit. A visit whose consultant is disabled afterwards keeps the
 -- historical assignment and reports it as inactive; it simply cannot be
 -- re-saved with that person still on it.
 IF consultant IS NULL OR NOT core.visit_eligible_consultant(consultant,org)
  THEN RAISE EXCEPTION 'CONSULTANT_INACTIVE'; END IF;
 IF body->>'relatedRoundId' IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM core.assessment_round WHERE id=(body->>'relatedRoundId')::uuid AND organization_id=org)
  THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF visit IS NULL THEN
  IF expected IS NOT NULL THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  INSERT INTO core.field_visit(organization_id,related_round_id,assigned_consultant_id,scheduled_start,
   scheduled_end,timezone,purpose,notes,findings,recommendations,follow_up_date,created_by,updated_by)
  VALUES(org,(body->>'relatedRoundId')::uuid,consultant,(body->>'scheduledStart')::timestamptz,
   (body->>'scheduledEnd')::timestamptz,body->>'timezone',body->>'purpose',body->>'notes',
   body->>'findings',body->>'recommendations',(body->>'followUpDate')::date,actor,actor)
  RETURNING id INTO result;
 ELSE
  SELECT * INTO existing FROM core.field_visit WHERE id=visit AND organization_id=org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF expected IS NULL OR existing.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
  IF existing.state='CANCELLED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
  IF existing.state='COMPLETED' THEN
   reason:=nullif(btrim(coalesce(body->>'amendmentReason','')),'');
   IF reason IS NULL THEN RAISE EXCEPTION 'AMENDMENT_REASON_REQUIRED'; END IF;
   amendment:=true;
  END IF;
  UPDATE core.field_visit SET related_round_id=(body->>'relatedRoundId')::uuid,
   assigned_consultant_id=consultant,scheduled_start=(body->>'scheduledStart')::timestamptz,
   scheduled_end=(body->>'scheduledEnd')::timestamptz,timezone=body->>'timezone',purpose=body->>'purpose',
   notes=body->>'notes',findings=body->>'findings',recommendations=body->>'recommendations',
   follow_up_date=(body->>'followUpDate')::date,
   amendment_count=amendment_count+CASE WHEN amendment THEN 1 ELSE 0 END,
   last_amended_at=CASE WHEN amendment THEN clock_timestamp() ELSE last_amended_at END,
   last_amendment_reason=CASE WHEN amendment THEN reason ELSE last_amendment_reason END,
   revision=revision+1,updated_at=clock_timestamp(),updated_by=actor
   WHERE id=existing.id RETURNING id INTO result;
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,result);
 -- Sanitized audit: the field group that changed, never the note, finding or
 -- recommendation text itself.
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,CASE WHEN amendment THEN 'VISIT_AMENDED' ELSE 'VISIT_CHANGED' END,result,ARRAY['visit']);
 RETURN (SELECT core.visit_document(v)||jsonb_build_object('replayed',false)
         FROM core.field_visit v WHERE v.id=result);
END $$;

CREATE FUNCTION core.visit_transition(org uuid,visit uuid,expected bigint,target text,reason text,
 idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); v core.field_visit; op text:=concat('visit-transition/',org); receipt uuid; BEGIN
 PERFORM core.visit_guard(org);
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN
  RETURN (SELECT core.visit_document(x)||jsonb_build_object('replayed',true)
          FROM core.field_visit x WHERE x.id=receipt);
 END IF;
 IF target NOT IN ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO v FROM core.field_visit WHERE id=visit AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR v.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 -- A transition to the state the visit is already in is not a no-op to accept:
 -- it is a caller that believes the record is somewhere else.
 IF target=v.state THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF target='CANCELLED' AND nullif(btrim(coalesce(reason,'')),'') IS NULL
  THEN RAISE EXCEPTION 'CANCELLATION_REASON_REQUIRED'; END IF;
 -- Scheduling or starting a visit re-checks the assigned consultant, so a visit
 -- cannot move forward onto someone who has since been disabled or unassigned.
 IF target IN ('SCHEDULED','IN_PROGRESS')
    AND NOT core.visit_eligible_consultant(v.assigned_consultant_id,org)
  THEN RAISE EXCEPTION 'CONSULTANT_INACTIVE'; END IF;
 UPDATE core.field_visit SET state=target,
  completed_at=CASE WHEN target='COMPLETED' THEN clock_timestamp() ELSE completed_at END,
  cancelled_at=CASE WHEN target='CANCELLED' THEN clock_timestamp() ELSE cancelled_at END,
  cancellation_reason=CASE WHEN target='CANCELLED' THEN btrim(reason) ELSE cancellation_reason END,
  revision=revision+1,updated_at=clock_timestamp(),updated_by=actor
  WHERE id=v.id;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,v.id);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,'VISIT_TRANSITIONED',v.id,ARRAY['visit','state']);
 RETURN (SELECT core.visit_document(x)||jsonb_build_object('replayed',false)
         FROM core.field_visit x WHERE x.id=v.id);
END $$;

-- The calendar and the list are the same bounded query with a different window.
CREATE FUNCTION core.visits(org uuid,filters jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; from_at timestamptz:=(filters->>'from')::timestamptz;
 to_at timestamptz:=(filters->>'to')::timestamptz; consultant uuid:=(filters->>'consultantId')::uuid;
 want_state text:=filters->>'state'; limit_rows integer:=coalesce((filters->>'limit')::integer,100); BEGIN
 PERFORM core.visit_guard(org);
 IF limit_rows<1 OR limit_rows>200 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF want_state IS NOT NULL AND want_state NOT IN ('DRAFT','SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT coalesce(jsonb_agg(document ORDER BY start_at DESC,id),'[]'::jsonb) INTO result FROM (
  SELECT v.id,v.scheduled_start AS start_at,
   core.visit_document(v)||jsonb_build_object(
    'attachmentCount',(SELECT count(*) FROM core.attachment a
      WHERE a.organization_id=org AND a.visit_id=v.id AND a.scan_status<>'EXPIRED'),
    'openFollowUps',(SELECT count(*) FROM core.visit_follow_up f
      WHERE f.organization_id=org AND f.visit_id=v.id AND f.status='OPEN')) AS document
  FROM core.field_visit v
  WHERE v.organization_id=org
    AND (from_at IS NULL OR v.scheduled_start>=from_at)
    AND (to_at IS NULL OR v.scheduled_start<to_at)
    AND (consultant IS NULL OR v.assigned_consultant_id=consultant)
    AND (want_state IS NULL OR v.state=want_state)
  ORDER BY v.scheduled_start DESC,v.id LIMIT limit_rows) s;
 RETURN result;
END $$;

CREATE FUNCTION core.visit_detail(org uuid,visit uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v core.field_visit; BEGIN
 PERFORM core.visit_guard(org);
 SELECT * INTO v FROM core.field_visit WHERE id=visit AND organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN core.visit_document(v)||jsonb_build_object(
  'followUps',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'visitId',f.visit_id,'title',f.title,
     'ownerStaffId',f.owner_staff_id,'ownerName',u.display_name,'dueDate',f.due_date,'status',f.status,
     'notes',f.notes,'closureReason',f.closure_reason,'closedAt',f.closed_at,'revision',f.revision,
     'overdue',f.status='OPEN' AND f.due_date<current_date,
     'createdAt',f.created_at,'updatedAt',f.updated_at) ORDER BY f.due_date,f.id)
    FROM core.visit_follow_up f LEFT JOIN access.staff_user u ON u.id=f.owner_staff_id
    WHERE f.organization_id=org AND f.visit_id=visit),'[]'::jsonb),
  -- Storage keys are never returned. A client addresses an attachment by id and
  -- the download routine resolves the object.
  'attachments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'visitId',a.visit_id,
     'originalName',a.original_name,'declaredType',a.declared_type,'contentType',a.content_type,
     'size',a.size,'scanStatus',a.scan_status,'rejectionCode',a.rejection_code,'scannedAt',a.scanned_at,
     'uploadedBy',a.uploaded_by,'uploadedByName',u.display_name,'createdAt',a.created_at,
     'completedAt',a.completed_at,'expiresAt',a.expires_at,
     'downloadable',a.scan_status='CLEAN' AND a.expires_at>clock_timestamp())
     ORDER BY a.created_at,a.id)
    FROM core.attachment a LEFT JOIN access.staff_user u ON u.id=a.uploaded_by
    WHERE a.organization_id=org AND a.visit_id=visit AND a.scan_status<>'EXPIRED'),'[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 5. Follow-up actions and the internal overdue list.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.save_follow_up(org uuid,visit uuid,action uuid,expected bigint,body jsonb,
 idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); existing core.visit_follow_up; result uuid; owner uuid; want_status text;
 op text:=concat('visit-follow-up/',org); receipt uuid; closure text; BEGIN
 PERFORM core.visit_guard(org);
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN result:=receipt;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM core.field_visit WHERE id=visit AND organization_id=org)
   THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  owner:=(body->>'ownerStaffId')::uuid;
  IF owner IS NULL OR NOT core.visit_eligible_consultant(owner,org)
   THEN RAISE EXCEPTION 'CONSULTANT_INACTIVE'; END IF;
  want_status:=coalesce(body->>'status','OPEN');
  closure:=nullif(btrim(coalesce(body->>'closureReason','')),'');
  IF want_status='CANCELLED' AND closure IS NULL THEN RAISE EXCEPTION 'CLOSURE_REASON_REQUIRED'; END IF;
  IF action IS NULL THEN
   IF expected IS NOT NULL THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
   INSERT INTO core.visit_follow_up(organization_id,visit_id,title,owner_staff_id,due_date,status,notes,
    closure_reason,closed_at,created_by,updated_by)
   VALUES(org,visit,body->>'title',owner,(body->>'dueDate')::date,want_status,body->>'notes',closure,
    CASE WHEN want_status='OPEN' THEN NULL ELSE clock_timestamp() END,actor,actor)
   RETURNING id INTO result;
  ELSE
   SELECT * INTO existing FROM core.visit_follow_up
    WHERE id=action AND organization_id=org AND visit_id=visit FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
   IF expected IS NULL OR existing.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
   UPDATE core.visit_follow_up SET title=body->>'title',owner_staff_id=owner,
    due_date=(body->>'dueDate')::date,status=want_status,notes=body->>'notes',closure_reason=closure,
    closed_at=CASE WHEN want_status='OPEN' THEN NULL ELSE coalesce(closed_at,clock_timestamp()) END,
    revision=revision+1,updated_at=clock_timestamp(),updated_by=actor
    WHERE id=existing.id RETURNING id INTO result;
  END IF;
  INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
  VALUES(actor,op,idem,req_hash,result);
  INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
  VALUES(actor,org,'FOLLOW_UP_CHANGED',result,ARRAY['followUp']);
 END IF;
 RETURN (SELECT jsonb_build_object('id',f.id,'visitId',f.visit_id,'title',f.title,
   'ownerStaffId',f.owner_staff_id,'dueDate',f.due_date,'status',f.status,'notes',f.notes,
   'closureReason',f.closure_reason,'closedAt',f.closed_at,'revision',f.revision,
   'overdue',f.status='OPEN' AND f.due_date<current_date,
   'createdAt',f.created_at,'updatedAt',f.updated_at,'replayed',receipt IS NOT NULL)
  FROM core.visit_follow_up f WHERE f.id=result);
END $$;

-- The internal task list. No message is sent by this, or by anything downstream
-- of it: an overdue action is a row a consultant reads on a screen.
CREATE FUNCTION core.visit_follow_ups(org uuid,filters jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; want_status text:=filters->>'status'; due_before date:=(filters->>'dueBefore')::date;
 owner uuid:=(filters->>'ownerStaffId')::uuid; limit_rows integer:=coalesce((filters->>'limit')::integer,100); BEGIN
 PERFORM core.visit_guard(org);
 IF limit_rows<1 OR limit_rows>200 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF want_status IS NOT NULL AND want_status NOT IN ('OPEN','DONE','CANCELLED')
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'visitId',f.visit_id,'visitPurpose',v.purpose,
   'visitState',v.state,'scheduledStart',v.scheduled_start,'title',f.title,'ownerStaffId',f.owner_staff_id,
   'ownerName',u.display_name,'dueDate',f.due_date,'status',f.status,'notes',f.notes,
   'closureReason',f.closure_reason,'closedAt',f.closed_at,'revision',f.revision,
   'overdue',f.status='OPEN' AND f.due_date<current_date) ORDER BY f.due_date,f.id),'[]'::jsonb)
  INTO result FROM (
   SELECT f.* FROM core.visit_follow_up f
    WHERE f.organization_id=org
      AND (want_status IS NULL OR f.status=want_status)
      AND (due_before IS NULL OR f.due_date<due_before)
      AND (owner IS NULL OR f.owner_staff_id=owner)
    ORDER BY f.due_date,f.id LIMIT limit_rows) f
  JOIN core.field_visit v ON v.organization_id=org AND v.id=f.visit_id
  LEFT JOIN access.staff_user u ON u.id=f.owner_staff_id;
 RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Attachments.
--
-- Three steps, because a file that has arrived is not a file that may be read:
-- begin (a row and a generated key), complete (the bytes finished; the row is
-- QUARANTINED), scan (a separate credential proves the type and the content).
-- Nothing between begin and a CLEAN verdict is downloadable.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.begin_attachment(org uuid,visit uuid,att uuid,storage text,body jsonb,
 idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); v core.field_visit; op text:=concat('attachment/',org); receipt uuid; BEGIN
 PERFORM core.visit_guard(org);
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN
  RETURN (SELECT jsonb_build_object('id',a.id,'visitId',a.visit_id,'scanStatus',a.scan_status,'replayed',true)
          FROM core.attachment a WHERE a.id=receipt);
 END IF;
 SELECT * INTO v FROM core.field_visit WHERE id=visit AND organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF v.state='CANCELLED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- The storage key is checked against the identifiers this routine was given,
 -- so no caller can name an object outside its own organization's prefix.
 IF storage<>concat('attachments/',org,'/',att,'.bin') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO core.attachment(id,organization_id,visit_id,original_name,declared_type,storage_key,uploaded_by)
 VALUES(att,org,visit,body->>'filename',body->>'declaredType',storage,actor);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id)
 VALUES(actor,op,idem,req_hash,att);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(actor,org,'ATTACHMENT_UPLOADED',att,ARRAY['attachment']);
 RETURN jsonb_build_object('id',att,'visitId',visit,'scanStatus','UPLOADING','replayed',false);
END $$;

CREATE FUNCTION core.complete_attachment(org uuid,att uuid,bytes bigint,hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core.attachment; BEGIN
 PERFORM core.visit_guard(org);
 SELECT * INTO a FROM core.attachment WHERE id=att AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF a.scan_status<>'UPLOADING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE core.attachment SET scan_status='QUARANTINED',size=bytes,checksum=hash,
  completed_at=clock_timestamp() WHERE id=a.id;
 RETURN jsonb_build_object('id',a.id,'visitId',a.visit_id,'scanStatus','QUARANTINED');
END $$;

CREATE FUNCTION core.attachment_download(org uuid,att uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core.attachment; BEGIN
 -- Re-authorized here, against the caller's access NOW: a staff member who lost
 -- visits.manage or this organization after the file was scanned cannot fetch
 -- it, and the panel's own visibility was never the permission.
 PERFORM core.visit_guard(org);
 SELECT * INTO a FROM core.attachment WHERE id=att AND organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- Anything not proven clean is indistinguishable from absent.
 IF a.scan_status<>'CLEAN' THEN RAISE EXCEPTION 'ATTACHMENT_UNAVAILABLE'; END IF;
 IF a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(access.actor(),org,'ATTACHMENT_DOWNLOADED',a.id,ARRAY['attachment']);
 RETURN jsonb_build_object('id',a.id,'storageKey',a.storage_key,'originalName',a.original_name,
  'contentType',a.content_type,'size',a.size,'checksum',encode(a.checksum,'hex'));
END $$;

-- Deletion is retention, not erasure of the record: the row survives as EXPIRED
-- audit metadata and the bytes go. There is no route that accepts a path.
CREATE FUNCTION core.delete_attachment(org uuid,att uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core.attachment; BEGIN
 PERFORM core.visit_guard(org);
 SELECT * INTO a FROM core.attachment WHERE id=att AND organization_id=org FOR UPDATE;
 IF NOT FOUND OR a.scan_status='EXPIRED' THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 UPDATE core.attachment SET scan_status='EXPIRED',expires_at=clock_timestamp() WHERE id=a.id;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(access.actor(),org,'ATTACHMENT_DELETED',a.id,ARRAY['attachment']);
 RETURN jsonb_build_object('id',a.id,'storageKey',a.storage_key,'scanStatus','EXPIRED');
END $$;

-- ---------------------------------------------------------------------------
-- 7. The scanner surface. A worker addresses a CLAIM, never an organization, a
--    visit or a storage path it chose, and it holds no table privilege at all.
-- ---------------------------------------------------------------------------
CREATE FUNCTION core.claim_attachments(limit_rows integer DEFAULT 4) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; BEGIN
 IF limit_rows<1 OR limit_rows>20 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 WITH due AS (
  SELECT id FROM core.attachment
   WHERE scan_status='QUARANTINED' AND scan_attempt<3
   ORDER BY created_at LIMIT limit_rows FOR UPDATE SKIP LOCKED),
 taken AS (
  UPDATE core.attachment a SET scan_attempt=a.scan_attempt+1 FROM due WHERE a.id=due.id
   RETURNING a.id,a.organization_id,a.storage_key,a.original_name,a.declared_type,a.size,
    a.checksum,a.scan_attempt)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'organizationId',organization_id,
   'storageKey',storage_key,'originalName',original_name,'declaredType',declared_type,'size',size,
   'checksum',encode(checksum,'hex'),'attempt',scan_attempt)),'[]'::jsonb) INTO result FROM taken;
 RETURN result;
END $$;

CREATE FUNCTION core.record_scan(att uuid,verdict text,verified_type text,code text,
 ttl interval) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a core.attachment; BEGIN
 IF verdict NOT IN ('CLEAN','REJECTED','FAILED') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF ttl IS NULL OR ttl<=interval '0' OR ttl>interval '3650 days' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO a FROM core.attachment WHERE id=att FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF a.scan_status<>'QUARANTINED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- A clean verdict without a verified content type is refused here rather than
 -- trusted: the scanner must have actually read the bytes.
 IF verdict='CLEAN' AND (verified_type IS NULL OR a.size IS NULL OR a.checksum IS NULL)
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 -- Fail-closed. An outage returns the row to QUARANTINED for a later attempt
 -- while the attempt budget lasts, and leaves it FAILED once that is spent.
 -- Neither state is downloadable, and neither invents a verified type.
 IF verdict='FAILED' THEN
  UPDATE core.attachment SET scan_status=CASE WHEN a.scan_attempt>=3 THEN 'FAILED' ELSE 'QUARANTINED' END
   WHERE id=a.id;
 ELSE
  UPDATE core.attachment SET scan_status=verdict,
   content_type=CASE WHEN verdict='CLEAN' THEN verified_type ELSE content_type END,
   rejection_code=CASE WHEN verdict='REJECTED' THEN coalesce(code,'REJECTED') ELSE NULL END,
   scanned_at=clock_timestamp(),
   expires_at=CASE WHEN verdict='CLEAN' THEN clock_timestamp()+ttl ELSE clock_timestamp() END
   WHERE id=a.id;
 END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names)
 VALUES(a.uploaded_by,a.organization_id,'ATTACHMENT_SCANNED',a.id,ARRAY['attachment','status']);
 RETURN (SELECT jsonb_build_object('id',x.id,'scanStatus',x.scan_status,'contentType',x.content_type,
   'rejectionCode',x.rejection_code,'attempt',x.scan_attempt) FROM core.attachment x WHERE x.id=a.id);
END $$;

-- Retention. Rejected, failed and orphaned uploads lose their bytes quickly; a
-- clean attachment loses them when its own retention date arrives.
CREATE FUNCTION core.expire_attachments(limit_rows integer DEFAULT 100,
 orphan_age interval DEFAULT interval '24 hours') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; BEGIN
 IF limit_rows<1 OR limit_rows>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 WITH due AS (
  SELECT id,storage_key FROM core.attachment
   WHERE scan_status<>'EXPIRED'
     AND ((scan_status='CLEAN' AND expires_at<=clock_timestamp())
       OR (scan_status IN ('REJECTED','FAILED','UPLOADING')
           AND created_at+orphan_age<=clock_timestamp()))
   ORDER BY created_at LIMIT limit_rows FOR UPDATE SKIP LOCKED),
 gone AS (
  UPDATE core.attachment a SET scan_status='EXPIRED',
    expires_at=coalesce(a.expires_at,clock_timestamp())
   FROM due WHERE a.id=due.id RETURNING a.id,a.organization_id,due.storage_key)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'organizationId',organization_id,
   'storageKey',storage_key)),'[]'::jsonb) INTO result FROM gone;
 RETURN result;
END $$;

GRANT CREATE ON SCHEMA core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='core' AND p.proname IN ('visit_guard','visit_consultants','visit_eligible_consultant',
   'visit_document','save_visit','visit_transition','visits','visit_detail','save_follow_up',
   'visit_follow_ups','begin_attachment','complete_attachment','attachment_download','delete_attachment',
   'claim_attachments','record_scan','expire_attachments') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA core FROM orgfit_access_executor;

GRANT EXECUTE ON FUNCTION core.visit_consultants(uuid),core.save_visit(uuid,uuid,bigint,jsonb,uuid,bytea),
 core.visit_transition(uuid,uuid,bigint,text,text,uuid,bytea),core.visits(uuid,jsonb),
 core.visit_detail(uuid,uuid),core.save_follow_up(uuid,uuid,uuid,bigint,jsonb,uuid,bytea),
 core.visit_follow_ups(uuid,jsonb),core.begin_attachment(uuid,uuid,uuid,text,jsonb,uuid,bytea),
 core.complete_attachment(uuid,uuid,bigint,bytea),core.attachment_download(uuid,uuid),
 core.delete_attachment(uuid,uuid) TO orgfit_staff;

-- The scanner identity. USAGE on one schema and three routines; nothing else
-- anywhere. It holds no SELECT on any table, cannot name an organization, a
-- participant, a campaign or a report, and has no CONNECT on the anonymous
-- database. Deliberately absent: core.attachment_download — the process that
-- decides a file is clean is not the process that serves it.
GRANT USAGE ON SCHEMA core TO orgfit_scanner;
GRANT EXECUTE ON FUNCTION core.claim_attachments(integer),
 core.record_scan(uuid,text,text,text,interval),
 core.expire_attachments(integer,interval) TO orgfit_scanner;
