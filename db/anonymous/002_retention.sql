-- Phase 14: time-based retention of finalized anonymous answers.
--
-- Retention works at the only granularity this store has: a whole campaign.
-- There is still no per-person path, because nothing here identifies a person.
-- A campaign whose batch was committed more than `retain` ago loses its
-- responses, answers, scores, groups, manifest and marker in one transaction;
-- its published aggregate snapshot in the core database is untouched.
--
-- The caller (scripts/retention.ts, as orgfit_anon_migrator acting as
-- orgfit_anon_owner) records a campaign-level tombstone in the core database
-- for each purged campaign, so a restored anonymous database is purged again
-- before it is opened.
CREATE FUNCTION anonymous.purge_expired(retain interval, limit_campaigns integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r record; purged jsonb:='[]'::jsonb; BEGIN
 IF retain < interval '1 day' OR limit_campaigns<1 OR limit_campaigns>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 FOR r IN SELECT organization_id,campaign_id FROM anonymous.processed_batch
   WHERE committed_at < clock_timestamp()-retain ORDER BY committed_at LIMIT limit_campaigns LOOP
  PERFORM anonymous.purge_campaign(r.organization_id,r.campaign_id);
  purged:=purged||jsonb_build_array(jsonb_build_object('organizationId',r.organization_id,'campaignId',r.campaign_id));
 END LOOP;
 RETURN purged;
END $$;
REVOKE ALL ON FUNCTION anonymous.purge_expired(interval,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anonymous.purge_expired(interval,integer) TO orgfit_anon_owner;

-- Replay of a campaign-level tombstone into a restored anonymous database.
-- Idempotent: a campaign already absent purges nothing.
REVOKE ALL ON FUNCTION anonymous.purge_campaign(uuid,uuid) FROM PUBLIC;
