-- Phase 07: respondent drafts, the restricted encrypted submission inbox, the
-- per-campaign key register and the processing batch.
--
-- Everything created here is TEMPORARY IDENTITY-LINKED STAGING inside the core
-- database. It is deliberately not the finalized anonymous answer store, which
-- lives in a separate database with its own credentials (db/anonymous).
--
-- Two new deployment identities appear here:
--   orgfit_gateway    the public respondent origin. May execute the draft,
--                     review and acceptance routines. Holds no table privilege
--                     at all and cannot read any draft or envelope directly.
--   orgfit_processor  the privacy processor. May freeze a batch, read the
--                     ciphertext it froze, and clean it up after a proven
--                     anonymous commit. It cannot accept a submission, cannot
--                     read a draft, and cannot see a participant row.
-- orgfit_staff receives NOTHING in this migration: no table, no column, no
-- routine. There is deliberately no staff route that reads, decrypts, searches,
-- exports or recovers an individual draft or submitted answer.

-- ---------------------------------------------------------------------------
-- Compatible repair carried by this phase (defect R-001).
--
-- Migration 005 intended a PUBLISHED questionnaire version to always carry a
-- 32-byte content hash, but wrote the rule as
--   (state='DRAFT' AND ...) OR (state<>'DRAFT' AND octet_length(schema_hash)=32 AND ...)
-- With schema_hash NULL the second branch evaluates to NULL rather than false,
-- so the whole CHECK is NULL and PostgreSQL accepts the row. A PUBLISHED
-- version with no hash therefore slipped through.
--
-- Phase 07 binds every accepted envelope and every anonymous manifest to that
-- hash, so a null one would silently disable a real integrity check. The
-- constraint is restated with an explicit NOT NULL test. Existing rows are
-- validated by the ALTER; there are no published versions without a hash in any
-- checked-out database, and a fresh install gets the corrected rule from here.
-- ---------------------------------------------------------------------------
ALTER TABLE instrument.questionnaire_version DROP CONSTRAINT questionnaire_version_check;
ALTER TABLE instrument.questionnaire_version ADD CONSTRAINT questionnaire_version_check CHECK(
 (state='DRAFT' AND schema_hash IS NULL AND published_at IS NULL)
 OR (state<>'DRAFT' AND schema_hash IS NOT NULL AND octet_length(schema_hash)=32 AND published_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Per-campaign sealed-box key register (IN1).
-- Only the PUBLIC key is stored. Private keys live solely in the key custody
-- service; see docs/orgfit/respondent.md for the development stand-in and P-003
-- for the real custodian requirement.
-- ---------------------------------------------------------------------------
CREATE TABLE intake.campaign_key (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL,
 key_reference text NOT NULL UNIQUE CHECK(key_reference ~ '^ck_[0-9a-f]{32}$'),
 public_key bytea NOT NULL CHECK(octet_length(public_key)=32),
 key_epoch integer NOT NULL CHECK(key_epoch>0),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DECRYPT_ONLY','DELETE_REQUESTED','DESTROYED')),
 destroy_not_before timestamptz, destruction_evidence text CHECK(length(destruction_evidence)<=2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,campaign_id,key_epoch), UNIQUE(organization_id,campaign_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id)
);
CREATE UNIQUE INDEX campaign_key_active ON intake.campaign_key(organization_id,campaign_id) WHERE state='ACTIVE';
CREATE INDEX ON intake.campaign_key(campaign_id,state);

-- ---------------------------------------------------------------------------
-- DF1 encrypted drafts. The row holds opaque ciphertext only. The server has
-- never seen, and cannot derive, the AES-256-GCM key: the browser generated it
-- and it is carried only inside the respondent's private resume code.
-- `id` IS the public draft handle chosen by the browser.
-- ---------------------------------------------------------------------------
CREATE TABLE intake.draft_blob (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, invitation_id uuid NOT NULL,
 cipher_version text NOT NULL CHECK(cipher_version='DF1'),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 16 AND 2097152),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 expires_at timestamptz NOT NULL,
 UNIQUE(organization_id,invitation_id),
 FOREIGN KEY(organization_id,campaign_id,invitation_id) REFERENCES core.invitation(organization_id,campaign_id,id)
);
CREATE INDEX ON intake.draft_blob(expires_at);
CREATE INDEX ON intake.draft_blob(organization_id,campaign_id);

-- ---------------------------------------------------------------------------
-- The restricted submission inbox. `id` is the envelope identifier and is never
-- copied anywhere else; no created_at column exists, because an exact per-person
-- acceptance instant is precisely the correlation channel the blueprint forbids.
-- The UNIQUE(organization_id,invitation_id) constraint is what makes "exactly
-- one accepted immutable payload" a database fact rather than an intention.
-- ---------------------------------------------------------------------------
CREATE TABLE intake.submission_inbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL, invitation_id uuid NOT NULL,
 cipher_version text NOT NULL CHECK(cipher_version='IN1'),
 key_reference text NOT NULL REFERENCES intake.campaign_key(key_reference),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 48 AND 2097152),
 batch_id uuid,
 UNIQUE(organization_id,invitation_id),
 FOREIGN KEY(organization_id,campaign_id,invitation_id) REFERENCES core.invitation(organization_id,campaign_id,id)
);
CREATE INDEX ON intake.submission_inbox(organization_id,campaign_id,batch_id);

