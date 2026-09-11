-- Scope import commit retries to the current actor, organization and operation.
-- Receipts and participant inserts commit or roll back in the same transaction.
CREATE FUNCTION core.import_receipt(org uuid,target uuid,idem uuid,req_hash bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old access.staff_mutation; op text:=concat('import_commit/',org); BEGIN
 PERFORM core.directory_guard(org);
 IF NOT EXISTS(SELECT 1 FROM core.directory_import WHERE organization_id=org AND id=target AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT * INTO old FROM access.staff_mutation WHERE staff_user_id=access.actor() AND operation=op AND idempotency_key=idem;
 IF FOUND THEN
 IF old.resource_id<>target OR old.request_digest<>req_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
 ELSE
 INSERT INTO access.staff_mutation(staff_user_id,operation,idempotency_key,request_digest,resource_id) VALUES(access.actor(),op,idem,req_hash,target);
 END IF;
END $$;
GRANT CREATE ON SCHEMA core TO orgfit_access_executor;
ALTER FUNCTION core.import_receipt(uuid,uuid,uuid,bytea) OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA core FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION core.import_receipt(uuid,uuid,uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.import_receipt(uuid,uuid,uuid,bytea) TO orgfit_staff;
