-- ===========================================================================
-- Questionnaire department targeting.
--
-- A questionnaire already belongs to one organization
-- (instrument.questionnaire.organization_id; NULL is the global library). This
-- adds an optional, subordinate target inside that organization:
--
--   ORGANIZATION  the whole organization, exactly as before (the default, so
--                 every existing questionnaire keeps its behaviour unchanged);
--   DEPARTMENTS   one or more of that organization's own departments
--                 (core.department, 003), recorded relationally by id.
--
-- The organization is never replaced. Each target row carries the
-- questionnaire's organization and references both the questionnaire and the
-- department through (organization_id, id), so a department of another
-- organization cannot be attached even by a direct insert: the composite
-- foreign keys refuse it. The only write path is instrument.save_target, which
-- also rejects archived departments and keeps the mode and rows consistent.
-- ===========================================================================

ALTER TABLE instrument.questionnaire
 ADD COLUMN target_mode text NOT NULL DEFAULT 'ORGANIZATION' CHECK(target_mode IN ('ORGANIZATION','DEPARTMENTS')),
 ADD CONSTRAINT questionnaire_target_needs_organization CHECK(organization_id IS NOT NULL OR target_mode='ORGANIZATION'),
 ADD CONSTRAINT questionnaire_organization_id_key UNIQUE(organization_id,id);

CREATE TABLE instrument.questionnaire_department (
 organization_id uuid NOT NULL REFERENCES core.organization,
 questionnaire_id uuid NOT NULL,
 department_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user,
 PRIMARY KEY(questionnaire_id,department_id),
 FOREIGN KEY(organization_id,questionnaire_id) REFERENCES instrument.questionnaire(organization_id,id),
 FOREIGN KEY(organization_id,department_id) REFERENCES core.department(organization_id,id)
);
CREATE INDEX ON instrument.questionnaire_department(organization_id,department_id);
CREATE INDEX ON instrument.questionnaire_department(created_by);

ALTER TABLE instrument.questionnaire_department ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument.questionnaire_department FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON instrument.questionnaire_department TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON instrument.questionnaire_department TO orgfit_core_owner USING(true) WITH CHECK(true);
CREATE POLICY staff_read ON instrument.questionnaire_department TO orgfit_staff USING(instrument.can_read(organization_id));
GRANT SELECT ON instrument.questionnaire_department TO orgfit_staff;
GRANT SELECT,INSERT,UPDATE,DELETE ON instrument.questionnaire_department TO orgfit_access_executor;

-- A department that an active questionnaire targets cannot be archived out
-- from under it; the existing "in use" refusal of save_directory is reused.
CREATE FUNCTION instrument.department_target_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.status='ACTIVE' AND NEW.status<>'ACTIVE' AND EXISTS(
  SELECT 1 FROM instrument.questionnaire_department t
  JOIN instrument.questionnaire q ON q.organization_id=t.organization_id AND q.id=t.questionnaire_id
  WHERE t.organization_id=OLD.organization_id AND t.department_id=OLD.id AND q.status='ACTIVE') THEN
  RAISE EXCEPTION 'DEPARTMENT_IN_USE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER questionnaire_target_guard BEFORE UPDATE OF status ON core.department
 FOR EACH ROW EXECUTE FUNCTION instrument.department_target_guard();

-- Department choices for a questionnaire in one organization. Anyone who can
-- read that organization's questionnaires may see its department names; the
-- directory itself (participants, imports) stays behind directory.manage.
CREATE FUNCTION instrument.department_options(org uuid)
RETURNS TABLE(id uuid, code text, name_ar text, name_en text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF org IS NULL OR NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN QUERY SELECT d.id,d.code,d.name_ar,d.name_en,d.status FROM core.department d
  WHERE d.organization_id=org ORDER BY d.name_ar,d.id;
END $$;

CREATE FUNCTION instrument.save_target(org uuid,qid uuid,expected bigint,mode text,departments uuid[],idem uuid,req_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); q instrument.questionnaire; receipt access.staff_mutation; wanted uuid[]; matched integer; op text:=concat('instrument-target/',org); BEGIN
 PERFORM instrument.guard(org);
 -- The global library has no organization, so it has no departments to target.
 IF org IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF idem IS NULL OR req_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO receipt FROM access.staff_mutation WHERE staff_user_id=actor AND operation=op AND idempotency_key=idem;
 IF FOUND THEN IF receipt.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN receipt.resource_id; END IF;
 SELECT * INTO q FROM instrument.questionnaire WHERE id=qid AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF q.source='BUILTIN' OR q.status<>'ACTIVE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF expected IS NULL OR q.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 SELECT coalesce(array_agg(DISTINCT x),'{}') INTO wanted FROM unnest(coalesce(departments,'{}'::uuid[])) x;
 IF array_position(coalesce(departments,'{}'::uuid[]),NULL) IS NOT NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF mode='ORGANIZATION' THEN
  IF cardinality(wanted)<>0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 ELSIF mode='DEPARTMENTS' THEN
  IF cardinality(wanted) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
  -- Every requested department must be an active department of THIS
  -- organization. One foreign or archived identifier rejects the whole
  -- request; nothing is silently dropped.
  SELECT count(*) INTO matched FROM core.department WHERE organization_id=org AND status='ACTIVE' AND id=ANY(wanted);
  IF matched<>cardinality(wanted) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 ELSE RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 DELETE FROM instrument.questionnaire_department WHERE organization_id=org AND questionnaire_id=q.id;
 INSERT INTO instrument.questionnaire_department(organization_id,questionnaire_id,department_id,created_by)
  SELECT org,q.id,x,actor FROM unnest(wanted) x;
 UPDATE instrument.questionnaire SET target_mode=mode,revision=revision+1 WHERE id=q.id;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,q.id);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INSTRUMENT_CHANGED',q.id,ARRAY['instrument','department']);
 RETURN q.id;
END $$;

GRANT CREATE ON SCHEMA instrument TO orgfit_access_executor;
ALTER FUNCTION instrument.department_options(uuid) OWNER TO orgfit_access_executor;
ALTER FUNCTION instrument.save_target(uuid,uuid,bigint,text,uuid[],uuid,bytea) OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA instrument FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION instrument.department_options(uuid),instrument.save_target(uuid,uuid,bigint,text,uuid[],uuid,bytea),instrument.department_target_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION instrument.department_options(uuid),instrument.save_target(uuid,uuid,bigint,text,uuid[],uuid,bytea) TO orgfit_staff;