-- ---------------------------------------------------------------------------
-- One batch per campaign. Records campaign-level counts and status only; it is
-- deliberately not an envelope-to-response map, and no such map exists anywhere.
-- ---------------------------------------------------------------------------
CREATE TABLE intake.processing_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES core.organization,
 campaign_id uuid NOT NULL,
 manifest_hash bytea NOT NULL CHECK(octet_length(manifest_hash)=32),
 accepted_count integer NOT NULL CHECK(accepted_count>=0),
 processed_count integer CHECK(processed_count>=0),
 state text NOT NULL DEFAULT 'FROZEN' CHECK(state IN ('FROZEN','PROCESSING','OUTPUT_COMMITTED','CLEANUP_PENDING','CLEANED','INSUFFICIENT','CANCELLED','PURGED','FAILED')),
 lease_generation bigint NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
 lease_expires_at timestamptz,
 key_references text[] NOT NULL DEFAULT ARRAY[]::text[],
 cleanup_deadline timestamptz,
 failure_code text CHECK(length(failure_code)<=200),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,campaign_id), UNIQUE(organization_id,campaign_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES core.campaign(organization_id,id)
);
ALTER TABLE intake.submission_inbox
 ADD FOREIGN KEY(organization_id,campaign_id,batch_id) REFERENCES intake.processing_batch(organization_id,campaign_id,id);

-- ---------------------------------------------------------------------------
-- Privileges. Row security is defence in depth on top of these grants; the
-- primary barrier is that staff credentials hold no privilege here at all.
-- ---------------------------------------------------------------------------
GRANT SELECT,INSERT,UPDATE,DELETE ON intake.campaign_key,intake.draft_blob,intake.submission_inbox,intake.processing_batch TO orgfit_access_executor;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intake.campaign_key','intake.draft_blob','intake.submission_inbox','intake.processing_batch'] LOOP
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY executor ON %s TO orgfit_access_executor USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY migration ON %s TO orgfit_core_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Session resolution shared by every respondent routine. Returns the invitation
-- when, and only when, the session is live, the token generation still matches,
-- the invitation is READY and the campaign is genuinely OPEN at the database
-- clock. Every draft and acceptance path goes through this; there is no other
-- entry point, and no path trusts a client-supplied organization, campaign,
-- version, group or participant.
-- ---------------------------------------------------------------------------
CREATE FUNCTION intake.session_invitation(session_digest_in bytea, renew boolean DEFAULT false)
RETURNS core.invitation LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s intake.respondent_session; i core.invitation; c core.campaign; ts timestamptz:=clock_timestamp(); BEGIN
 IF session_digest_in IS NULL OR octet_length(session_digest_in)<>32 THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 SELECT * INTO s FROM intake.respondent_session WHERE session_digest=session_digest_in;
 IF NOT FOUND OR s.expires_at<=ts OR s.absolute_expires_at<=ts THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 SELECT * INTO i FROM core.invitation WHERE id=s.invitation_id;
 IF i.status='REVOKED' OR i.token_generation<>s.token_generation THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF i.status='COMPLETED' THEN RAISE EXCEPTION 'ALREADY_ACCEPTED'; END IF;
 c:=core.normalize_campaign(i.campaign_id);
 IF c.state='CANCELLED' THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF core.effective_state(c.state,c.starts_at,c.ends_at)<>'OPEN' THEN RAISE EXCEPTION 'COLLECTION_UNAVAILABLE'; END IF;
 IF renew THEN
 UPDATE intake.respondent_session SET expires_at=least(ts+interval '30 minutes',absolute_expires_at) WHERE id=s.id;
 END IF;
 RETURN i;
