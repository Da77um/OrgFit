-- Phase 10: within-organization history and reviewed two-round comparison.
--
-- A comparison is a REVIEW, not a calculation. It records that a named staff
-- reviewer judged two published releases of one series to measure the same
-- thing, with the mapping and the rationale that justify it. It is immutable:
-- a later opinion is a new row, never an edit of this one.
--
-- Nothing here reads, stores or joins a respondent. Both sides are published
-- aggregate snapshots that already passed disclosure, the group pairing is
-- department lineage, and the numeric delta itself is computed in the
-- application from the two sets of released cells — after re-verifying, from
-- the pinned instrument definitions, that the mapped metrics really are the
-- same measurement. A stored review cannot manufacture a number.
CREATE TABLE publication.comparison_definition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 series_id uuid NOT NULL,
 left_round_id uuid NOT NULL, right_round_id uuid NOT NULL,
 left_snapshot_id uuid NOT NULL, right_snapshot_id uuid NOT NULL,
 classification text NOT NULL CHECK(classification IN ('IDENTICAL','REVIEWED_EQUIVALENT','NOT_COMPARABLE')),
 -- {schemaVersion,metrics:[{leftKey,rightKey}],note?}. No participant, no group
 -- membership and no value ever enters this document.
 metric_mapping jsonb NOT NULL CHECK(jsonb_typeof(metric_mapping)='object' AND octet_length(metric_mapping::text)<=32768),
 rationale text NOT NULL CHECK(length(trim(rationale)) BETWEEN 1 AND 2000),
 reviewed_by uuid NOT NULL REFERENCES access.staff_user,
 content_hash bytea NOT NULL CHECK(octet_length(content_hash)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,id),
 -- The same review twice is the same row, so a retry cannot create a second
 -- opinion of record.
 UNIQUE(organization_id,left_snapshot_id,right_snapshot_id,content_hash),
 FOREIGN KEY(organization_id,series_id) REFERENCES core.assessment_series(organization_id,id),
 FOREIGN KEY(organization_id,left_round_id) REFERENCES core.assessment_round(organization_id,id),
 FOREIGN KEY(organization_id,right_round_id) REFERENCES core.assessment_round(organization_id,id),
 FOREIGN KEY(organization_id,left_snapshot_id) REFERENCES publication.result_snapshot(organization_id,id),
 FOREIGN KEY(organization_id,right_snapshot_id) REFERENCES publication.result_snapshot(organization_id,id),
 CHECK(left_round_id<>right_round_id)
);
CREATE INDEX ON publication.comparison_definition(organization_id,series_id,created_at DESC,id);
CREATE INDEX ON publication.comparison_definition(reviewed_by);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON publication.comparison_definition
 FOR EACH ROW EXECUTE FUNCTION publication.immutable();
ALTER TABLE publication.comparison_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication.comparison_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY executor ON publication.comparison_definition TO orgfit_access_executor USING(true) WITH CHECK(true);
CREATE POLICY migration ON publication.comparison_definition TO orgfit_core_owner USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON publication.comparison_definition TO orgfit_access_executor;

ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN ('STAFF_CREATED','ACCESS_CHANGED','SESSIONS_REVOKED','PROFILE_UPDATED','LOGOUT','BOOTSTRAP','DIRECTORY_CHANGED','IMPORT_CHANGED','IMPORT_ERRORS_DOWNLOADED','INSTRUMENT_CHANGED','SERIES_CHANGED','ROUND_CHANGED','CAMPAIGN_CHANGED','CAMPAIGN_LAUNCHED','CAMPAIGN_END_DATE_CHANGED','INVITATION_ISSUED','INVITATION_ROTATED','INVITATION_REVOKED','LINK_EXPORT_CREATED','LINK_EXPORT_DOWNLOADED','RECOMMENDATION_ACTION_CHANGED','COMPARISON_REVIEWED'));
ALTER TABLE ops.audit_log DROP CONSTRAINT audit_log_field_names_check;
ALTER TABLE ops.audit_log ADD CONSTRAINT audit_log_field_names_check CHECK(field_names <@ ARRAY['locale','role','status','capabilities','organizationIds','authEpoch','membership','organization','department','participant','import','instrument','series','round','campaign','invitation','export','endsAt','state','recommendationAction','comparison']::text[]);

