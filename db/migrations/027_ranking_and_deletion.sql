-- ===========================================================================
-- 027: ranking questions (D-185) and safe deletion of questionnaires and
-- companies (D-187, D-188). Forward only; no earlier migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 (D-185). A new question type, RANKING: the respondent puts every
-- option in order of preference. It is UNSCORED; the scoring engine stays
-- pinned at 1.0.0 and instrument.scoring_bounds is untouched.
--
-- instrument.publish_check() is replaced with a copy of migration 006's
-- definition that differs ONLY on the three lines naming RANKING:
--   1. RANKING joins the list of accepted question kinds;
--   2. it is an option-bearing kind (at least two options), and a ranking
--      option may not carry a score;
--   3. it is ineligible for scoring, beside SHORT_TEXT/LONG_TEXT/DATE/CONTENT.
-- Owner, grants and the trigger are unchanged (CREATE OR REPLACE keeps them).
-- The anonymous store needs nothing: anonymous_answer.typed_value is free
-- jsonb, and a ranking is stored as {"type":"RANKING","optionIds":[...]}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION instrument.publish_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n record; q jsonb; cfg jsonb; kind text; allowed text[]; locales jsonb:=NEW.metadata->'locales'; count_options integer; count_rows integer; needed integer; dim record; score record; band record; last_upper numeric; total integer:=0; BEGIN
 IF NEW.state<>'PUBLISHED' OR OLD.state<>'DRAFT' THEN RETURN NEW; END IF;
 IF NEW.metadata->>'schemaVersion' IS DISTINCT FROM '1' OR locales NOT IN ('["ar"]'::jsonb,'["ar","en"]'::jsonb,'["en","ar"]'::jsonb) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM instrument.assert_text_tree(NEW.metadata);
 PERFORM instrument.translated(NEW.metadata->'title',locales,true);
 PERFORM instrument.translated(NEW.metadata->'introduction',locales,false);
 PERFORM instrument.translated(NEW.metadata->'privacyText',locales,true);
 IF EXISTS(SELECT stable_key FROM (
 SELECT stable_key FROM instrument.section WHERE version_id=NEW.id UNION ALL SELECT stable_key FROM instrument.question WHERE version_id=NEW.id UNION ALL SELECT stable_key FROM instrument.dimension WHERE version_id=NEW.id UNION ALL SELECT stable_key FROM instrument.question_option WHERE version_id=NEW.id UNION ALL SELECT stable_key FROM instrument.matrix_row WHERE version_id=NEW.id UNION ALL SELECT stable_key FROM instrument.matrix_column WHERE version_id=NEW.id UNION ALL SELECT stable_key FROM instrument.interpretation_band WHERE version_id=NEW.id
 ) keys GROUP BY stable_key HAVING count(*)>1) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 FOR n IN SELECT payload FROM instrument.section WHERE version_id=NEW.id LOOP
 IF n.payload-ARRAY['id','key','title','content']<>'{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM instrument.assert_text_tree(n.payload); PERFORM instrument.translated(n.payload->'title',locales,true); PERFORM instrument.translated(n.payload->'content',locales,false);
 END LOOP;
 FOR n IN SELECT * FROM instrument.question WHERE version_id=NEW.id LOOP
 q:=n.payload; kind:=q->>'type'; cfg:=q->'validation';
 IF kind IS NULL OR kind NOT IN ('SHORT_TEXT','LONG_TEXT','MULTIPLE_CHOICE','CHECKBOXES','DROPDOWN','YES_NO','RATING_5','RATING_10','MATRIX','NUMBER','DATE','CONTENT','RANKING') OR q-ARRAY['id','key','type','prompt','help','required','dimensionId','validation','scoring']<>'{}'::jsonb OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(cfg) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM instrument.assert_text_tree(q); PERFORM instrument.translated(q->'prompt',locales,true); PERFORM instrument.translated(q->'help',locales,false);
 allowed:=CASE WHEN kind IN ('SHORT_TEXT','LONG_TEXT') THEN ARRAY['maxLength'] WHEN kind='CHECKBOXES' THEN ARRAY['minSelections','maxSelections'] WHEN kind='NUMBER' THEN ARRAY['min','max','precision'] WHEN kind='DATE' THEN ARRAY['minDate','maxDate'] ELSE ARRAY[]::text[] END;
 IF cfg-allowed<>'{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF cfg ? 'maxLength' AND ((cfg->>'maxLength')::integer NOT BETWEEN 1 AND 10000) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF cfg ? 'precision' AND ((cfg->>'precision')::integer NOT BETWEEN 0 AND 6) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF cfg ? 'min' AND cfg ? 'max' AND (cfg->>'min')::numeric >= (cfg->>'max')::numeric THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF cfg ? 'minDate' THEN PERFORM (cfg->>'minDate')::date; END IF;
 IF cfg ? 'maxDate' THEN PERFORM (cfg->>'maxDate')::date; END IF;
 IF cfg ? 'minDate' AND cfg ? 'maxDate' AND (cfg->>'minDate')::date>(cfg->>'maxDate')::date THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT count(*) INTO count_options FROM instrument.question_option WHERE version_id=NEW.id AND parent_id=n.id;
 SELECT count(*) INTO count_rows FROM instrument.matrix_row WHERE version_id=NEW.id AND parent_id=n.id;
 IF kind IN ('MULTIPLE_CHOICE','CHECKBOXES','DROPDOWN','YES_NO','RANKING') THEN IF count_options<2 OR (kind='YES_NO' AND count_options<>2) OR (kind='RANKING' AND EXISTS(SELECT 1 FROM instrument.question_option WHERE version_id=NEW.id AND parent_id=n.id AND payload->>'score' IS NOT NULL)) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 ELSIF count_options<>0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind='MATRIX' THEN
 IF count_rows<1 OR (SELECT count(*) FROM instrument.matrix_column WHERE version_id=NEW.id AND parent_id=n.id)<2 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 total:=total+count_rows;
 ELSE
 IF count_rows<>0 OR EXISTS(SELECT 1 FROM instrument.matrix_column WHERE version_id=NEW.id AND parent_id=n.id) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind<>'CONTENT' THEN total:=total+1; END IF;
 END IF;
 IF kind='YES_NO' AND EXISTS(SELECT 1 FROM instrument.question_option WHERE version_id=NEW.id AND parent_id=n.id AND (payload->>'score') IS DISTINCT FROM position::text) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind='CHECKBOXES' AND (coalesce((cfg->>'minSelections')::integer,0)<CASE WHEN (q->>'required')::boolean THEN 1 ELSE 0 END OR coalesce((cfg->>'maxSelections')::integer,count_options)>count_options OR coalesce((cfg->>'minSelections')::integer,0)>coalesce((cfg->>'maxSelections')::integer,count_options)) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 cfg:=q->'scoring';
 IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg-ARRAY['enabled','reverse','weight','mode']<>'{}'::jsonb OR jsonb_typeof(cfg->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(cfg->'reverse') IS DISTINCT FROM 'boolean' OR coalesce((cfg->>'weight')::numeric,0)<=0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF n.dimension_id IS DISTINCT FROM (q->>'dimensionId')::uuid THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (cfg->>'enabled')::boolean THEN
 IF kind IN ('SHORT_TEXT','LONG_TEXT','DATE','CONTENT','RANKING') OR n.dimension_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (kind='CHECKBOXES' AND cfg->>'mode' NOT IN ('OPTION_SUM','SELECTED_PERCENTAGE')) OR (kind<>'CHECKBOXES' AND cfg->>'mode'<>'VALUE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind='NUMBER' AND NOT (q->'validation' ?& ARRAY['min','max']) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind IN ('MULTIPLE_CHOICE','CHECKBOXES','DROPDOWN','YES_NO','MATRIX') AND cfg->>'mode'<>'SELECTED_PERCENTAGE' THEN
 IF (SELECT count(DISTINCT (payload->>'score')::numeric) FROM (SELECT payload FROM instrument.question_option WHERE version_id=NEW.id AND parent_id=n.id UNION ALL SELECT payload FROM instrument.matrix_column WHERE version_id=NEW.id AND parent_id=n.id) opts)<2 OR EXISTS(SELECT 1 FROM (SELECT payload FROM instrument.question_option WHERE version_id=NEW.id AND parent_id=n.id UNION ALL SELECT payload FROM instrument.matrix_column WHERE version_id=NEW.id AND parent_id=n.id) opts WHERE payload->>'score' IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END IF;
 ELSIF n.dimension_id IS NOT NULL OR (cfg->>'reverse')::boolean OR cfg->>'mode'<>'VALUE' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF kind='CONTENT' AND (q->>'required')::boolean THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END LOOP;
 IF total NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 FOR n IN SELECT payload,'option' kind FROM instrument.question_option WHERE version_id=NEW.id UNION ALL SELECT payload,'option' FROM instrument.matrix_column WHERE version_id=NEW.id UNION ALL SELECT payload,'row' FROM instrument.matrix_row WHERE version_id=NEW.id LOOP
 IF n.payload-(CASE WHEN n.kind='row' THEN ARRAY['id','key','label','weight'] ELSE ARRAY['id','key','label','score'] END)<>'{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM instrument.assert_text_tree(n.payload); PERFORM instrument.translated(n.payload->'label',locales,true);
 IF n.kind='row' AND coalesce((n.payload->>'weight')::numeric,0)<=0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END LOOP;
 FOR dim IN SELECT * FROM instrument.dimension WHERE version_id=NEW.id LOOP
 IF dim.payload-ARRAY['id','key','name','description','direction']<>'{}'::jsonb OR dim.payload->>'direction' NOT IN ('HIGH_GOOD','HIGH_RISK') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM instrument.assert_text_tree(dim.payload); PERFORM instrument.translated(dim.payload->'name',locales,true); PERFORM instrument.translated(dim.payload->'description',locales,false);
 SELECT * INTO score FROM instrument.score_definition WHERE version_id=NEW.id AND parent_id=dim.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 cfg:=score.payload;
 IF cfg-ARRAY['id','key','mode','coverage','denominator','target']<>'{}'::jsonb OR cfg->>'target'<>'DIMENSION' OR cfg->>'mode' NOT IN ('AVERAGE','WEIGHTED_AVERAGE','SUM','PERCENTAGE') OR coalesce((cfg->>'coverage')::numeric,0)<=0 OR (cfg->>'coverage')::numeric>1 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT count(*) INTO needed FROM instrument.question WHERE version_id=NEW.id AND dimension_id=dim.id AND (payload->'scoring'->>'enabled')::boolean;
 IF needed=0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF cfg->>'mode' IN ('SUM','PERCENTAGE') AND ((cfg->>'coverage')::numeric<>1 OR EXISTS(SELECT 1 FROM instrument.question WHERE version_id=NEW.id AND dimension_id=dim.id AND NOT (payload->>'required')::boolean)) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF cfg->>'mode'='PERCENTAGE' THEN
 IF coalesce((cfg->>'denominator')::numeric,0)<>needed OR EXISTS(SELECT 1 FROM instrument.question WHERE version_id=NEW.id AND dimension_id=dim.id AND (payload->>'type'<>'YES_NO' OR (payload->'scoring'->>'reverse')::boolean)) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 ELSIF cfg->>'denominator' IS NOT NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM instrument.score_definition WHERE version_id=NEW.id AND parent_id IS NULL)<>1 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 FOR score IN SELECT * FROM instrument.score_definition WHERE version_id=NEW.id LOOP
 cfg:=score.payload;
 IF score.parent_id IS NULL THEN
 IF cfg-ARRAY['id','key','enabled','direction','inputs','target']<>'{}'::jsonb OR cfg->>'target'<>'OVERALL' OR cfg->>'direction' NOT IN ('HIGH_GOOD','HIGH_RISK') OR jsonb_typeof(cfg->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(cfg->'inputs') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (cfg->>'enabled')::boolean THEN
 IF jsonb_array_length(cfg->'inputs')=0 OR (SELECT count(DISTINCT value->>'dimensionId') FROM jsonb_array_elements(cfg->'inputs'))<>jsonb_array_length(cfg->'inputs') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(cfg->'inputs') LOOP
 SELECT * INTO dim FROM instrument.dimension WHERE version_id=NEW.id AND id=(q->>'dimensionId')::uuid;
 IF NOT FOUND OR q-ARRAY['dimensionId','weight','invert']<>'{}'::jsonb OR coalesce((q->>'weight')::numeric,0)<=0 OR jsonb_typeof(q->'invert') IS DISTINCT FROM 'boolean' OR ((dim.payload->>'direction'<>cfg->>'direction') IS DISTINCT FROM (q->>'invert')::boolean) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END LOOP;
 ELSIF jsonb_array_length(cfg->'inputs')<>0 OR EXISTS(SELECT 1 FROM instrument.interpretation_band WHERE version_id=NEW.id AND parent_id=score.id) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END IF;
 last_upper:=0;
 FOR band IN SELECT * FROM instrument.interpretation_band WHERE version_id=NEW.id AND parent_id=score.id ORDER BY position LOOP
 q:=band.payload;
 IF q-ARRAY['id','key','lower','upper','label','severity','semantic']<>'{}'::jsonb OR q->>'severity' NOT IN ('NONE','LOW','MODERATE','HIGH','CRITICAL') OR q->>'semantic' NOT IN ('HEALTH','RISK','NEUTRAL') OR (q->>'lower')::numeric<>last_upper OR (q->>'upper')::numeric<=(q->>'lower')::numeric THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 PERFORM instrument.translated(q->'label',locales,true); PERFORM instrument.assert_text_tree(q); last_upper:=(q->>'upper')::numeric;
 END LOOP;
 IF last_upper<>0 AND last_upper<>100 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Part 3 (D-187, D-188). Deleting a questionnaire, and deleting a company,
-- only where nothing can depend on the data. Archive stays the default.
-- ---------------------------------------------------------------------------

-- 3.1 Two new audit actions. Like INSTRUMENT_CHANGED they carry no content:
-- no title, no question text, no organization name.
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED','REPORT_REQUESTED','REPORT_DOWNLOADED','PARTICIPATION_EXPORT_CREATED','PARTICIPATION_EXPORT_DOWNLOADED','VISIT_CHANGED','VISIT_TRANSITIONED','VISIT_AMENDED','FOLLOW_UP_CHANGED','ATTACHMENT_UPLOADED','ATTACHMENT_SCANNED','ATTACHMENT_DOWNLOADED','ATTACHMENT_DELETED','INVITATION_CREATED','INVITATION_ACCEPTED','PASSWORD_SET','SETTINGS_CHANGED','AUDIT_EXPORTED','RELEASE_REVOKED','INTAKE_ERASED','MESSAGE_LINK_ISSUED','MESSAGE_LINK_REVOKED','INSTRUMENT_DELETED','ORGANIZATION_DELETED'));

-- 3.2 The audit trail outlives a deleted company. ops.audit_log.organization_id
-- referenced core.organization with no ON DELETE rule (001), which would make
-- the delete fail. Only that foreign key is dropped: the column and every value
-- stay, so old audit rows keep pointing at the deleted organization's id. No
-- audit row is deleted, nulled or rewritten anywhere in this migration. (The
-- audit screens already LEFT JOIN the organization, so such rows still list.)
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_organization_id_fkey;

-- 3.3 A deleted company's participants are personal data: a backup restore must
-- not bring them back. New tombstone class ORGANIZATION (subject = the
-- organization id), re-applied by the restore replay (src/operations.ts), the
-- way 022 and 025 added theirs.
ALTER TABLE ops.deletion_tombstone DROP CONSTRAINT deletion_tombstone_class_check;
ALTER TABLE ops.deletion_tombstone ADD CONSTRAINT deletion_tombstone_class_check
 CHECK(class IN ('ATTACHMENT','REPORT_ARTIFACT','PRIVATE_EXPORT','CAMPAIGN_INTAKE','CAMPAIGN_KEY','ANONYMOUS_CAMPAIGN','RELEASE_REVOCATION','MESSAGE_LINK','ORGANIZATION'));

-- 3.4 Version immutability, with one narrow exception for deletion.
-- immutable_version() refused every DELETE (005). A DELETE now passes only
-- when the transaction-local marker orgfit.deleting_questionnaire names this
-- version's questionnaire, which only instrument.remove_questionnaire() sets
-- (called only by the definer routines below), AND no assessment round or
-- campaign references the version. The UPDATE rules are unchanged from 005.
-- Staff hold no DELETE privilege on any instrument table, so setting the marker
-- by hand achieves nothing for them; a version used by a campaign stays
-- undeletable even with the marker on (the campaign's foreign key refuses too).
CREATE OR REPLACE FUNCTION instrument.immutable_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
 IF nullif(current_setting('orgfit.deleting_questionnaire',true),'') IS DISTINCT FROM OLD.questionnaire_id::text
  OR EXISTS(SELECT 1 FROM core.assessment_round r WHERE r.instrument_scope_id=OLD.scope_id AND r.questionnaire_version_id=OLD.id)
  OR EXISTS(SELECT 1 FROM core.campaign c WHERE c.instrument_scope_id=OLD.scope_id AND c.version_id=OLD.id)
 THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN OLD;
 END IF;
 IF OLD.state<>'DRAFT' AND NOT (OLD.state='PUBLISHED' AND NEW.state='RETIRED' AND (to_jsonb(NEW)-ARRAY['state','revision','updated_by','updated_at'])=(to_jsonb(OLD)-ARRAY['state','revision','updated_by','updated_at'])) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF NEW.questionnaire_id<>OLD.questionnaire_id OR NEW.version_number<>OLD.version_number THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 RETURN NEW;
END $$;

-- The child-node guard (005) refused to touch a published version's nodes. The
-- same marker lets the removal delete them; inserts and updates are unchanged.
CREATE OR REPLACE FUNCTION instrument.draft_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v uuid; s uuid; BEGIN
 v:=CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END; s:=CASE WHEN TG_OP='DELETE' THEN OLD.scope_id ELSE NEW.scope_id END;
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM instrument.questionnaire_version WHERE id=v AND scope_id=s
  AND questionnaire_id::text=nullif(current_setting('orgfit.deleting_questionnaire',true),'')) THEN RETURN OLD; END IF;
 PERFORM 1 FROM instrument.questionnaire_version WHERE id=v AND scope_id=s AND state='DRAFT' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF TG_OP='UPDATE' AND (OLD.version_id<>NEW.version_id OR OLD.id<>NEW.id) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

-- 3.5 Why a questionnaire cannot be deleted, or NULL (internal; no runtime
-- role may call it). Callers hold the locks write_version takes. A custom
-- questionnaire is deletable only when none of its versions, in any state,
-- was ever used: no round, no campaign; no series uses its family key unless
-- another questionnaire of that organization (or the global library) shares
-- the key; and no questionnaire was cloned from it. Lineage is never rewritten.
CREATE FUNCTION instrument.delete_blocker(qid uuid) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE q instrument.questionnaire; BEGIN
 SELECT * INTO q FROM instrument.questionnaire WHERE id=qid;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 IF q.source='BUILTIN' THEN RETURN 'BUILTIN'; END IF;
 IF EXISTS(SELECT 1 FROM core.assessment_round r JOIN instrument.questionnaire_version v ON v.scope_id=r.instrument_scope_id AND v.id=r.questionnaire_version_id WHERE v.questionnaire_id=q.id) THEN RETURN 'USED_IN_ROUND'; END IF;
 IF EXISTS(SELECT 1 FROM core.campaign c JOIN instrument.questionnaire_version v ON v.scope_id=c.instrument_scope_id AND v.id=c.version_id WHERE v.questionnaire_id=q.id) THEN RETURN 'USED_IN_CAMPAIGN'; END IF;
 IF EXISTS(SELECT 1 FROM core.assessment_series s WHERE s.questionnaire_family_id=q.family_key
  AND (q.organization_id IS NULL OR s.organization_id=q.organization_id)
  AND NOT EXISTS(SELECT 1 FROM instrument.questionnaire o WHERE o.id<>q.id AND o.family_key=q.family_key
   AND (o.organization_id=s.organization_id OR o.organization_id IS NULL))) THEN RETURN 'SERIES_FAMILY'; END IF;
 IF EXISTS(SELECT 1 FROM instrument.questionnaire c WHERE c.source_scope_id=q.scope_id AND c.source_template_id=q.id) THEN RETURN 'CLONED_FROM'; END IF;
 RETURN NULL;
END $$;

-- Removes one questionnaire with every version, node and department target
-- (internal). Node tables go in reverse dependency order, as in write_version.
-- The marker is set only for this questionnaire and cleared afterwards.
CREATE FUNCTION instrument.remove_questionnaire(qid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tabs text[]:=instrument.node_tables(); i integer; BEGIN
 PERFORM set_config('orgfit.deleting_questionnaire',qid::text,true);
 FOR i IN REVERSE array_length(tabs,1)..1 LOOP
 EXECUTE format('DELETE FROM instrument.%I t USING instrument.questionnaire_version v WHERE t.scope_id=v.scope_id AND t.version_id=v.id AND v.questionnaire_id=$1',tabs[i]) USING qid;
 END LOOP;
 DELETE FROM instrument.questionnaire_department WHERE questionnaire_id=qid;
 DELETE FROM instrument.questionnaire_version WHERE questionnaire_id=qid;
 DELETE FROM instrument.questionnaire WHERE id=qid;
 PERFORM set_config('orgfit.deleting_questionnaire','',true);
END $$;

-- 3.6 Staff: which of these questionnaires could be deleted now, and if not,
-- why (fixed reason codes, no content). The library list and detail show
-- Delete only where the reason is NULL; the delete itself re-checks.
CREATE FUNCTION instrument.delete_checks(org uuid,ids uuid[]) RETURNS TABLE(id uuid,reason text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT q.id,instrument.delete_blocker(q.id) FROM instrument.questionnaire q
 WHERE instrument.can_read(org) AND q.organization_id IS NOT DISTINCT FROM org AND q.id=ANY(ids)
$$;

-- Staff: delete one questionnaire. The guard and capability check, the advisory
-- lock and row locks, the revision check and the idempotency receipt are those
-- of write_version (same operation name, so a key reused across a save and a
-- delete is a conflict). A refusal is STATE_CONFLICT with the reason in DETAIL.
-- One INSTRUMENT_DELETED audit row, with no content. No reason is collected.
CREATE FUNCTION instrument.delete_questionnaire(org uuid,qid uuid,expected bigint,idem uuid,request_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q instrument.questionnaire; receipt access.staff_mutation; actor uuid:=access.actor(); op text:=concat('instrument/',org); reason text; BEGIN
 PERFORM instrument.guard(org);
 PERFORM pg_advisory_xact_lock(80400);
 IF idem IS NULL OR request_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO receipt FROM access.staff_mutation WHERE staff_user_id=actor AND operation=op AND idempotency_key=idem;
 IF FOUND THEN IF receipt.request_digest<>request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN receipt.resource_id; END IF;
 SELECT * INTO q FROM instrument.questionnaire WHERE id=qid AND organization_id IS NOT DISTINCT FROM org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM 1 FROM instrument.questionnaire_version WHERE questionnaire_id=qid FOR UPDATE;
 IF expected IS NULL OR q.revision<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 reason:=instrument.delete_blocker(qid);
 IF reason IS NOT NULL THEN RAISE EXCEPTION 'STATE_CONFLICT' USING DETAIL='REASON:'||reason; END IF;
 PERFORM instrument.remove_questionnaire(qid);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,request_hash,qid);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'INSTRUMENT_DELETED',qid,ARRAY['instrument']);
 RETURN qid;
END $$;

-- 3.7 Why a company cannot be deleted, or NULL (internal). Every kind of
-- activity is checked explicitly, in this order, so the refusal names it.
-- Rounds, campaigns and everything downstream (intake, releases, comparisons,
-- reports, recommendation actions) would also be refused by foreign keys; the
-- checks exist so the answer says which one. Each questionnaire in the
-- company's scope must pass instrument.delete_blocker, or the whole delete is
-- refused.
CREATE FUNCTION core.organization_delete_blocker(org uuid) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE qid uuid; BEGIN
 IF EXISTS(SELECT 1 FROM core.assessment_series WHERE organization_id=org) THEN RETURN 'SERIES'; END IF;
 IF EXISTS(SELECT 1 FROM core.assessment_round WHERE organization_id=org) THEN RETURN 'ROUNDS'; END IF;
 IF EXISTS(SELECT 1 FROM core.campaign WHERE organization_id=org) THEN RETURN 'CAMPAIGNS'; END IF;
 IF EXISTS(SELECT 1 FROM core.invitation WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM intake.respondent_session WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM intake.draft_blob WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM intake.submission_inbox WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM intake.processing_batch WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM intake.campaign_key WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM ops.intake_erasure WHERE organization_id=org) THEN RETURN 'INTAKE'; END IF;
 IF EXISTS(SELECT 1 FROM publication.result_snapshot WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM publication.release_revocation WHERE organization_id=org) THEN RETURN 'RELEASES'; END IF;
 IF EXISTS(SELECT 1 FROM publication.comparison_definition WHERE organization_id=org) THEN RETURN 'COMPARISONS'; END IF;
 IF EXISTS(SELECT 1 FROM ops.report_job WHERE organization_id=org) THEN RETURN 'REPORTS'; END IF;
 IF EXISTS(SELECT 1 FROM publication.recommendation_instance WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM core.recommendation_action WHERE organization_id=org) THEN RETURN 'RECOMMENDATION_ACTIONS'; END IF;
 IF EXISTS(SELECT 1 FROM core.field_visit WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM core.visit_follow_up WHERE organization_id=org)
  OR EXISTS(SELECT 1 FROM core.attachment WHERE organization_id=org) THEN RETURN 'FIELD_VISITS'; END IF;
 IF EXISTS(SELECT 1 FROM core.message_link WHERE organization_id=org) THEN RETURN 'MESSAGE_LINKS'; END IF;
 IF EXISTS(SELECT 1 FROM core.employee_message WHERE organization_id=org) THEN RETURN 'MESSAGES'; END IF;
 -- Private exports always belong to a campaign today (no code path writes the
 -- DIRECTORY kind); checked anyway, because that ledger is not changed here.
 IF EXISTS(SELECT 1 FROM ops.private_export WHERE organization_id=org) THEN RETURN 'EXPORTS'; END IF;
 FOR qid IN SELECT id FROM instrument.questionnaire WHERE organization_id=org LOOP
 IF instrument.delete_blocker(qid) IS NOT NULL THEN RETURN 'QUESTIONNAIRE_IN_USE'; END IF;
 END LOOP;
 RETURN NULL;
END $$;

-- Removes a company and everything this delete covers (internal, no checks):
-- its questionnaires, its instrument scope, its directory (imports in any
-- state, participants, departments), staff assignments and the row itself.
-- Import sources in storage expire within a day (S3 lifecycle rule / the
-- local janitor). Removing staff assignments raises those staff members' auth
-- epoch (001 trigger), as any assignment change does.
CREATE FUNCTION core.remove_organization(org uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE qid uuid; BEGIN
 FOR qid IN SELECT id FROM instrument.questionnaire WHERE organization_id=org LOOP
 PERFORM instrument.remove_questionnaire(qid);
 END LOOP;
 DELETE FROM instrument.instrument_scope WHERE organization_id=org;
 DELETE FROM core.directory_import WHERE organization_id=org;
 DELETE FROM core.participant WHERE organization_id=org;
 DELETE FROM core.department WHERE organization_id=org;
 DELETE FROM access.organization_access WHERE organization_id=org;
 DELETE FROM core.organization WHERE id=org;
END $$;

-- Staff (Super Admin only, as organization archive in core.save_directory):
-- which reason, if any, stops this company's deletion now.
CREATE FUNCTION core.organization_delete_check(org uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF access.actor() IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.organization WHERE id=org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN core.organization_delete_blocker(org);
END $$;

-- Staff (Super Admin only): delete a company in one transaction. Locks: the
-- instrument advisory lock (its questionnaires go), the organization row and
-- every questionnaire and version row. Revision check and idempotency receipt
-- as save_directory (same operation name). A refusal is STATE_CONFLICT with
-- the reason in DETAIL. Records the ORGANIZATION tombstone and one
-- ORGANIZATION_DELETED audit row; earlier audit rows are untouched.
CREATE FUNCTION core.delete_organization(org uuid,expected bigint,idem uuid,req_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); receipt access.staff_mutation; op text:=concat('directory/organization/',org); rev bigint; reason text; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF idem IS NULL OR req_hash IS NULL THEN RAISE EXCEPTION 'PRECONDITION_REQUIRED'; END IF;
 SELECT * INTO receipt FROM access.staff_mutation WHERE staff_user_id=actor AND operation=op AND idempotency_key=idem;
 IF FOUND THEN IF receipt.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF; RETURN receipt.resource_id; END IF;
 PERFORM pg_advisory_xact_lock(80400);
 SELECT revision INTO rev FROM core.organization WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF expected IS NULL OR rev<>expected THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 PERFORM 1 FROM instrument.questionnaire WHERE organization_id=org FOR UPDATE;
 PERFORM 1 FROM instrument.questionnaire_version WHERE organization_id=org FOR UPDATE;
 reason:=core.organization_delete_blocker(org);
 IF reason IS NOT NULL THEN RAISE EXCEPTION 'STATE_CONFLICT' USING DETAIL='REASON:'||reason; END IF;
 PERFORM core.remove_organization(org);
 PERFORM ops.tombstone('ORGANIZATION',org,org);
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,org);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'ORGANIZATION_DELETED',org,ARRAY['organization']);
 RETURN org;
END $$;

-- Operator (restore replay): re-apply an organization deletion after a backup
-- restore, idempotently. 'ABSENT' when the row is already gone, 'DELETED' when
-- it was removed again, otherwise the blocker code, which the replay reports
-- as an incident instead of removing anything.
CREATE FUNCTION core.reapply_organization_deletion(org uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE reason text; BEGIN
 PERFORM pg_advisory_xact_lock(80400);
 PERFORM 1 FROM core.organization WHERE id=org FOR UPDATE;
 IF NOT FOUND THEN RETURN 'ABSENT'; END IF;
 PERFORM 1 FROM instrument.questionnaire WHERE organization_id=org FOR UPDATE;
 PERFORM 1 FROM instrument.questionnaire_version WHERE organization_id=org FOR UPDATE;
 reason:=core.organization_delete_blocker(org);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 PERFORM core.remove_organization(org);
 RETURN 'DELETED';
END $$;

-- 3.8 Privileges. The removal runs inside the definer routines, owned by
-- orgfit_access_executor, which gains DELETE on the four directory tables it
-- removes from. No runtime role gains any direct DML.
GRANT DELETE ON core.organization,core.department,core.participant,core.directory_import TO orgfit_access_executor;
GRANT CREATE ON SCHEMA instrument,core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='instrument' AND p.proname IN ('delete_blocker','remove_questionnaire','delete_checks','delete_questionnaire'))
    OR (n.nspname='core' AND p.proname IN ('organization_delete_blocker','remove_organization','organization_delete_check','delete_organization','reapply_organization_deletion')) LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA instrument,core FROM orgfit_access_executor;
-- The four staff routines go to orgfit_staff only; the internal helpers to no
-- runtime role; the restore replay to the operator, like the other replays.
GRANT EXECUTE ON FUNCTION instrument.delete_checks(uuid,uuid[]),instrument.delete_questionnaire(uuid,uuid,bigint,uuid,bytea),
 core.organization_delete_check(uuid),core.delete_organization(uuid,bigint,uuid,bytea) TO orgfit_staff;
GRANT EXECUTE ON FUNCTION core.reapply_organization_deletion(uuid) TO orgfit_core_owner;
