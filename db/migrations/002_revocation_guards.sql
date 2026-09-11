-- Revocation is enforced even when a trusted operator repairs membership directly.
CREATE FUNCTION access.guard_staff_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role OR NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.provider_subject IS DISTINCT FROM OLD.provider_subject THEN
  NEW.auth_epoch:=greatest(NEW.auth_epoch,OLD.auth_epoch+1);
 END IF;
 IF NEW.auth_epoch<OLD.auth_epoch THEN RAISE EXCEPTION 'INVALID_EPOCH'; END IF;
 IF NEW.auth_epoch<>OLD.auth_epoch THEN
  UPDATE access.staff_session SET revoked_at=clock_timestamp() WHERE staff_user_id=OLD.id AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_epoch BEFORE UPDATE ON access.staff_user FOR EACH ROW EXECUTE FUNCTION access.guard_staff_epoch();
CREATE FUNCTION access.guard_membership_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN UPDATE access.staff_user SET auth_epoch=auth_epoch+1 WHERE id=OLD.staff_user_id; END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.staff_user_id<>OLD.staff_user_id) THEN UPDATE access.staff_user SET auth_epoch=auth_epoch+1 WHERE id=NEW.staff_user_id; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER capability_epoch AFTER INSERT OR UPDATE OR DELETE ON access.staff_capability FOR EACH ROW EXECUTE FUNCTION access.guard_membership_epoch();
CREATE TRIGGER assignment_epoch AFTER INSERT OR UPDATE OR DELETE ON access.organization_access FOR EACH ROW EXECUTE FUNCTION access.guard_membership_epoch();
GRANT CREATE ON SCHEMA access TO orgfit_access_executor;
ALTER FUNCTION access.guard_staff_epoch() OWNER TO orgfit_access_executor;
ALTER FUNCTION access.guard_membership_epoch() OWNER TO orgfit_access_executor;
REVOKE CREATE ON SCHEMA access FROM orgfit_access_executor;
REVOKE ALL ON FUNCTION access.guard_staff_epoch(),access.guard_membership_epoch() FROM PUBLIC;
