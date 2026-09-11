CREATE SCHEMA instrument AUTHORIZATION orgfit_core_owner;
REVOKE ALL ON SCHEMA instrument FROM PUBLIC;
GRANT USAGE ON SCHEMA instrument TO orgfit_staff,orgfit_access_executor;
CREATE TABLE instrument.instrument_scope (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES core.organization,
 UNIQUE NULLS NOT DISTINCT(organization_id), UNIQUE(id,organization_id)
);
CREATE TABLE instrument.questionnaire (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id uuid NOT NULL REFERENCES instrument.instrument_scope,
 organization_id uuid REFERENCES core.organization, family_key uuid NOT NULL DEFAULT gen_random_uuid(),
 name_ar text NOT NULL, name_en text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'CUSTOM' CHECK(source IN ('CUSTOM','BUILTIN')),
 source_scope_id uuid, source_template_id uuid, status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
 revision bigint NOT NULL DEFAULT 1, created_by uuid REFERENCES access.staff_user, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(scope_id,id), FOREIGN KEY(source_scope_id,source_template_id) REFERENCES instrument.questionnaire(scope_id,id),
 CHECK((source_scope_id IS NULL)=(source_template_id IS NULL))
);
CREATE INDEX ON instrument.questionnaire(organization_id,status,id);
CREATE INDEX ON instrument.questionnaire(source_scope_id,source_template_id);
CREATE INDEX ON instrument.questionnaire(created_by);
CREATE TABLE instrument.questionnaire_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id uuid NOT NULL REFERENCES instrument.instrument_scope,
 organization_id uuid REFERENCES core.organization, questionnaire_id uuid NOT NULL,
 version_number integer NOT NULL CHECK(version_number>0), state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PUBLISHED','RETIRED')),
 revision bigint NOT NULL DEFAULT 1, metadata jsonb NOT NULL, schema_hash bytea, published_at timestamptz,
 created_by uuid REFERENCES access.staff_user, updated_by uuid REFERENCES access.staff_user,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(scope_id,id), UNIQUE(scope_id,questionnaire_id,version_number), FOREIGN KEY(scope_id,questionnaire_id) REFERENCES instrument.questionnaire(scope_id,id),
 CHECK((state='DRAFT' AND schema_hash IS NULL AND published_at IS NULL) OR (state<>'DRAFT' AND octet_length(schema_hash)=32 AND published_at IS NOT NULL)),
 CHECK(jsonb_typeof(metadata)='object' AND metadata-ARRAY['schemaVersion','locales','title','introduction','privacyText']='{}'::jsonb)
);
CREATE INDEX ON instrument.questionnaire_version(organization_id,questionnaire_id);
CREATE INDEX ON instrument.questionnaire_version(created_by);
CREATE INDEX ON instrument.questionnaire_version(updated_by);

-- Typed node payloads contain only their translated text and declarative config.
-- Scope/version/parent identity and ordering are relational, not JSON joins.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['section','dimension','question','question_option','matrix_row','matrix_column','score_definition','interpretation_band'] LOOP
 EXECUTE format('CREATE TABLE instrument.%I (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL, organization_id uuid REFERENCES core.organization, version_id uuid NOT NULL,
 stable_key uuid NOT NULL, position integer NOT NULL CHECK(position>=0), parent_id uuid, payload jsonb NOT NULL,
 UNIQUE(scope_id,version_id,id), UNIQUE(scope_id,version_id,stable_key), UNIQUE NULLS NOT DISTINCT(scope_id,version_id,parent_id,position),
 FOREIGN KEY(scope_id,version_id) REFERENCES instrument.questionnaire_version(scope_id,id),
 CHECK(jsonb_typeof(payload)=''object'' AND (payload->>''id'')::uuid=id AND (payload->>''key'')::uuid=stable_key))',t);
 EXECUTE format('CREATE INDEX ON instrument.%I(organization_id,version_id)',t);
 EXECUTE format('CREATE INDEX ON instrument.%I(scope_id,version_id,parent_id)',t);
 END LOOP;
