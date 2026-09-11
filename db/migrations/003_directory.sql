CREATE TABLE core.department (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 code text NOT NULL CHECK(length(trim(code)) BETWEEN 1 AND 80 AND code=upper(code)),
 name_ar text NOT NULL CHECK(length(trim(name_ar)) BETWEEN 1 AND 500), name_en text CHECK(length(name_en)<=500),
 parent_department_id uuid, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,parent_department_id) REFERENCES core.department(organization_id,id), CHECK(parent_department_id<>id)
);
CREATE INDEX ON core.department(organization_id,parent_department_id);
CREATE INDEX ON core.department(organization_id,status,id);
CREATE INDEX ON core.department(created_by);
CREATE INDEX ON core.department(updated_by);
CREATE TABLE core.participant (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES core.organization,
 private_reference text NOT NULL CHECK(length(trim(private_reference)) BETWEEN 1 AND 80),
 display_name text NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 500), department_id uuid,
 position text CHECK(length(position)<=500), job_level text CHECK(length(job_level)<=500), gender text CHECK(length(gender)<=80), age_group text CHECK(length(age_group)<=80),
 years_of_service numeric CHECK(years_of_service>=0 AND years_of_service<=100),
 contact jsonb NOT NULL DEFAULT '{"schemaVersion":1}' CHECK(jsonb_typeof(contact)='object' AND contact-ARRAY['schemaVersion','email','phone']='{}'::jsonb AND octet_length(contact::text)<=4096),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 UNIQUE(organization_id,id), UNIQUE(organization_id,private_reference), FOREIGN KEY(organization_id,department_id) REFERENCES core.department(organization_id,id)
);
CREATE INDEX ON core.participant(organization_id,status,department_id,id);
CREATE INDEX ON core.participant(organization_id,display_name,id);
CREATE INDEX ON core.participant(organization_id,department_id);
CREATE INDEX ON core.participant(created_by);
CREATE INDEX ON core.participant(updated_by);
CREATE TABLE core.directory_import (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES core.organization, uploaded_by uuid NOT NULL REFERENCES access.staff_user,
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'), format text NOT NULL CHECK(format IN ('CSV','XLSX')),
 mapping jsonb NOT NULL DEFAULT '{}', state text NOT NULL DEFAULT 'UPLOADED' CHECK(state IN ('UPLOADED','VALIDATED','COMMITTED','EXPIRED')),
 validation jsonb NOT NULL DEFAULT '{}', revision bigint NOT NULL DEFAULT 1, committed_count integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours', committed_at timestamptz,
 UNIQUE(organization_id,id), CHECK((state='COMMITTED')=(committed_at IS NOT NULL))
);
CREATE INDEX ON core.directory_import(organization_id,state,expires_at);
CREATE INDEX ON core.directory_import(uploaded_by);
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import']::text[]);
GRANT INSERT,UPDATE ON core.organization TO orgfit_access_executor;
GRANT SELECT,INSERT,UPDATE ON core.department,core.participant,core.directory_import TO orgfit_access_executor;
GRANT SELECT ON core.department,core.participant,core.directory_import TO orgfit_staff;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['department','participant','directory_import'] LOOP
 EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY executor ON core.%I TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY migration ON core.%I TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY directory_read ON core.%I TO orgfit_staff USING(access.has_org(organization_id) AND access.has_capability(''directory.manage''))',t);
 END LOOP;
END $$;

