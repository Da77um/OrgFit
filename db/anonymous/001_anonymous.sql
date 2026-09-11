-- The finalized anonymous answer store. A SEPARATE DATABASE with separate
-- credentials. No staff, auth or report credential may connect here; the only
-- login granted anything is orgfit_processor.
--
-- What deliberately does NOT exist in any table below:
--   participant, invitation, token, token digest, draft handle, envelope id,
--   session, IP address, user agent, request id, correlation id, staff actor,
--   client timestamp, per-response created_at, submission instant, answer
--   checksum, or any other identity-derived or transport-derived value.
-- The ONLY time column in this schema is the batch marker's commit instant,
-- which is campaign-level and does not distinguish an individual.
--
-- This is database separation plus metadata stripping. It is NOT a claim of
-- cryptographic anonymity; see docs/orgfit/respondent.md and blueprint 1.3.

CREATE SCHEMA anonymous AUTHORIZATION orgfit_anon_owner;
REVOKE ALL ON SCHEMA anonymous FROM PUBLIC;

CREATE TABLE anonymous.anonymous_campaign_manifest (
 id uuid PRIMARY KEY,                       -- equals the core campaign id
 organization_id uuid NOT NULL,
 questionnaire_version_id uuid NOT NULL,
 instrument_snapshot jsonb NOT NULL CHECK(jsonb_typeof(instrument_snapshot)='object'),
 instrument_hash bytea NOT NULL CHECK(octet_length(instrument_hash)=32),
 policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
 manifest_hash bytea NOT NULL CHECK(octet_length(manifest_hash)=32),
 threshold integer NOT NULL CHECK(threshold>=5),
 UNIQUE(organization_id,id), UNIQUE(organization_id,id,questionnaire_version_id)
);

CREATE TABLE anonymous.anonymous_group (
 id uuid PRIMARY KEY,                       -- equals the frozen report_group id
 organization_id uuid NOT NULL, campaign_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('COMPANY','DEPARTMENT','OTHER')),
 label jsonb NOT NULL CHECK(jsonb_typeof(label)='object' AND octet_length(label::text)<=2048),
 UNIQUE(organization_id,campaign_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES anonymous.anonymous_campaign_manifest(organization_id,id)
);
CREATE UNIQUE INDEX anonymous_group_company ON anonymous.anonymous_group(organization_id,campaign_id) WHERE kind='COMPANY';

CREATE TABLE anonymous.anonymous_response (
 id uuid PRIMARY KEY,                       -- fresh random, unrelated to any input
 organization_id uuid NOT NULL, campaign_id uuid NOT NULL,
 questionnaire_version_id uuid NOT NULL, report_group_id uuid NOT NULL,
 validity text NOT NULL DEFAULT 'VALID' CHECK(validity='VALID'),
 UNIQUE(organization_id,campaign_id,id),
 FOREIGN KEY(organization_id,campaign_id,questionnaire_version_id)
  REFERENCES anonymous.anonymous_campaign_manifest(organization_id,id,questionnaire_version_id),
 FOREIGN KEY(organization_id,campaign_id,report_group_id) REFERENCES anonymous.anonymous_group(organization_id,campaign_id,id)
);
CREATE INDEX ON anonymous.anonymous_response(organization_id,campaign_id,report_group_id,id);
-- A COMPANY group is computed over the whole set; it is never an individual's
-- group. A row CHECK cannot inspect the group row, so a trigger enforces it.
CREATE FUNCTION anonymous.response_group_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (SELECT kind FROM anonymous.anonymous_group WHERE id=NEW.report_group_id)='COMPANY' THEN
 RAISE EXCEPTION 'COMPANY_GROUP_NOT_ASSIGNABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER response_group BEFORE INSERT OR UPDATE ON anonymous.anonymous_response
 FOR EACH ROW EXECUTE FUNCTION anonymous.response_group_check();