END $$;
ALTER TABLE instrument.question ADD COLUMN dimension_id uuid;
ALTER TABLE instrument.question ADD FOREIGN KEY(scope_id,version_id,parent_id) REFERENCES instrument.section(scope_id,version_id,id);
ALTER TABLE instrument.question ADD FOREIGN KEY(scope_id,version_id,dimension_id) REFERENCES instrument.dimension(scope_id,version_id,id);
CREATE INDEX ON instrument.question(scope_id,version_id,dimension_id);
ALTER TABLE instrument.question_option ADD FOREIGN KEY(scope_id,version_id,parent_id) REFERENCES instrument.question(scope_id,version_id,id);
ALTER TABLE instrument.matrix_row ADD FOREIGN KEY(scope_id,version_id,parent_id) REFERENCES instrument.question(scope_id,version_id,id);
ALTER TABLE instrument.matrix_column ADD FOREIGN KEY(scope_id,version_id,parent_id) REFERENCES instrument.question(scope_id,version_id,id);
ALTER TABLE instrument.score_definition ADD FOREIGN KEY(scope_id,version_id,parent_id) REFERENCES instrument.dimension(scope_id,version_id,id);
ALTER TABLE instrument.interpretation_band ADD FOREIGN KEY(scope_id,version_id,parent_id) REFERENCES instrument.score_definition(scope_id,version_id,id);

