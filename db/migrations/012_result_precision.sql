-- Checkpoint D repair CD-002: one published number, one representation.
--
-- publication.snapshot served cell values through trim_scale, so a released
-- mean of exactly 60.0 reached the results view as "60" while the frozen
-- recommendation that cited the same cell carried "60.0". Two immutable
-- artifacts describing one disclosed value disagreed on precision, and the
-- blueprint's display rule (one decimal by default) was lost for whole numbers.
--
-- The disclosure engine already formats every released value to the precision
-- the release intends, so the fix is to serve what was stored rather than to
-- re-format it here. Nothing about WHICH values are released changes: this is
-- the read path only, the stored numeric is untouched, and no snapshot content
-- hash depends on it.
--
-- Coverage keeps trim_scale: it is a ratio that appears in one place only and
-- has no second frozen representation to agree with.
CREATE OR REPLACE FUNCTION publication.snapshot(cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; s publication.result_snapshot; BEGIN
 SELECT * INTO c FROM core.campaign WHERE id=cid;
 IF NOT FOUND OR NOT access.has_org(c.organization_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT access.has_capability('results.read') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO s FROM publication.result_snapshot
  WHERE organization_id=c.organization_id AND campaign_id=cid AND state='PUBLISHED';
 IF NOT FOUND THEN
  RETURN jsonb_build_object('available',false,'campaignId',cid,'roundId',c.round_id,
   'releaseState',c.release_state,'campaignState',core.effective_state(c.state,c.starts_at,c.ends_at),
   'threshold',c.threshold);
 END IF;
 RETURN jsonb_build_object('available',true,'campaignId',cid,'roundId',s.round_id,'id',s.id,
  'releaseRevision',s.release_revision,'releaseState',c.release_state,'threshold',s.threshold,
  'contributorCount',s.contributor_count,'generatedAt',s.generated_at,'period',s.closed_period,
  'manifest',s.report_manifest,'contentHash',encode(s.content_hash,'hex'),
  'versions',jsonb_build_object('instrument',s.instrument_version_id,'scoring',s.scoring_version,
   'rules',s.rules_version,'privacy',s.privacy_version),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('key',g.group_key,'kind',g.kind,'label',g.label)
    ORDER BY g.display_order,g.group_key) FROM publication.snapshot_group g
    WHERE g.organization_id=s.organization_id AND g.snapshot_id=s.id),'[]'::jsonb),
  'metrics',coalesce((SELECT jsonb_agg(jsonb_build_object('key',m.metric_key,'kind',m.kind,'label',m.label,
    'description',m.description,'direction',m.direction,'unit',m.unit,'bands',m.bands)
    ORDER BY m.display_order,m.metric_key) FROM publication.snapshot_metric m
    WHERE m.organization_id=s.organization_id AND m.snapshot_id=s.id),'[]'::jsonb),
  'cells',coalesce((SELECT jsonb_agg(jsonb_build_object('groupKey',a.group_key,'metricKey',a.metric_key,
    'status',a.status,'reasonCode',a.reason_code,'contributorCount',a.contributor_count,
    -- Served as released, not re-formatted.
    'value',CASE WHEN a.value IS NULL THEN NULL ELSE a.value::text END,
    'coverage',CASE WHEN a.coverage IS NULL THEN NULL ELSE trim_scale(a.coverage)::text END,
    'distribution',a.distribution,'band',a.band)
    ORDER BY a.metric_key,a.group_key) FROM publication.aggregate_cell a
    WHERE a.organization_id=s.organization_id AND a.snapshot_id=s.id),'[]'::jsonb));
END $$;

GRANT CREATE ON SCHEMA publication TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='publication' AND p.proname='snapshot' LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA publication FROM orgfit_access_executor;
GRANT EXECUTE ON FUNCTION publication.snapshot(uuid) TO orgfit_staff;