-- The organization lock serializes tree changes, directory edits and import commits.
CREATE FUNCTION core.directory_guard(org uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('directory.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM core.organization WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
END $$;

CREATE FUNCTION core.save_directory(kind text,org uuid,target uuid,expected bigint,body jsonb,idem uuid,req_hash bytea,archiving boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); receipt access.staff_mutation; result uuid:=coalesce(target,gen_random_uuid()); oldrev bigint; oldstatus text; op text:=concat('directory/',kind,'/',org); parent uuid; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF kind NOT IN ('organization','department','participant') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind='organization' AND (target IS NULL OR archiving) AND NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF kind='organization' AND target IS NULL THEN PERFORM pg_advisory_xact_lock(80303);
 ELSE
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('directory.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM core.organization WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 END IF;
 IF idem IS NULL OR req_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO receipt FROM access.staff_mutation WHERE staff_user_id=actor AND operation=op AND idempotency_key=idem;
 IF FOUND THEN IF receipt.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN receipt.resource_id; END IF;
 IF NOT (kind='organization' AND target IS NULL) THEN PERFORM core.directory_guard(org); END IF;
 IF target IS NOT NULL THEN
 IF kind='organization' THEN SELECT revision,status INTO oldrev,oldstatus FROM core.organization WHERE id=target AND id=org;
 ELSIF kind='department' THEN SELECT revision,status INTO oldrev,oldstatus FROM core.department WHERE id=target AND organization_id=org;
 ELSE SELECT revision,status INTO oldrev,oldstatus FROM core.participant WHERE id=target AND organization_id=org; END IF;
 IF oldrev IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR oldrev<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 IF oldstatus<>'ACTIVE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 END IF;
 IF archiving THEN
 IF target IS NULL OR length(trim(body->>'reason')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind='organization' THEN UPDATE core.organization SET status='ARCHIVED',revision=revision+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=target;
 ELSIF kind='department' THEN
 IF EXISTS(SELECT 1 FROM core.department WHERE organization_id=org AND parent_department_id=target AND status='ACTIVE') OR EXISTS(SELECT 1 FROM core.participant WHERE organization_id=org AND department_id=target AND status='ACTIVE') THEN RAISE EXCEPTION 'DEPARTMENT_IN_USE'; END IF;
 UPDATE core.department SET status='ARCHIVED',revision=revision+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=target AND organization_id=org;
 ELSE UPDATE core.participant SET status='ARCHIVED',revision=revision+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=target AND organization_id=org; END IF;
 ELSIF kind='organization' THEN
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=body->>'timezone') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO core.organization(id,code,name_ar,name_en,industry,timezone,notes,contact,created_by,updated_by)
 VALUES(result,body->>'code',body->>'nameAr',body->>'nameEn',body->>'industry',body->>'timezone',body->>'notes',coalesce(body->'contact','{"schemaVersion":1}'),actor,actor)
 ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,industry=EXCLUDED.industry,timezone=EXCLUDED.timezone,notes=EXCLUDED.notes,contact=EXCLUDED.contact,revision=core.organization.revision+1,updated_by=actor,updated_at=clock_timestamp();
 ELSIF kind='department' THEN
 parent:=(body->>'parentDepartmentId')::uuid;
 IF parent IS NOT NULL THEN
 IF NOT EXISTS(SELECT 1 FROM core.department WHERE organization_id=org AND id=parent AND status='ACTIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF EXISTS(WITH RECURSIVE ancestors AS (SELECT id,parent_department_id FROM core.department WHERE organization_id=org AND id=parent UNION SELECT d.id,d.parent_department_id FROM core.department d JOIN ancestors a ON d.id=a.parent_department_id WHERE d.organization_id=org) SELECT 1 FROM ancestors WHERE id=result) THEN RAISE EXCEPTION 'DEPARTMENT_CYCLE'; END IF;
 END IF;
 INSERT INTO core.department(id,organization_id,code,name_ar,name_en,parent_department_id,created_by,updated_by)
 VALUES(result,org,body->>'code',body->>'nameAr',body->>'nameEn',parent,actor,actor)
 ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,parent_department_id=EXCLUDED.parent_department_id,revision=core.department.revision+1,updated_by=actor,updated_at=clock_timestamp();
 ELSE
 parent:=(body->>'departmentId')::uuid;
 IF parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.department WHERE organization_id=org AND id=parent AND status='ACTIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 INSERT INTO core.participant(id,organization_id,private_reference,display_name,department_id,position,job_level,gender,age_group,years_of_service,contact,created_by,updated_by)
 VALUES(result,org,body->>'privateReference',body->>'displayName',parent,body->>'position',body->>'jobLevel',body->>'gender',body->>'ageGroup',(body->>'yearsOfService')::numeric,coalesce(body->'contact','{"schemaVersion":1}'),actor,actor)
 ON CONFLICT(id) DO UPDATE SET private_reference=EXCLUDED.private_reference,display_name=EXCLUDED.display_name,department_id=EXCLUDED.department_id,position=EXCLUDED.position,job_level=EXCLUDED.job_level,gender=EXCLUDED.gender,age_group=EXCLUDED.age_group,years_of_service=EXCLUDED.years_of_service,contact=EXCLUDED.contact,revision=core.participant.revision+1,updated_by=actor,updated_at=clock_timestamp();
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,CASE WHEN kind='organization' THEN result ELSE org END,'DIRECTORY_CHANGED',result,ARRAY[kind]);
 RETURN result;
END $$;

CREATE FUNCTION core.save_import(org uuid,target uuid,expected bigint,body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old core.directory_import; BEGIN
 PERFORM core.directory_guard(org);
 SELECT * INTO old FROM core.directory_import WHERE organization_id=org AND id=target FOR UPDATE;
 IF NOT FOUND THEN
 IF expected IS NOT NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO core.directory_import(id,organization_id,uploaded_by,source_digest,format) VALUES(target,org,access.actor(),body->>'sourceDigest',body->>'format');
 ELSE
 IF old.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 IF old.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
 IF old.state='COMMITTED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF body->>'state'='VALIDATED' THEN
 UPDATE core.directory_import SET mapping=body->'mapping',validation=body->'validation',state='VALIDATED',revision=revision+1 WHERE organization_id=org AND id=target;
 ELSIF body->>'state'='COMMITTED' AND old.state='VALIDATED' THEN
 UPDATE core.directory_import SET state='COMMITTED',committed_at=clock_timestamp(),committed_count=(body->>'count')::integer,revision=revision+1 WHERE organization_id=org AND id=target;
 ELSE RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(access.actor(),org,'IMPORT_CHANGED',target,ARRAY['import']);
END $$;
CREATE FUNCTION core.import_download_audit(org uuid,target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('directory.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.directory_import WHERE organization_id=org AND id=target AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(access.actor(),org,'IMPORT_ERRORS_DOWNLOADED',target,ARRAY['import']);
END $$;
GRANT CREATE ON SCHEMA core TO orgfit_access_executor;
ALTER FUNCTION core.directory_guard(uuid) OWNER TO orgfit_access_executor;
ALTER FUNCTION core.save_directory(text,uuid,uuid,bigint,jsonb,uuid,bytea,boolean) OWNER TO orgfit_access_executor;
ALTER FUNCTION core.save_import(uuid,uuid,bigint,jsonb) OWNER TO orgfit_access_executor;
ALTER FUNCTION core.import_download_audit(uuid,uuid) OWNER TO orgfit_access_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO orgfit_staff;
REVOKE CREATE ON SCHEMA core FROM orgfit_access_executor;