END $$;

-- The frozen instrument as the respondent must see it, resolved entirely from
-- the pinned version. There is no client-supplied version parameter anywhere.
CREATE FUNCTION intake.gateway_instrument(session_digest_in bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; c core.campaign; v instrument.questionnaire_version; nodes jsonb:='[]'::jsonb; t text; part jsonb; BEGIN
 i:=intake.session_invitation(session_digest_in);
 SELECT * INTO c FROM core.campaign WHERE id=i.campaign_id;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=c.version_id AND scope_id=c.instrument_scope_id;
 IF NOT FOUND OR v.state='DRAFT' THEN RAISE EXCEPTION 'COLLECTION_UNAVAILABLE'; END IF;
 FOREACH t IN ARRAY ARRAY['section','dimension','question','question_option','matrix_row','matrix_column','score_definition','interpretation_band'] LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''table'',%L,''position'',position,''parentId'',parent_id,''payload'',payload)),''[]''::jsonb)
  FROM instrument.%I WHERE scope_id=$1 AND version_id=$2',t,t) INTO part USING v.scope_id, v.id;
 nodes:=nodes||part;
 END LOOP;
 RETURN jsonb_build_object('versionId',v.id,'instrumentHash',encode(v.schema_hash,'hex'),
 'metadata',v.metadata,'nodes',nodes,'locales',to_jsonb(c.locales),
 'notice',coalesce(c.frozen_manifest->'notice','{}'::jsonb),'endsAt',c.ends_at);
END $$;

-- Everything finalization needs, resolved from the session alone. The gateway
-- holds no table privilege, so this is the only way it can learn the frozen
-- report group — and it can never learn a participant identifier or a name.
CREATE FUNCTION intake.finalization_context(session_digest_in bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; c core.campaign; v instrument.questionnaire_version; grp uuid; k intake.campaign_key; BEGIN
 i:=intake.session_invitation(session_digest_in);
 SELECT * INTO c FROM core.campaign WHERE id=i.campaign_id;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=c.version_id AND scope_id=c.instrument_scope_id;
 IF NOT FOUND OR v.state='DRAFT' THEN RAISE EXCEPTION 'COLLECTION_UNAVAILABLE'; END IF;
 SELECT report_group_id INTO grp FROM core.campaign_roster
 WHERE organization_id=i.organization_id AND campaign_id=i.campaign_id AND invitation_id=i.id;
 IF grp IS NULL THEN RAISE EXCEPTION 'COLLECTION_UNAVAILABLE'; END IF;
 SELECT * INTO k FROM intake.campaign_key WHERE campaign_id=i.campaign_id AND state='ACTIVE';
 -- Fail closed: with no authenticated campaign key there is nothing to seal to,
 -- and a retryable failure is correct because the link is not consumed.
 IF NOT FOUND THEN RAISE EXCEPTION 'TEMPORARILY_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('organizationId',i.organization_id,'campaignId',i.campaign_id,
 'invitationId',i.id,'versionId',v.id,'instrumentHash',encode(v.schema_hash,'hex'),
 'reportGroupId',grp,'keyReference',k.key_reference,'publicKey',encode(k.public_key,'base64'));
END $$;

-- ---------------------------------------------------------------------------
-- Draft routines. The server stores opaque bytes and enforces the binding and
-- the optimistic revision. It cannot verify the GCM tag and cannot decrypt.
-- ---------------------------------------------------------------------------
CREATE FUNCTION intake.draft_create(session_digest_in bytea,handle uuid,nonce_in bytea,ciphertext_in bytea,ttl interval DEFAULT interval '30 days')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; c core.campaign; ts timestamptz:=clock_timestamp(); exp timestamptz; BEGIN
 i:=intake.session_invitation(session_digest_in,true);
 SELECT * INTO c FROM core.campaign WHERE id=i.campaign_id;
 -- Idle TTL is renewed by an acknowledged write and capped at closure+7 days
 -- so an indefinitely open campaign cannot retain ciphertext forever.
 exp:=least(ts+ttl,coalesce(c.ends_at,ts+ttl)+interval '7 days');
 IF EXISTS(SELECT 1 FROM intake.draft_blob WHERE organization_id=i.organization_id AND invitation_id=i.id) THEN
 RAISE EXCEPTION 'DRAFT_EXISTS';
 END IF;
 INSERT INTO intake.draft_blob(id,organization_id,campaign_id,invitation_id,cipher_version,nonce,ciphertext,revision,expires_at)
 VALUES(handle,i.organization_id,i.campaign_id,i.id,'DF1',nonce_in,ciphertext_in,1,exp);
 RETURN jsonb_build_object('handle',handle,'revision',1,'expiresAt',exp);