-- ---------------------------------------------------------------------------
-- The series history read model.
--
-- Chronological rounds of one series with their release state, and for every
-- released round the COMPANY-level scored cells of its own frozen snapshot.
-- Department cells are deliberately absent: a trend line is a company series,
-- and a department history is only ever shown through a reviewed comparison.
-- ---------------------------------------------------------------------------
CREATE FUNCTION publication.series_history(sid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s core.assessment_series; BEGIN
 SELECT * INTO s FROM core.assessment_series WHERE id=sid;
 IF NOT FOUND OR NOT access.has_org(s.organization_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN jsonb_build_object('seriesId',s.id,'organizationId',s.organization_id,
  'nameAr',s.name_ar,'nameEn',s.name_en,'purpose',s.purpose,'status',s.status,
  'rounds',coalesce((SELECT jsonb_agg(round ORDER BY round->>'periodStart', round->>'roundId') FROM (
    SELECT jsonb_build_object(
      'roundId',r.id,'label',r.label,'periodStart',r.period_start,'periodEnd',r.period_end,
      'state',r.state,'versionId',r.questionnaire_version_id,'compatibilityGroup',r.compatibility_group,
      'campaignId',c.id,'releaseState',c.release_state,
      'snapshotId',p.id,'contributorCount',p.contributor_count,'generatedAt',p.generated_at,
      'threshold',p.threshold,'period',p.closed_period,
      'companyGroupKey',(SELECT g.group_key FROM publication.snapshot_group g
        WHERE g.organization_id=p.organization_id AND g.snapshot_id=p.id AND g.kind='COMPANY'),
      'metrics',coalesce((SELECT jsonb_agg(jsonb_build_object('key',m.metric_key,'kind',m.kind,'label',m.label,
        'description',m.description,'direction',m.direction,'unit',m.unit,'bands',m.bands)
        ORDER BY m.display_order,m.metric_key) FROM publication.snapshot_metric m
        WHERE m.organization_id=p.organization_id AND m.snapshot_id=p.id AND m.kind<>'QUESTION'),'[]'::jsonb),
      -- Company cells only, and each exactly as it was released.
      'cells',coalesce((SELECT jsonb_agg(jsonb_build_object('groupKey',a.group_key,'metricKey',a.metric_key,
        'status',a.status,'reasonCode',a.reason_code,'contributorCount',a.contributor_count,
        'value',CASE WHEN a.value IS NULL THEN NULL ELSE a.value::text END,
        'coverage',CASE WHEN a.coverage IS NULL THEN NULL ELSE trim_scale(a.coverage)::text END,
        'distribution',NULL,'band',a.band) ORDER BY a.metric_key)
        FROM publication.aggregate_cell a JOIN publication.snapshot_group g
          ON g.organization_id=a.organization_id AND g.snapshot_id=a.snapshot_id AND g.group_key=a.group_key
        WHERE a.organization_id=p.organization_id AND a.snapshot_id=p.id AND g.kind='COMPANY'
          AND a.metric_key IN (SELECT m.metric_key FROM publication.snapshot_metric m
            WHERE m.organization_id=p.organization_id AND m.snapshot_id=p.id AND m.kind<>'QUESTION')),'[]'::jsonb)
    ) AS round
    FROM core.assessment_round r
    LEFT JOIN core.campaign c ON c.organization_id=r.organization_id AND c.round_id=r.id
    LEFT JOIN publication.result_snapshot p ON p.organization_id=r.organization_id
      AND p.campaign_id=c.id AND p.state='PUBLISHED'
    WHERE r.organization_id=s.organization_id AND r.series_id=s.id
    ORDER BY r.period_start, r.id LIMIT 100) q),'[]'::jsonb));
END $$;

-- Everything a comparison needs that is NOT a cell: the review itself, both
-- rounds' identity and period, and the department lineage of each frozen
-- group. Cells are read through publication.snapshot, which is the audited
-- staff path and applies its own checks.
CREATE FUNCTION publication.comparison_context(cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d publication.comparison_definition; BEGIN
 SELECT * INTO d FROM publication.comparison_definition WHERE id=cid;
 IF NOT FOUND OR NOT access.has_org(d.organization_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN jsonb_build_object('id',d.id,'organizationId',d.organization_id,'seriesId',d.series_id,
  'classification',d.classification,'metricMapping',d.metric_mapping,'rationale',d.rationale,
  'reviewedAt',d.created_at,
  'reviewedBy',(SELECT u.display_name FROM access.staff_user u WHERE u.id=d.reviewed_by),
  'left',publication.comparison_side(d.organization_id,d.left_round_id,d.left_snapshot_id),
  'right',publication.comparison_side(d.organization_id,d.right_round_id,d.right_snapshot_id));
END $$;

CREATE FUNCTION publication.comparison_side(org uuid,rid uuid,sid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('roundId',r.id,'label',r.label,'periodStart',r.period_start,
  'periodEnd',r.period_end,'versionId',r.questionnaire_version_id,'scopeId',r.instrument_scope_id,
  'campaignId',p.campaign_id,'snapshotId',p.id,'threshold',p.threshold,
  'contributorCount',p.contributor_count,'generatedAt',p.generated_at,'period',p.closed_period,
  -- Department lineage of each frozen group: a rename keeps the department, so
  -- the two rounds still line up while each keeps its own historic label.
  'lineage',coalesce((SELECT jsonb_object_agg(g.group_key,to_jsonb(rg.department_id))
    FROM publication.snapshot_group g
    LEFT JOIN core.report_group rg ON rg.organization_id=g.organization_id AND rg.id=g.group_key
    WHERE g.organization_id=p.organization_id AND g.snapshot_id=p.id),'{}'::jsonb))
 FROM core.assessment_round r JOIN publication.result_snapshot p
   ON p.organization_id=r.organization_id AND p.id=sid AND p.round_id=r.id
 WHERE r.organization_id=org AND r.id=rid
$$;

CREATE FUNCTION publication.comparisons(org uuid,sid uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'seriesId',d.series_id,
   'leftRoundId',d.left_round_id,'rightRoundId',d.right_round_id,'classification',d.classification,
   'rationale',d.rationale,'reviewedAt',d.created_at,
   'reviewedBy',(SELECT u.display_name FROM access.staff_user u WHERE u.id=d.reviewed_by))
   ORDER BY d.created_at DESC,d.id)
  FROM publication.comparison_definition d
  WHERE d.organization_id=org AND (sid IS NULL OR d.series_id=sid) LIMIT 100),'[]'::jsonb);
END $$;

-- The review write path. It validates everything the database can see for
-- itself: same organization, same series, both rounds released, chronological
-- order, and a classification consistent with the two pinned versions.
-- Measurement equivalence itself is a property of the instrument definitions
-- and is verified in the application, both here and again whenever a delta is
-- computed.
CREATE FUNCTION publication.save_comparison(org uuid,body jsonb,idem uuid,req_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=access.actor(); l core.assessment_round; r core.assessment_round;
 ls publication.result_snapshot; rs publication.result_snapshot; existing publication.comparison_definition;
 hash bytea; result uuid; receipt uuid; op text:=concat('comparison/',org); classification text; BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF NOT access.has_org(org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- Reading history needs results.read; recording a judgement that two
 -- measurements are the same additionally needs instrument authority.
 IF NOT (access.has_capability('results.read') AND access.has_capability('instruments.manage'))
  THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 receipt:=core.mutation_receipt(op,idem,req_hash);
 IF receipt IS NOT NULL THEN RETURN jsonb_build_object('id',receipt,'replayed',true); END IF;
 classification:=body->>'classification';
 IF classification NOT IN ('IDENTICAL','REVIEWED_EQUIVALENT','NOT_COMPARABLE') THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT * INTO l FROM core.assessment_round WHERE organization_id=org AND id=(body->>'leftRoundId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO r FROM core.assessment_round WHERE organization_id=org AND id=(body->>'rightRoundId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 -- One organization, one series, one construct. There is no cross-series and
 -- no cross-organization comparison, and none can be requested.
 IF l.id=r.id OR l.series_id<>r.series_id THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF (l.period_start,l.created_at) >= (r.period_start,r.created_at) THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 SELECT p.* INTO ls FROM publication.result_snapshot p JOIN core.campaign c
   ON c.id=p.campaign_id WHERE p.organization_id=org AND p.round_id=l.id AND p.state='PUBLISHED';
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT p.* INTO rs FROM publication.result_snapshot p JOIN core.campaign c
   ON c.id=p.campaign_id WHERE p.organization_id=org AND p.round_id=r.id AND p.state='PUBLISHED';
 IF NOT FOUND THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 -- IDENTICAL is a statement about the pinned versions, not an opinion.
 IF classification='IDENTICAL' AND l.questionnaire_version_id<>r.questionnaire_version_id
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF classification='NOT_COMPARABLE' AND jsonb_array_length(coalesce(body->'mapping','[]'::jsonb))<>0
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF classification<>'NOT_COMPARABLE' AND jsonb_array_length(coalesce(body->'mapping','[]'::jsonb))=0
  THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 hash:=sha256(convert_to(jsonb_build_object('left',ls.id,'right',rs.id,'classification',classification,
  'mapping',coalesce(body->'mapping','[]'::jsonb),'rationale',body->>'rationale')::text,'UTF8'));
 SELECT * INTO existing FROM publication.comparison_definition
  WHERE organization_id=org AND left_snapshot_id=ls.id AND right_snapshot_id=rs.id AND content_hash=hash;
 IF FOUND THEN result:=existing.id;
 ELSE
  INSERT INTO publication.comparison_definition(organization_id,series_id,left_round_id,right_round_id,
   left_snapshot_id,right_snapshot_id,classification,metric_mapping,rationale,reviewed_by,content_hash)
  VALUES(org,l.series_id,l.id,r.id,ls.id,rs.id,classification,
   jsonb_build_object('schemaVersion',1,'metrics',coalesce(body->'mapping','[]'::jsonb)),
   body->>'rationale',actor,hash)
  RETURNING id INTO result;
 END IF;
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(actor,op,idem,req_hash,result);
 INSERT INTO ops.audit_log(actor_id,organization_id,action,target_id,field_names) VALUES(actor,org,'COMPARISON_REVIEWED',result,ARRAY['comparison']);
 RETURN jsonb_build_object('id',result,'replayed',false);
END $$;

GRANT CREATE ON SCHEMA publication TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='publication' AND p.proname IN ('series_history','comparison_context','comparison_side','comparisons','save_comparison') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication FROM orgfit_access_executor;
-- comparison_side is an internal helper of comparison_context and is not part
-- of the staff surface.
GRANT EXECUTE ON FUNCTION publication.series_history(uuid),publication.comparison_context(uuid),
 publication.comparisons(uuid,uuid),publication.save_comparison(uuid,jsonb,uuid,bytea) TO orgfit_staff;
