-- Pin the first engine without rewriting any published content or fingerprint.
-- Future engines require a forward migration and an explicit compatibility rule.
ALTER TABLE instrument.questionnaire_version ADD COLUMN engine_version text NOT NULL DEFAULT '1.0.0' CHECK (engine_version='1.0.0');

CREATE FUNCTION instrument.scoring_bounds(qid uuid,vid uuid) RETURNS numeric[] LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE q jsonb; vals numeric[]; lo numeric; hi numeric; a numeric; b numeric; k integer; min_k integer; max_k integer; cnt integer;
BEGIN
 SELECT payload INTO q FROM instrument.question WHERE id=qid AND version_id=vid;
 CASE q->>'type'
 WHEN 'RATING_5' THEN RETURN ARRAY[1,5]::numeric[];
 WHEN 'RATING_10' THEN RETURN ARRAY[1,10]::numeric[];
 WHEN 'NUMBER' THEN
 lo:=(q->'validation'->>'min')::numeric; hi:=(q->'validation'->>'max')::numeric;
 a:=power(10::numeric,coalesce((q->'validation'->>'precision')::integer,0));
 IF trunc(lo*a)<>lo*a OR trunc(hi*a)<>hi*a THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 RETURN ARRAY[lo,hi];
 ELSE
 SELECT array_agg(v ORDER BY v) INTO vals FROM (
 SELECT (payload->>'score')::numeric v FROM instrument.question_option WHERE version_id=vid AND parent_id=qid
 UNION ALL SELECT (payload->>'score')::numeric FROM instrument.matrix_column WHERE version_id=vid AND parent_id=qid) x;
 cnt:=coalesce(array_length(vals,1),0);
 IF cnt=0 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF q->>'type'<>'CHECKBOXES' THEN RETURN ARRAY[vals[1],vals[cnt]]; END IF;
 min_k:=greatest(1,coalesce((q->'validation'->>'minSelections')::integer,0));
 max_k:=coalesce((q->'validation'->>'maxSelections')::integer,cnt);
 IF min_k<0 OR max_k>cnt OR min_k>max_k THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF q->'scoring'->>'mode'='SELECTED_PERCENTAGE' THEN RETURN ARRAY[100.0*min_k/cnt,100.0*max_k/cnt]; END IF;
 FOR k IN min_k..max_k LOOP
 IF k=0 THEN a:=0;b:=0;
 ELSE SELECT sum(v) INTO a FROM unnest(vals[1:k]) v; SELECT sum(v) INTO b FROM unnest(vals[cnt-k+1:cnt]) v; END IF;
 lo:=CASE WHEN lo IS NULL THEN a ELSE least(lo,a) END;
 hi:=CASE WHEN hi IS NULL THEN b ELSE greatest(hi,b) END;
 END LOOP;
 RETURN ARRAY[lo,hi];
 END CASE;
END $$;

CREATE FUNCTION instrument.scoring_publish_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE dim record; q record; bounds numeric[]; first_bounds numeric[]; v jsonb;
BEGIN
 IF NEW.state<>'PUBLISHED' OR OLD.state<>'DRAFT' THEN RETURN NEW; END IF;
 -- Numeric configuration is bounded decimal text, never NaN/Infinity or a SQL
 -- expression. Validate the SQL credential boundary as well as the HTTP schema.
 FOR v IN
 SELECT payload->'scoring'->'weight' FROM instrument.question WHERE version_id=NEW.id
 UNION ALL SELECT payload->'weight' FROM instrument.matrix_row WHERE version_id=NEW.id
 UNION ALL SELECT payload->'score' FROM instrument.question_option WHERE version_id=NEW.id AND payload->>'score' IS NOT NULL
 UNION ALL SELECT payload->'score' FROM instrument.matrix_column WHERE version_id=NEW.id AND payload->>'score' IS NOT NULL
 UNION ALL SELECT payload->'validation'->'min' FROM instrument.question WHERE version_id=NEW.id AND payload->'validation' ? 'min'
 UNION ALL SELECT payload->'validation'->'max' FROM instrument.question WHERE version_id=NEW.id AND payload->'validation' ? 'max'
 UNION ALL SELECT payload->'coverage' FROM instrument.score_definition WHERE version_id=NEW.id AND parent_id IS NOT NULL
 UNION ALL SELECT payload->'denominator' FROM instrument.score_definition WHERE version_id=NEW.id AND payload->>'denominator' IS NOT NULL
 UNION ALL SELECT i->'weight' FROM instrument.score_definition s CROSS JOIN LATERAL jsonb_array_elements(s.payload->'inputs') i WHERE version_id=NEW.id AND parent_id IS NULL
 UNION ALL SELECT payload->'lower' FROM instrument.interpretation_band WHERE version_id=NEW.id
 UNION ALL SELECT payload->'upper' FROM instrument.interpretation_band WHERE version_id=NEW.id
 LOOP
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR (v#>>'{}')!~'^-?(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 END LOOP;
 FOR dim IN SELECT parent_id,payload->>'mode' mode FROM instrument.score_definition WHERE version_id=NEW.id AND parent_id IS NOT NULL LOOP
 first_bounds:=NULL;
 FOR q IN SELECT * FROM instrument.question WHERE version_id=NEW.id AND dimension_id=dim.parent_id AND (payload->'scoring'->>'enabled')::boolean LOOP
 bounds:=instrument.scoring_bounds(q.id,NEW.id);
 IF bounds[1] IS NULL OR bounds[2] IS NULL OR bounds[1]>=bounds[2] THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF dim.mode<>'WEIGHTED_AVERAGE' AND ((q.payload->'scoring'->>'weight')::numeric<>1 OR EXISTS(SELECT 1 FROM instrument.matrix_row WHERE version_id=NEW.id AND parent_id=q.id AND (payload->>'weight')::numeric<>1)) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF dim.mode='SUM' AND first_bounds IS NOT NULL AND bounds<>first_bounds THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 first_bounds:=bounds;
 END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER scoring_publication_check BEFORE UPDATE ON instrument.questionnaire_version FOR EACH ROW EXECUTE FUNCTION instrument.scoring_publish_check();
GRANT CREATE ON SCHEMA instrument TO orgfit_access_executor;
ALTER FUNCTION instrument.scoring_bounds(uuid,uuid) OWNER TO orgfit_access_executor;
ALTER FUNCTION instrument.scoring_publish_check() OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA instrument FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION instrument.scoring_bounds(uuid,uuid),instrument.scoring_publish_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION instrument.scoring_bounds(uuid,uuid) TO orgfit_core_owner;