END $$;

CREATE FUNCTION intake.draft_save(session_digest_in bytea,handle uuid,nonce_in bytea,ciphertext_in bytea,expected bigint,ttl interval DEFAULT interval '30 days')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; c core.campaign; d intake.draft_blob; ts timestamptz:=clock_timestamp(); exp timestamptz; BEGIN
 i:=intake.session_invitation(session_digest_in,true);
 SELECT * INTO d FROM intake.draft_blob WHERE organization_id=i.organization_id AND invitation_id=i.id FOR UPDATE;
 -- A handle that is not bound to THIS invitation is indistinguishable from one
 -- that does not exist: a link holder learns nothing about another draft.
 IF NOT FOUND OR d.id<>handle OR d.expires_at<=ts THEN RAISE EXCEPTION 'DRAFT_UNAVAILABLE'; END IF;
 IF expected IS NULL OR d.revision<>expected THEN RAISE EXCEPTION 'DRAFT_CONFLICT'; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=i.campaign_id;
 exp:=least(ts+ttl,coalesce(c.ends_at,ts+ttl)+interval '7 days');
 UPDATE intake.draft_blob SET nonce=nonce_in,ciphertext=ciphertext_in,revision=d.revision+1,expires_at=exp WHERE id=d.id;
 RETURN jsonb_build_object('handle',d.id,'revision',d.revision+1,'expiresAt',exp);
END $$;

-- Resume. Returns ciphertext only, and only for the handle already bound to the
-- authenticated invitation. The decryption key is not here and never was: an
-- administrator holding the original invitation link gets these bytes and
-- nothing else.
CREATE FUNCTION intake.draft_read(session_digest_in bytea,handle uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; d intake.draft_blob; ts timestamptz:=clock_timestamp(); BEGIN
 i:=intake.session_invitation(session_digest_in);
 SELECT * INTO d FROM intake.draft_blob WHERE organization_id=i.organization_id AND invitation_id=i.id;
 IF NOT FOUND OR d.id<>handle OR d.expires_at<=ts THEN RAISE EXCEPTION 'DRAFT_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('handle',d.id,'cipherVersion',d.cipher_version,'nonce',encode(d.nonce,'base64'),
 'ciphertext',encode(d.ciphertext,'base64'),'revision',d.revision,'expiresAt',d.expires_at);
END $$;