CREATE TABLE anonymous.anonymous_answer (
 organization_id uuid NOT NULL, campaign_id uuid NOT NULL, response_id uuid NOT NULL,
 question_key uuid NOT NULL,
 typed_value jsonb NOT NULL CHECK(jsonb_typeof(typed_value)='object' AND octet_length(typed_value::text)<=65536),
 validity text NOT NULL DEFAULT 'VALID' CHECK(validity='VALID'),
 PRIMARY KEY(organization_id,campaign_id,response_id,question_key),
 FOREIGN KEY(organization_id,campaign_id,response_id) REFERENCES anonymous.anonymous_response(organization_id,campaign_id,id)
);

CREATE TABLE anonymous.response_score (
 organization_id uuid NOT NULL, campaign_id uuid NOT NULL, response_id uuid NOT NULL,
 definition_key uuid NOT NULL,  -- dimension stable key; the nil UUID means OVERALL
 engine_version text NOT NULL CHECK(length(engine_version) BETWEEN 1 AND 40),
 raw_value numeric, normalized_value numeric CHECK(normalized_value IS NULL OR (normalized_value>=0 AND normalized_value<=100)),
 coverage numeric NOT NULL CHECK(coverage>=0 AND coverage<=1),
 status text NOT NULL CHECK(status IN ('VALID','INSUFFICIENT','UNSCORED')),
 PRIMARY KEY(organization_id,campaign_id,response_id,definition_key,engine_version),
 FOREIGN KEY(organization_id,campaign_id,response_id) REFERENCES anonymous.anonymous_response(organization_id,campaign_id,id),
 CHECK(status='VALID' OR (raw_value IS NULL AND normalized_value IS NULL)),
 CHECK(status<>'VALID' OR normalized_value IS NOT NULL)
);

-- The atomic publication marker. Its UNIQUE(campaign) is the final duplicate
-- guard: a second worker delivering the same batch cannot append a second copy.
CREATE TABLE anonymous.processed_batch (
 id uuid PRIMARY KEY,                       -- equals the core batch id
 organization_id uuid NOT NULL, campaign_id uuid NOT NULL,
 response_count integer NOT NULL CHECK(response_count>=5),
 manifest_hash bytea NOT NULL CHECK(octet_length(manifest_hash)=32),
 engine_version text NOT NULL CHECK(length(engine_version) BETWEEN 1 AND 40),
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,campaign_id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES anonymous.anonymous_campaign_manifest(organization_id,id)
);

-- Whole-campaign purge only. There is no per-person deletion path here, because
-- there is nothing here that identifies a person to delete.
CREATE FUNCTION anonymous.purge_campaign(org uuid,cid uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 DELETE FROM anonymous.processed_batch WHERE organization_id=org AND campaign_id=cid;
 DELETE FROM anonymous.response_score WHERE organization_id=org AND campaign_id=cid;
 DELETE FROM anonymous.anonymous_answer WHERE organization_id=org AND campaign_id=cid;
 DELETE FROM anonymous.anonymous_response WHERE organization_id=org AND campaign_id=cid;
 GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM anonymous.anonymous_group WHERE organization_id=org AND campaign_id=cid;
 DELETE FROM anonymous.anonymous_campaign_manifest WHERE organization_id=org AND id=cid;
 RETURN n;
END $$;

GRANT USAGE ON SCHEMA anonymous TO orgfit_processor;
GRANT SELECT,INSERT ON anonymous.anonymous_campaign_manifest,anonymous.anonymous_group,
 anonymous.anonymous_response,anonymous.anonymous_answer,anonymous.response_score,
 anonymous.processed_batch TO orgfit_processor;
GRANT EXECUTE ON FUNCTION anonymous.purge_campaign(uuid,uuid) TO orgfit_anon_owner;
-- Deliberately absent: UPDATE and DELETE for the processor. Committed anonymous
-- content is immutable to the only credential that can reach it; whole-campaign
-- retention purge is a separate custodial operation.
