-- ===========================================================================
-- 031: the privacy processor brings due campaigns' stored state up to the
-- clock before it looks for closed campaigns (D-196). Forward only.
--
-- publication.due_campaigns('PROCESS') selects campaigns whose STORED state is
-- CLOSED. A campaign that reaches its end date stays stored as OPEN (every
-- request already treats it as closed) until core.normalize_due runs, which
-- only the operator identity could call. On a deployment without a frequent
-- operator scheduler such a campaign was never processed. The processor now
-- calls this routine first, so a campaign past its end date is closed and
-- processed in the same run.
--
-- The routine takes no campaign, organization or value: it only makes stored
-- state agree with core.effective_state for campaigns already past a boundary,
-- exactly as core.normalize_due does, under the same advisory lock as the
-- operator's normalizer so the two never race. It cannot open, extend, reopen
-- or close any campaign early.
-- ===========================================================================

CREATE FUNCTION publication.normalize_due_campaigns(max_rows integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF max_rows<1 OR max_rows>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF NOT pg_try_advisory_xact_lock(80600) THEN RETURN 0; END IF;
 RETURN core.normalize_due(max_rows);
END $$;
REVOKE ALL ON FUNCTION publication.normalize_due_campaigns(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publication.normalize_due_campaigns(integer) TO orgfit_processor;
