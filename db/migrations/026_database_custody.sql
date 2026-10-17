-- ===========================================================================
-- Campaign key custody in the core database (owner decision D-180, P-003
-- option C). Forward only; 009 is unchanged.
--
-- WHY. On Vercel the staff launch and the privacy processor run in separate
-- deployments with separate, short-lived filesystems, so the development-file
-- stand-in cannot carry a sealed campaign key from one to the other. The owner
-- accepted keeping the SEALED key in the core database instead of a managed
-- custody service.
--
-- WHAT STAYS TRUE. The key stored here is the campaign's X25519 private key
-- sealed (libsodium crypto_box_seal, unchanged) to the custodian PUBLIC key.
-- Opening it needs CAMPAIGN_KEY_CUSTODY_SECRET_KEY, which only the processor
-- deployment holds; the staff app refuses to start with it. Staff can write a
-- sealed key at launch and can never read one back: it has no privilege on
-- schema intake, and no routine returns a sealed key to it. The gateway's
-- routine returns the PUBLIC key only.
--
-- WHAT IS GIVEN UP, and accepted by the owner: crypto-erasure. 009 promised
-- that no private key ever reaches this database; with this provider a sealed
-- one does. The live copy is cleared the moment a key is no longer needed, but
-- database backups, WAL and replicas keep it for their retention, and with the
-- custodian secret it would open the encrypted intake those same backups hold.
-- No campaign may therefore be described as crypto-erased under this provider
-- (the destruction evidence says so).
-- ===========================================================================

ALTER TABLE intake.campaign_key
 ADD COLUMN sealed_private_key bytea
  -- crypto_box_seal of a 32-byte key: 32 + crypto_box_SEALBYTES (48).
  CHECK(sealed_private_key IS NULL OR octet_length(sealed_private_key)=80),
 -- Only a key that may still be needed for decryption keeps its sealed copy.
 ADD CONSTRAINT campaign_key_sealed_only_while_needed
  CHECK(sealed_private_key IS NULL OR state IN ('ACTIVE','DECRYPT_ONLY'));

-- The sealed copy is written once, at registration, and only ever cleared.
-- Moving a key to DELETE_REQUESTED or DESTROYED clears it in the same
-- statement, whichever path does it: batch cleanup, keys_destroyed, or a
-- tombstone replay after a restore (ops, 017).
CREATE FUNCTION intake.campaign_key_sealed_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.sealed_private_key IS DISTINCT FROM OLD.sealed_private_key AND NEW.sealed_private_key IS NOT NULL THEN
  RAISE EXCEPTION 'STATE_CONFLICT';
 END IF;
 IF NEW.state IN ('DELETE_REQUESTED','DESTROYED') THEN NEW.sealed_private_key:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sealed_guard BEFORE UPDATE ON intake.campaign_key
 FOR EACH ROW EXECUTE FUNCTION intake.campaign_key_sealed_guard();

-- Registration with a sealed key, inside the staff launch transaction. Same
-- checks as the 4-argument routine in 009, which stays for the file provider.
CREATE FUNCTION core.register_campaign_key(org uuid,cid uuid,reference text,pubkey bytea,sealed bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE epoch integer; BEGIN
 PERFORM core.campaign_guard(org,false);
 IF sealed IS NULL OR octet_length(sealed)<>80 THEN RAISE EXCEPTION 'VALIDATION_FAILED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF EXISTS(SELECT 1 FROM intake.campaign_key WHERE campaign_id=cid AND state='ACTIVE') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT coalesce(max(key_epoch),0)+1 INTO epoch FROM intake.campaign_key WHERE campaign_id=cid;
 INSERT INTO intake.campaign_key(organization_id,campaign_id,key_reference,public_key,key_epoch,sealed_private_key)
 VALUES(org,cid,reference,pubkey,epoch,sealed);
 RETURN reference;
END $$;

-- The processor's read of the sealed keys of ONE batch it holds the lease on,
-- and only while that batch is being decrypted. Batch-scoped like its other
-- routines; it returns nothing for any other campaign or state.
CREATE FUNCTION intake.batch_sealed_keys(bid uuid,lease_gen bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b intake.processing_batch; result jsonb; BEGIN
 SELECT * INTO b FROM intake.processing_batch WHERE id=bid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF b.lease_generation<>lease_gen THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 IF b.state<>'PROCESSING' THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT coalesce(jsonb_object_agg(k.key_reference,encode(k.sealed_private_key,'base64')),'{}'::jsonb) INTO result
  FROM intake.campaign_key k
  WHERE k.campaign_id=b.campaign_id AND k.key_reference=ANY(b.key_references) AND k.sealed_private_key IS NOT NULL;
 RETURN result;
END $$;

GRANT CREATE ON SCHEMA intake,core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='intake' AND p.proname IN ('campaign_key_sealed_guard','batch_sealed_keys'))
    OR (n.nspname='core' AND p.proname='register_campaign_key' AND p.pronargs=5) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA intake,core FROM orgfit_access_executor;
GRANT EXECUTE ON FUNCTION core.register_campaign_key(uuid,uuid,text,bytea,bytea) TO orgfit_staff;
GRANT EXECUTE ON FUNCTION intake.batch_sealed_keys(uuid,bigint) TO orgfit_processor;
