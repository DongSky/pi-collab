-- Lease updates never change a run's identity. An exclusive key lock prevents
-- a peer notification from inserting its run_events foreign key while holding
-- the project event counter, deadlocking the peer's concurrent output flush.
-- NO KEY UPDATE still serializes every lease/state writer and key mutation,
-- while allowing foreign-key references to an existing run.
CREATE OR REPLACE FUNCTION collab_worker.assert_lease(executor uuid, run uuid, generation bigint) RETURNS collab.runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r collab.runs; w collab.workspaces;
BEGIN
  SELECT * INTO r FROM collab.runs WHERE id=run FOR NO KEY UPDATE;
  SELECT * INTO w FROM collab.workspaces WHERE id=r.workspace_id FOR UPDATE;
  IF generation IS NULL OR r.id IS NULL OR r.executor_id IS DISTINCT FROM executor OR r.epoch<>generation OR w.epoch<>generation OR w.lease_owner IS DISTINCT FROM executor OR w.lease_expires_at IS NULL OR w.lease_expires_at<=clock_timestamp() OR r.status NOT IN ('starting','running','waiting_input','stopping')
    THEN RAISE EXCEPTION 'stale_lease' USING ERRCODE='P0001'; END IF;
  RETURN r;
END
$$;
