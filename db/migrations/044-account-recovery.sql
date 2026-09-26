CREATE TABLE collab_admin.account_recoveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id text NOT NULL REFERENCES public."user"(id),token_hash text UNIQUE NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',consumed_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE collab_admin.recovery_authority (transaction_id bigint NOT NULL,user_id text NOT NULL,PRIMARY KEY(transaction_id,user_id));
-- No user-settable session flag can disable the MFA guard. Only redeeming a
-- valid, host-operator-issued ticket inserts this transaction-bound authority.
CREATE OR REPLACE FUNCTION collab.guard_mfa() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD."twoFactorEnabled" AND NOT NEW."twoFactorEnabled" AND collab.user_requires_mfa(NEW.id) AND NOT EXISTS(SELECT 1 FROM collab_admin.recovery_authority WHERE transaction_id=txid_current() AND user_id=NEW.id) THEN RAISE EXCEPTION 'mfa_required' USING ERRCODE='P0001';END IF;
 IF NOT coalesce(OLD."twoFactorEnabled",false) AND NEW."twoFactorEnabled" THEN DELETE FROM public.session WHERE "userId"=NEW.id; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION collab_admin.issue_account_recovery(email text, digest text, reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target text; org uuid; ticket collab_admin.account_recoveries;
BEGIN
 SELECT id INTO target FROM public."user" WHERE "user".email=lower(issue_account_recovery.email);
 IF target IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
 FOR org IN SELECT organization_id FROM collab.memberships WHERE user_id=target ORDER BY organization_id LOOP PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));END LOOP;
 PERFORM 1 FROM public."user" WHERE id=target FOR UPDATE;
 UPDATE collab_admin.account_recoveries SET revoked_at=now() WHERE user_id=target AND consumed_at IS NULL AND revoked_at IS NULL;
 INSERT INTO collab_admin.account_recoveries(user_id,token_hash,reason) VALUES(target,digest,reason) RETURNING * INTO ticket;
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) SELECT organization_id,target,'account.recovery_issued',target,jsonb_build_object('ticketId',ticket.id,'reason',reason,'authority','host-operator','expiresAt',ticket.expires_at) FROM collab.memberships WHERE user_id=target;
 RETURN jsonb_build_object('id',ticket.id,'expiresAt',ticket.expires_at);
END $$;
CREATE FUNCTION collab.account_recovery_valid(digest text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM collab_admin.account_recoveries WHERE token_hash=digest AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp())
$$;
CREATE FUNCTION collab.redeem_account_recovery(digest text, password_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t collab_admin.account_recoveries; org uuid; r uuid;
BEGIN
 SELECT * INTO t FROM collab_admin.account_recoveries WHERE token_hash=digest;
 IF t.id IS NULL THEN RAISE EXCEPTION 'account_recovery_unavailable' USING ERRCODE='P0001'; END IF;
 FOR org IN SELECT organization_id FROM collab.memberships WHERE user_id=t.user_id ORDER BY organization_id LOOP PERFORM pg_advisory_xact_lock(hashtextextended(org::text,811));END LOOP;
 PERFORM 1 FROM public."user" WHERE id=t.user_id FOR UPDATE;
 SELECT * INTO STRICT t FROM collab_admin.account_recoveries WHERE id=t.id FOR UPDATE;
 IF t.consumed_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'account_recovery_unavailable' USING ERRCODE='P0001';END IF;
 IF password_hash IS NULL OR length(password_hash) NOT BETWEEN 50 AND 512 THEN RAISE EXCEPTION 'invalid_recovery_password';END IF;
 UPDATE collab_admin.account_recoveries SET consumed_at=now() WHERE id=t.id;
 INSERT INTO collab_admin.recovery_authority VALUES(txid_current(),t.user_id);
 UPDATE public."user" SET "twoFactorEnabled"=false,"updatedAt"=now() WHERE id=t.user_id;
 DELETE FROM collab_admin.recovery_authority WHERE transaction_id=txid_current() AND user_id=t.user_id;
 DELETE FROM public."twoFactor" WHERE "userId"=t.user_id;
 DELETE FROM public.session WHERE "userId"=t.user_id;
 DELETE FROM public.verification WHERE value=t.user_id;
 UPDATE public.account SET password=password_hash,"updatedAt"=now() WHERE "userId"=t.user_id AND "providerId"='credential';
 IF NOT FOUND THEN INSERT INTO public.account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES(gen_random_uuid()::text,t.user_id,'credential',t.user_id,password_hash,now(),now());END IF;
 UPDATE collab.memberships SET authorization_version=authorization_version+1 WHERE user_id=t.user_id;
 UPDATE collab.project_memberships SET authorization_version=authorization_version+1 WHERE user_id=t.user_id;
 FOR r IN SELECT id FROM collab.runs WHERE requested_by=t.user_id AND status IN ('queued','starting','running','waiting_input','stopping') ORDER BY id LOOP PERFORM collab_worker.request_stop(r,'account_recovered');END LOOP;
 UPDATE collab_gateway.capabilities SET revoked=true WHERE run_id IN (SELECT id FROM collab.runs WHERE requested_by=t.user_id);
 INSERT INTO collab.audit_events(organization_id,actor_id,action,resource_id,detail) SELECT organization_id,t.user_id,'account.recovered',t.user_id,jsonb_build_object('ticketId',t.id,'authority','host-operator-ticket','mfaReenrollmentRequired',true) FROM collab.memberships WHERE user_id=t.user_id;
 RETURN jsonb_build_object('recovered',true,'signInRequired',true);
END $$;
REVOKE EXECUTE ON FUNCTION collab_admin.issue_account_recovery(text,text,text),collab.account_recovery_valid(text),collab.redeem_account_recovery(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.account_recovery_valid(text),collab.redeem_account_recovery(text,text) TO pi_collab_app;
