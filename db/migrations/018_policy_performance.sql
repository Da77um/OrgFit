-- Phase 14: row-security policies that scale.
--
-- The Phase 14 load test found that listing participants in an organization of
-- 100,000 exceeded the statement timeout. Seven staff read policies called
-- access.has_org(organization_id) and access.has_capability(...) as plain
-- expressions, so PostgreSQL evaluated them FOR EVERY ROW, and each call
-- resolved the session again (a join on the session digest). SECURITY DEFINER
-- functions are never inlined, so the planner could neither cache nor push them
-- into an index condition.
--
-- The rules are unchanged. What changes is WHEN they are evaluated: every
-- session-dependent term is wrapped in a scalar sub-select, which PostgreSQL
-- runs once per statement as an init plan, and organization membership becomes
-- `organization_id = ANY(<the caller's organizations>)`, which an index can
-- serve. Equivalence, for any caller:
--   has_org(o)            = actor IS NOT NULL AND (is_admin OR o IN assigned)
--   is_admin OR o = ANY(org_ids())
--                         where is_admin is false and org_ids() is empty when
--                         there is no actor — identical truth table.
-- tests/operations.test.ts O-8 asserts the same visible rows before and after
-- for an admin, an assigned member, an unassigned member and no session.

CREATE FUNCTION access.org_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg(organization_id),'{}'::uuid[])
   FROM access.organization_access WHERE staff_user_id=access.actor();
$$;

ALTER POLICY staff_read ON core.organization
 USING ((SELECT access.is_admin()) OR id = ANY ((SELECT access.org_ids())::uuid[]));

ALTER POLICY directory_read ON core.department
 USING (((SELECT access.is_admin()) OR organization_id = ANY ((SELECT access.org_ids())::uuid[]))
        AND (SELECT access.has_capability('directory.manage')));
ALTER POLICY directory_read ON core.participant
 USING (((SELECT access.is_admin()) OR organization_id = ANY ((SELECT access.org_ids())::uuid[]))
        AND (SELECT access.has_capability('directory.manage')));
ALTER POLICY directory_read ON core.directory_import
 USING (((SELECT access.is_admin()) OR organization_id = ANY ((SELECT access.org_ids())::uuid[]))
        AND (SELECT access.has_capability('directory.manage')));

ALTER POLICY campaign_read ON core.invitation
 USING (((SELECT access.is_admin()) OR organization_id = ANY ((SELECT access.org_ids())::uuid[]))
        AND ((SELECT access.has_capability('campaigns.manage')) OR (SELECT access.has_capability('participation.read'))));
ALTER POLICY campaign_read ON core.campaign_roster
 USING (((SELECT access.is_admin()) OR organization_id = ANY ((SELECT access.org_ids())::uuid[]))
        AND ((SELECT access.has_capability('campaigns.manage')) OR (SELECT access.has_capability('participation.read'))));

ALTER POLICY export_read ON ops.private_export
 USING (((SELECT access.is_admin()) OR organization_id = ANY ((SELECT access.org_ids())::uuid[]))
        AND ((SELECT access.has_capability('campaigns.manage')) OR (SELECT access.has_capability('participation.export'))));

GRANT CREATE ON SCHEMA access TO orgfit_access_executor;
ALTER FUNCTION access.org_ids() OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA access FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION access.org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access.org_ids() TO orgfit_staff;

-- ---------------------------------------------------------------------------
-- The respondent instrument read. Every exchange-to-finalize path asked the
-- database to aggregate and ship the whole node tree of the pinned version;
-- at 200 items and 200 concurrent sessions that alone was over a second at the
-- median. A published version is immutable (write_version refuses to change
-- it) and identified by its schema hash, so the gateway may keep the tree in
-- memory keyed by version and hash. The SESSION is still resolved on every
-- request: this routine performs exactly the checks gateway_instrument does
-- and returns only the identifiers and the campaign's own frozen fields.
-- ---------------------------------------------------------------------------
CREATE FUNCTION intake.gateway_instrument_ref(session_digest_in bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; c core.campaign; v instrument.questionnaire_version; BEGIN
 i:=intake.session_invitation(session_digest_in);
 SELECT * INTO c FROM core.campaign WHERE id=i.campaign_id;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=c.version_id AND scope_id=c.instrument_scope_id;
 IF NOT FOUND OR v.state='DRAFT' THEN RAISE EXCEPTION 'COLLECTION_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('versionId',v.id,'instrumentHash',encode(v.schema_hash,'hex'),
 'locales',to_jsonb(c.locales),'notice',coalesce(c.frozen_manifest->'notice','{}'::jsonb),'endsAt',c.ends_at);
END $$;
GRANT CREATE ON SCHEMA intake TO orgfit_access_executor;
ALTER FUNCTION intake.gateway_instrument_ref(bytea) OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA intake FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION intake.gateway_instrument_ref(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake.gateway_instrument_ref(bytea) TO orgfit_gateway;