CREATE FUNCTION instrument.can_read(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT access.actor() IS NOT NULL AND (org IS NULL OR access.has_org(org))
$$;
CREATE FUNCTION instrument.guard(org uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT instrument.can_read(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('instruments.manage') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF org IS NOT NULL THEN PERFORM 1 FROM core.organization WHERE id=org AND status='ACTIVE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF; END IF;
END $$;
CREATE FUNCTION instrument.scope_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM instrument.instrument_scope WHERE id=NEW.scope_id AND organization_id IS NOT DISTINCT FROM NEW.organization_id) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF TG_OP='UPDATE' AND (NEW.scope_id<>OLD.scope_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION instrument.immutable_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF OLD.state<>'DRAFT' AND NOT (OLD.state='PUBLISHED' AND NEW.state='RETIRED' AND (to_jsonb(NEW)-ARRAY['state','revision','updated_by','updated_at'])=(to_jsonb(OLD)-ARRAY['state','revision','updated_by','updated_at'])) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF NEW.questionnaire_id<>OLD.questionnaire_id OR NEW.version_number<>OLD.version_number THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON instrument.questionnaire_version FOR EACH ROW EXECUTE FUNCTION instrument.immutable_version();
CREATE FUNCTION instrument.draft_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v uuid; s uuid; BEGIN
 v:=CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END; s:=CASE WHEN TG_OP='DELETE' THEN OLD.scope_id ELSE NEW.scope_id END;
 PERFORM 1 FROM instrument.questionnaire_version WHERE id=v AND scope_id=s AND state='DRAFT' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF TG_OP='UPDATE' AND (OLD.version_id<>NEW.version_id OR OLD.id<>NEW.id) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['instrument_scope','questionnaire','questionnaire_version','section','dimension','question','question_option','matrix_row','matrix_column','score_definition','interpretation_band'] LOOP
 EXECUTE format('ALTER TABLE instrument.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE instrument.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY executor ON instrument.%I TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY migration ON instrument.%I TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY staff_read ON instrument.%I TO orgfit_staff USING(instrument.can_read(organization_id))',t);
 IF t<>'instrument_scope' THEN EXECUTE format('CREATE TRIGGER scope_check BEFORE INSERT OR UPDATE ON instrument.%I FOR EACH ROW EXECUTE FUNCTION instrument.scope_check()',t); END IF;
 IF t NOT IN ('instrument_scope','questionnaire','questionnaire_version') THEN EXECUTE format('CREATE TRIGGER draft_only BEFORE INSERT OR UPDATE OR DELETE ON instrument.%I FOR EACH ROW EXECUTE FUNCTION instrument.draft_child()',t); END IF;
 END LOOP;
END $$;
GRANT SELECT ON ALL TABLES IN SCHEMA instrument TO orgfit_staff;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA instrument TO orgfit_access_executor;

CREATE FUNCTION instrument.write_version(org uuid,qid uuid,vid uuid,expected bigint,action text,body jsonb,nodes jsonb,hash bytea,idem uuid,request_hash bytea,source_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q instrument.questionnaire; v instrument.questionnaire_version; src instrument.questionnaire_version; receipt access.staff_mutation; sid uuid; result uuid:=coalesce(vid,gen_random_uuid()); n jsonb; tab text; actor uuid:=access.actor(); op text:=concat('instrument/',org); BEGIN
 PERFORM instrument.guard(org);
 PERFORM pg_advisory_xact_lock(80400);
 IF idem IS NULL OR request_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO receipt FROM access.staff_mutation WHERE staff_user_id=actor AND operation=op AND idempotency_key=idem;
 IF FOUND THEN IF receipt.request_digest<>request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN receipt.resource_id; END IF;
 IF action NOT IN ('CREATE','SAVE','PUBLISH','RETIRE','NEW_VERSION','ARCHIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF source_id IS NOT NULL THEN
 SELECT * INTO src FROM instrument.questionnaire_version WHERE id=source_id;
 IF NOT FOUND OR NOT instrument.can_read(src.organization_id) OR (src.organization_id IS NOT NULL AND src.organization_id IS DISTINCT FROM org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 END IF;
 IF action='CREATE' THEN
 INSERT INTO instrument.instrument_scope(organization_id) VALUES(org) ON CONFLICT DO NOTHING;
 SELECT id INTO sid FROM instrument.instrument_scope WHERE organization_id IS NOT DISTINCT FROM org;
 INSERT INTO instrument.questionnaire(scope_id,organization_id,name_ar,name_en,created_by,source_scope_id,source_template_id)
 VALUES(sid,org,body->'title'->>'ar',body->'title'->>'en',actor,src.scope_id,src.questionnaire_id) RETURNING * INTO q;
 ELSE
 SELECT * INTO q FROM instrument.questionnaire WHERE id=qid AND organization_id IS NOT DISTINCT FROM org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF q.source='BUILTIN' OR q.status<>'ACTIVE' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 sid:=q.scope_id;
 END IF;
 IF action='ARCHIVE' THEN
 IF q.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 UPDATE instrument.questionnaire SET status='ARCHIVED',revision=revision+1 WHERE id=q.id; result:=q.id;
 ELSE
 IF action IN ('CREATE','NEW_VERSION') THEN
 IF action='NEW_VERSION' AND (src.id IS NULL OR src.questionnaire_id<>q.id OR src.revision IS DISTINCT FROM expected) THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 INSERT INTO instrument.questionnaire_version(id,scope_id,organization_id,questionnaire_id,version_number,metadata,created_by,updated_by)
 SELECT result,sid,org,q.id,coalesce(max(version_number),0)+1,body,actor,actor FROM instrument.questionnaire_version WHERE questionnaire_id=q.id RETURNING * INTO v;
 ELSE
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=vid AND questionnaire_id=q.id AND scope_id=sid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF v.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 END IF;
 IF action IN ('CREATE','NEW_VERSION','SAVE') THEN
 IF v.state<>'DRAFT' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 FOREACH tab IN ARRAY ARRAY['interpretation_band','score_definition','question_option','matrix_row','matrix_column','question','dimension','section'] LOOP EXECUTE format('DELETE FROM instrument.%I WHERE scope_id=$1 AND version_id=$2',tab) USING sid,result; END LOOP;
 FOREACH tab IN ARRAY ARRAY['section','dimension','question','question_option','matrix_row','matrix_column','score_definition','interpretation_band'] LOOP
 FOR n IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'table'=tab LOOP
 EXECUTE format('INSERT INTO instrument.%I(id,scope_id,organization_id,version_id,stable_key,position,parent_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',tab)
 USING (n->'payload'->>'id')::uuid,sid,org,result,(n->'payload'->>'key')::uuid,(n->>'position')::integer,(n->>'parentId')::uuid,n->'payload';
 IF tab='question' THEN UPDATE instrument.question SET dimension_id=(n->'payload'->>'dimensionId')::uuid WHERE id=(n->'payload'->>'id')::uuid; END IF;
 END LOOP;
 END LOOP;
 UPDATE instrument.questionnaire_version SET metadata=body,revision=revision+CASE WHEN action='SAVE' THEN 1 ELSE 0 END,updated_at=clock_timestamp(),updated_by=actor WHERE id=result;
 ELSIF action='PUBLISH' THEN
 IF v.state<>'DRAFT' OR octet_length(hash)<>32 OR NOT EXISTS(SELECT 1 FROM instrument.question WHERE version_id=result AND payload->>'type'<>'CONTENT') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE instrument.questionnaire_version SET state='PUBLISHED',schema_hash=hash,published_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=result;
 ELSIF action='RETIRE' THEN
 IF v.state<>'PUBLISHED' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE instrument.questionnaire_version SET state='RETIRED',revision=revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE id=result;
 END IF;
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,request_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INSTRUMENT_CHANGED',result,ARRAY['instrument']);
 RETURN result;
END $$;
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument']::text[]);
GRANT CREATE ON SCHEMA instrument TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='instrument' LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA instrument FROM orgfit_access_executor;
GRANT EXECUTE ON FUNCTION instrument.can_read(uuid),instrument.guard(uuid),instrument.write_version(uuid,uuid,uuid,bigint,text,jsonb,jsonb,bytea,uuid,bytea,uuid) TO orgfit_staff;