-- Explicit lost-code recovery. The old ciphertext is deleted, so the old key
-- can never open anything again, and any concurrent save on it now fails.
CREATE FUNCTION intake.draft_start_over(session_digest_in bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; n integer; BEGIN
 i:=intake.session_invitation(session_digest_in,true);
 DELETE FROM intake.draft_blob WHERE organization_id=i.organization_id AND invitation_id=i.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n>0;
END $$;

-- ---------------------------------------------------------------------------
-- The acceptance transaction. Blueprint 6.3 and D-018 in one routine.
--
-- Lock order is campaign then invitation, matching every control operation in
-- migration 008, so closure and finalization can race safely in either order.
-- The wall clock is sampled AFTER both locks are held and after the caller has
-- validated and sealed the payload; that sample is the linearization point.
-- ---------------------------------------------------------------------------
CREATE FUNCTION intake.accept(session_digest_in bytea,key_reference_in text,ciphertext_in bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s intake.respondent_session; i core.invitation; c core.campaign; k intake.campaign_key; ts timestamptz; BEGIN
 IF session_digest_in IS NULL OR octet_length(session_digest_in)<>32 THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 SELECT * INTO s FROM intake.respondent_session WHERE session_digest=session_digest_in;
 IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;

 -- 1. Campaign lock, then invitation lock. Never the reverse.
 SELECT * INTO c FROM core.campaign WHERE id=s.campaign_id FOR UPDATE;
 SELECT * INTO i FROM core.invitation WHERE id=s.invitation_id FOR UPDATE;

 ts:=clock_timestamp();
 -- 2. Session validity is rechecked under the lock, not before it.
 IF s.expires_at<=ts OR s.absolute_expires_at<=ts THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 IF i.status='REVOKED' OR i.token_generation<>s.token_generation THEN RAISE EXCEPTION 'SESSION_REQUIRED'; END IF;
 -- 3. A second attempt on an already accepted invitation is not an error and
 -- not an overwrite. It returns the same generic acceptance, with no response
 -- identifier, no timestamp and no comparison against the stored payload.
 IF i.status='COMPLETED' THEN RETURN jsonb_build_object('access','ACCEPTED','duplicate',true); END IF;
 -- 4. State and time are rechecked under the lock against the database clock.
 IF c.state='CANCELLED' OR core.effective_state(c.state,c.starts_at,c.ends_at)<>'OPEN' THEN
 RAISE EXCEPTION 'COLLECTION_UNAVAILABLE';
 END IF;
 SELECT * INTO k FROM intake.campaign_key WHERE campaign_id=c.id AND key_reference=key_reference_in AND state='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'TEMPORARILY_UNAVAILABLE'; END IF;
 -- A frozen batch means the closed set is already fixed; nothing may join it.
 IF EXISTS(SELECT 1 FROM intake.processing_batch WHERE campaign_id=c.id) THEN RAISE EXCEPTION 'COLLECTION_UNAVAILABLE'; END IF;

 -- 5. One local transaction: envelope, completion and draft removal together.
 INSERT INTO intake.submission_inbox(organization_id,campaign_id,invitation_id,cipher_version,key_reference,ciphertext)
 VALUES(i.organization_id,i.campaign_id,i.id,'IN1',key_reference_in,ciphertext_in);
 UPDATE core.invitation SET status='COMPLETED' WHERE id=i.id;
 DELETE FROM intake.draft_blob WHERE organization_id=i.organization_id AND invitation_id=i.id;
 -- Sibling sessions are deliberately LEFT ALIVE. A respondent with a second tab,
 -- or a client retrying after a lost success response, must be able to learn
 -- "ACCEPTED" from the ordinary status route rather than be told their session
 -- is invalid. A live session on a COMPLETED invitation can do nothing else:
 -- every draft routine refuses it and accept() returns the same generic result.
 RETURN jsonb_build_object('access','ACCEPTED','duplicate',false);
END $$;

-- ---------------------------------------------------------------------------
-- Processor routines. The processor never sees a participant, a name, a token
-- digest or a draft: its grants below cover exactly these five routines.
-- ---------------------------------------------------------------------------

-- Freeze the accepted set of a CLOSED campaign under the campaign lock. Idempotent:
-- a second call returns the SAME batch with the same identifier and count, so a
-- crashed worker can never freeze a different subset.
CREATE FUNCTION intake.freeze_batch(cid uuid,lease interval DEFAULT interval '30 minutes') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; b intake.processing_batch; completed integer; envelopes integer; ts timestamptz; mh bytea; BEGIN
 c:=core.normalize_campaign(cid);
 SELECT * INTO c FROM core.campaign WHERE id=cid FOR UPDATE;
 ts:=clock_timestamp();
 SELECT * INTO b FROM intake.processing_batch WHERE campaign_id=cid FOR UPDATE;
 IF FOUND THEN
 -- Existing batch: take the lease, never re-derive the frozen set.
 UPDATE intake.processing_batch SET lease_generation=b.lease_generation+1,lease_expires_at=ts+lease,updated_at=ts
  WHERE id=b.id RETURNING * INTO b;
 RETURN jsonb_build_object('batchId',b.id,'organizationId',b.organization_id,'campaignId',b.campaign_id,
  'acceptedCount',b.accepted_count,'manifestHash',encode(b.manifest_hash,'hex'),'state',b.state,
  'leaseGeneration',b.lease_generation,'keyReferences',to_jsonb(b.key_references),'created',false);
 END IF;
 IF c.state='CANCELLED' THEN RAISE EXCEPTION 'CAMPAIGN_CANCELLED'; END IF;
 IF core.effective_state(c.state,c.starts_at,c.ends_at)<>'CLOSED' THEN RAISE EXCEPTION 'CAMPAIGN_NOT_CLOSED'; END IF;
 SELECT count(*) INTO completed FROM core.invitation WHERE campaign_id=cid AND status='COMPLETED';
 SELECT count(*) INTO envelopes FROM intake.submission_inbox WHERE campaign_id=cid;
 -- Accepted-versus-stored reconciliation happens before anything is decrypted.
 IF completed<>envelopes THEN RAISE EXCEPTION 'COUNT_MISMATCH'; END IF;
 mh:=sha256(convert_to(jsonb_build_object('schemaVersion',1,'campaignId',c.id,'organizationId',c.organization_id,
  'versionId',c.version_id,'manifest',c.frozen_manifest)::text,'UTF8'));
 INSERT INTO intake.processing_batch(organization_id,campaign_id,manifest_hash,accepted_count,state,lease_generation,lease_expires_at,key_references)
 VALUES(c.organization_id,cid,mh,envelopes,CASE WHEN envelopes>=c.threshold THEN 'FROZEN' ELSE 'INSUFFICIENT' END,1,ts+lease,
  ARRAY(SELECT key_reference FROM intake.campaign_key WHERE campaign_id=cid ORDER BY key_epoch))
 RETURNING * INTO b;
 UPDATE intake.submission_inbox SET batch_id=b.id WHERE campaign_id=cid;
 UPDATE intake.campaign_key SET state='DECRYPT_ONLY' WHERE campaign_id=cid AND state='ACTIVE';
 RETURN jsonb_build_object('batchId',b.id,'organizationId',b.organization_id,'campaignId',b.campaign_id,
 'acceptedCount',b.accepted_count,'manifestHash',encode(b.manifest_hash,'hex'),'state',b.state,
 'leaseGeneration',b.lease_generation,'keyReferences',to_jsonb(b.key_references),'created',true);
END $$;

-- The frozen ciphertext set plus the sanitized manifest. Fails if the caller's
-- lease generation has been superseded by another worker.
CREATE FUNCTION intake.batch_payload(bid uuid,lease_gen bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b intake.processing_batch; c core.campaign; v instrument.questionnaire_version;
 rows jsonb; nodes jsonb:='[]'::jsonb; t text; part jsonb; BEGIN
 SELECT * INTO b FROM intake.processing_batch WHERE id=bid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF b.lease_generation<>lease_gen THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 SELECT * INTO c FROM core.campaign WHERE id=b.campaign_id;
 SELECT * INTO v FROM instrument.questionnaire_version WHERE id=c.version_id AND scope_id=c.instrument_scope_id;
 FOREACH t IN ARRAY ARRAY['section','dimension','question','question_option','matrix_row','matrix_column','score_definition','interpretation_band'] LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''table'',%L,''position'',position,''parentId'',parent_id,''payload'',payload)),''[]''::jsonb)
  FROM instrument.%I WHERE scope_id=$1 AND version_id=$2',t,t) INTO part USING v.scope_id, v.id;
 nodes:=nodes||part;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('keyReference',e.key_reference,'ciphertext',encode(e.ciphertext,'base64'))
  ORDER BY e.id),'[]'::jsonb) INTO rows FROM intake.submission_inbox e WHERE e.batch_id=bid;
 RETURN jsonb_build_object('batchId',b.id,'organizationId',b.organization_id,'campaignId',b.campaign_id,
 'versionId',c.version_id,'acceptedCount',b.accepted_count,'state',b.state,
 'manifestHash',encode(b.manifest_hash,'hex'),
 'manifest',c.frozen_manifest,'threshold',c.threshold,'envelopes',rows,
 'instrument',jsonb_build_object('metadata',v.metadata,'nodes',nodes));
