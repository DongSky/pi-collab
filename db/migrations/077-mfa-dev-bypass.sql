-- MFA bypass for development/testing.
-- When the pi_collab.disable_mfa setting is '1' (set by the app when
-- PI_COLLAB_DISABLE_MFA=1), user_requires_mfa() returns false for everyone
-- and actor_has_mfa() returns true for everyone.
-- This is a dev/test escape hatch only; never enable in production.
CREATE OR REPLACE FUNCTION collab.user_requires_mfa(uid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT current_setting('pi_collab.disable_mfa', true) IS DISTINCT FROM '1'
    AND EXISTS(SELECT 1 FROM collab.memberships WHERE user_id=uid AND active AND role IN ('owner','admin'))
$$;

CREATE OR REPLACE FUNCTION collab.actor_has_mfa() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT current_setting('pi_collab.disable_mfa', true) = '1'
    OR EXISTS(SELECT 1 FROM public."user" WHERE id=collab.actor() AND "twoFactorEnabled")
$$;
