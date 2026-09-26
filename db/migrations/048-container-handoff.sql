-- Container clones use the same immutable snapshot/dependency/contract artifacts.
-- Keep every existing identity, permission, revision and input check. Validation
-- and host Git delivery remain gated separately until their container path is verified.
DO $$
DECLARE signature text; previous text; updated text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
 'collab.submit_run_snapshot_v1(uuid,uuid,text,text,text,uuid,integer,uuid,uuid)',
 'collab.submit_run_results_v1(uuid,uuid,text,text,text,uuid,integer,uuid,uuid)',
 'collab.submit_run_contracts_v17(uuid,uuid,text,text,text,uuid,integer,uuid,uuid)'
 ] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO previous;
  updated:=replace(previous,'runtime_mode<>''native''','runtime_mode NOT IN (''native'',''docker'')');
  IF updated=previous THEN RAISE EXCEPTION 'Missing container handoff gate: %',signature; END IF;
  EXECUTE updated;
 END LOOP;
END $$;
