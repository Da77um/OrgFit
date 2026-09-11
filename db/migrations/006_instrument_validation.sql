-- Repeat publication invariants inside PostgreSQL. Possession of the ordinary
-- staff SQL credential is not a way to publish a malformed instrument.
CREATE FUNCTION instrument.assert_text_tree(value jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE child jsonb; BEGIN
 IF jsonb_typeof(value)='string' THEN
 IF length(value#>>'{}')>10000 OR (value#>>'{}')~'[<>]' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 ELSIF jsonb_typeof(value)='object' THEN FOR child IN SELECT v FROM jsonb_each(value) x(k,v) LOOP PERFORM instrument.assert_text_tree(child); END LOOP;
 ELSIF jsonb_typeof(value)='array' THEN FOR child IN SELECT v FROM jsonb_array_elements(value) x(v) LOOP PERFORM instrument.assert_text_tree(child); END LOOP;
 END IF;
END $$;
CREATE FUNCTION instrument.translated(value jsonb,locales jsonb,required boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE l text; BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' OR value-ARRAY['ar','en']<>'{}'::jsonb OR jsonb_typeof(value->'ar') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'en') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF required OR length(trim(value->>'ar'))>0 OR length(trim(value->>'en'))>0 THEN
 FOR l IN SELECT jsonb_array_elements_text(locales) LOOP IF length(trim(value->>l))=0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF; END LOOP;
 END IF;
END $$;
CREATE FUNCTION instrument.publish_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
 IF kind IS NULL OR kind NOT IN ('SHORT_TEXT','LONG_TEXT','MULTIPLE_CHOICE','CHECKBOXES','DROPDOWN','YES_NO','RATING_5','RATING_10','MATRIX','NUMBER','DATE','CONTENT') OR q-ARRAY['id','key','type','prompt','help','required','dimensionId','validation','scoring']<>'{}'::jsonb OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(cfg) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
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
 IF kind IN ('MULTIPLE_CHOICE','CHECKBOXES','DROPDOWN','YES_NO') THEN IF count_options<2 OR (kind='YES_NO' AND count_options<>2) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
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
 IF kind IN ('SHORT_TEXT','LONG_TEXT','DATE','CONTENT') OR n.dimension_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
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
CREATE TRIGGER publication_check BEFORE UPDATE ON instrument.questionnaire_version FOR EACH ROW EXECUTE FUNCTION instrument.publish_check();
GRANT CREATE ON SCHEMA instrument TO orgfit_access_executor;
ALTER FUNCTION instrument.assert_text_tree(jsonb) OWNER TO orgfit_access_executor;
ALTER FUNCTION instrument.translated(jsonb,jsonb,boolean) OWNER TO orgfit_access_executor;
ALTER FUNCTION instrument.publish_check() OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA instrument FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION instrument.assert_text_tree(jsonb),instrument.translated(jsonb,jsonb,boolean),instrument.publish_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION instrument.assert_text_tree(jsonb),instrument.translated(jsonb,jsonb,boolean) TO orgfit_core_owner;