END $$;

CREATE FUNCTION intake.batch_state(bid uuid,lease_gen bigint,next_state text,processed integer DEFAULT NULL,failure text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b intake.processing_batch; ts timestamptz:=clock_timestamp(); BEGIN
 SELECT * INTO b FROM intake.processing_batch WHERE id=bid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF b.lease_generation<>lease_gen THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 IF b.state IN ('CLEANED','PURGED') AND next_state<>b.state THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE intake.processing_batch SET state=next_state,updated_at=ts,
 processed_count=coalesce(processed,b.processed_count),failure_code=failure,
 cleanup_deadline=CASE WHEN next_state='OUTPUT_COMMITTED' THEN ts+interval '7 days' ELSE b.cleanup_deadline END
 WHERE id=bid;
 RETURN next_state;
END $$;

-- Cleanup is authorized only by a proven anonymous commit, which the caller
-- establishes by reading the marker in the anonymous database first. Envelopes
-- are deleted rather than marked, so no input-to-output receipt can survive.
CREATE FUNCTION intake.batch_cleanup(bid uuid,lease_gen bigint,evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b intake.processing_batch; removed integer; drafts integer; ts timestamptz:=clock_timestamp(); BEGIN
 SELECT * INTO b FROM intake.processing_batch WHERE id=bid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF b.lease_generation<>lease_gen THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 IF b.state NOT IN ('OUTPUT_COMMITTED','CLEANUP_PENDING','INSUFFICIENT','CANCELLED','CLEANED') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 DELETE FROM intake.submission_inbox WHERE batch_id=bid;
 GET DIAGNOSTICS removed=ROW_COUNT;
 DELETE FROM intake.draft_blob WHERE campaign_id=b.campaign_id;
 GET DIAGNOSTICS drafts=ROW_COUNT;
 DELETE FROM intake.respondent_session WHERE campaign_id=b.campaign_id;
 UPDATE intake.campaign_key SET state='DELETE_REQUESTED',destroy_not_before=ts,
 destruction_evidence=left(evidence,2000) WHERE campaign_id=b.campaign_id AND state<>'DESTROYED';
 -- key_references is emptied here; only campaign-level counts and status remain.
 UPDATE intake.processing_batch SET state='CLEANUP_PENDING',updated_at=ts,key_references=ARRAY[]::text[] WHERE id=bid;
 RETURN jsonb_build_object('envelopesDeleted',removed,'draftsDeleted',drafts);
END $$;

-- Recorded only after the custody service confirms every private key epoch for
-- this campaign is destroyed, including provider recovery windows. Until then
-- the batch stays CLEANUP_PENDING and publication stays blocked.
CREATE FUNCTION intake.keys_destroyed(bid uuid,lease_gen bigint,evidence text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b intake.processing_batch; ts timestamptz:=clock_timestamp(); BEGIN
 SELECT * INTO b FROM intake.processing_batch WHERE id=bid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF b.lease_generation<>lease_gen THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 IF EXISTS(SELECT 1 FROM intake.submission_inbox WHERE campaign_id=b.campaign_id) THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 UPDATE intake.campaign_key SET state='DESTROYED',destruction_evidence=left(evidence,2000) WHERE campaign_id=b.campaign_id;
 UPDATE intake.processing_batch SET state=CASE WHEN b.state='CLEANUP_PENDING' THEN 'CLEANED' ELSE b.state END,updated_at=ts WHERE id=bid;
 RETURN (SELECT state FROM intake.processing_batch WHERE id=bid);
END $$;

-- Campaign-level release readiness, for Phase 08 and for operator alerting. It
-- reports counts and status; it exposes no answer and no individual.
CREATE FUNCTION core.release_readiness(cid uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c core.campaign; b intake.processing_batch; completed integer; BEGIN
 SELECT * INTO c FROM core.campaign WHERE id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT count(*) INTO completed FROM core.invitation WHERE campaign_id=cid AND status='COMPLETED';
 SELECT * INTO b FROM intake.processing_batch WHERE campaign_id=cid;
 RETURN jsonb_build_object('campaignId',cid,'organizationId',c.organization_id,
 'campaignState',core.effective_state(c.state,c.starts_at,c.ends_at),
 'threshold',c.threshold,'acceptedCount',completed,
 'batchState',b.state,'batchAcceptedCount',b.accepted_count,'processedCount',b.processed_count,
 'countsAgree',b.id IS NOT NULL AND b.accepted_count=completed AND b.processed_count IS NOT DISTINCT FROM b.accepted_count,
 'releasable',b.id IS NOT NULL AND b.state='CLEANED' AND b.accepted_count>=c.threshold
  AND b.processed_count=b.accepted_count AND b.accepted_count=completed);
END $$;

-- Development/operational cleanup of expired drafts and sessions. It removes
-- rows by expiry only; it cannot select, read or report a draft's content.
CREATE FUNCTION intake.expire_temporary(limit_rows integer DEFAULT 1000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d integer; s integer; ts timestamptz:=clock_timestamp(); BEGIN
 DELETE FROM intake.draft_blob WHERE id IN (SELECT id FROM intake.draft_blob WHERE expires_at<=ts LIMIT limit_rows);
 GET DIAGNOSTICS d=ROW_COUNT;
 DELETE FROM intake.respondent_session WHERE id IN (SELECT id FROM intake.respondent_session WHERE absolute_expires_at<=ts LIMIT limit_rows);
 GET DIAGNOSTICS s=ROW_COUNT;
 RETURN jsonb_build_object('drafts',d,'sessions',s);
END $$;

-- Key provisioning, called inside the staff launch transaction. The caller
-- supplies only a reference and a PUBLIC key obtained from the key custody
-- service; no private key ever reaches this database.
CREATE FUNCTION core.register_campaign_key(org uuid,cid uuid,reference text,pubkey bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE epoch integer; BEGIN
 PERFORM core.campaign_guard(org,false);
 IF NOT EXISTS(SELECT 1 FROM core.campaign WHERE id=cid AND organization_id=org) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF EXISTS(SELECT 1 FROM intake.campaign_key WHERE campaign_id=cid AND state='ACTIVE') THEN RAISE EXCEPTION 'STATE_CONFLICT'; END IF;
 SELECT coalesce(max(key_epoch),0)+1 INTO epoch FROM intake.campaign_key WHERE campaign_id=cid;
 INSERT INTO intake.campaign_key(organization_id,campaign_id,key_reference,public_key,key_epoch)
 VALUES(org,cid,reference,pubkey,epoch);
 RETURN reference;
END $$;

-- The gateway's own read of the campaign's ACTIVE public key. Fails closed.
CREATE FUNCTION intake.active_campaign_key(session_digest_in bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i core.invitation; k intake.campaign_key; BEGIN
 i:=intake.session_invitation(session_digest_in);
 SELECT * INTO k FROM intake.campaign_key WHERE campaign_id=i.campaign_id AND state='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'TEMPORARILY_UNAVAILABLE'; END IF;
 RETURN jsonb_build_object('keyReference',k.key_reference,'publicKey',encode(k.public_key,'base64'),'keyEpoch',k.key_epoch);
END $$;

-- ---------------------------------------------------------------------------
-- Ownership and grants.
-- ---------------------------------------------------------------------------
GRANT CREATE ON SCHEMA intake,core TO orgfit_access_executor;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='intake' AND p.proname IN ('session_invitation','gateway_instrument','finalization_context',
  'draft_create','draft_save','draft_read','draft_start_over','accept','freeze_batch','batch_payload',
  'batch_state','batch_cleanup','keys_destroyed','expire_temporary','active_campaign_key'))
 OR (n.nspname='core' AND p.proname IN ('register_campaign_key','release_readiness')) LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO orgfit_access_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA intake,core FROM orgfit_access_executor;

-- orgfit_staff is deliberately NOT granted USAGE on schema intake. The two
-- routines it may call live in core and write into intake as their definer, so
-- a staff credential cannot even name an intake object.
GRANT USAGE ON SCHEMA intake,core TO orgfit_gateway,orgfit_processor;
-- The gateway holds NO table privilege whatsoever. Everything it can do is one
-- of these routines, each of which resolves the invitation from the session.
GRANT EXECUTE ON FUNCTION core.gateway_exchange(bytea,bytea,interval,interval),core.gateway_status(bytea),
 intake.gateway_instrument(bytea),intake.finalization_context(bytea),
 intake.draft_create(bytea,uuid,bytea,bytea,interval),
 intake.draft_save(bytea,uuid,bytea,bytea,bigint,interval),intake.draft_read(bytea,uuid),
 intake.draft_start_over(bytea),intake.accept(bytea,text,bytea),
 intake.active_campaign_key(bytea),intake.session_invitation(bytea,boolean) TO orgfit_gateway;
-- The processor holds no table privilege either, and cannot accept a submission
-- or open a draft: its five routines are batch-scoped.
GRANT EXECUTE ON FUNCTION intake.freeze_batch(uuid,interval),intake.batch_payload(uuid,bigint),
 intake.batch_state(uuid,bigint,text,integer,text),intake.batch_cleanup(uuid,bigint,text),
 intake.keys_destroyed(uuid,bigint,text),core.release_readiness(uuid) TO orgfit_processor;
GRANT EXECUTE ON FUNCTION intake.expire_temporary(integer) TO orgfit_core_owner;
GRANT EXECUTE ON FUNCTION core.register_campaign_key(uuid,uuid,text,bytea) TO orgfit_staff;
-- Phase 08 will read release readiness from the core application; the routine
-- reports campaign-level counts only and is safe for that credential.
GRANT EXECUTE ON FUNCTION core.release_readiness(uuid) TO orgfit_staff;
