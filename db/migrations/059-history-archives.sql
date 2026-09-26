CREATE FUNCTION collab.history_archive_bytes(files jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(sum(octet_length(file->>'source')),0)::bigint FROM jsonb_array_elements(files) file
$$;
REVOKE ALL ON FUNCTION collab.history_archive_bytes(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.history_archive_bytes(jsonb) TO pi_collab_app;
-- UTF-8 conversion and canonical JSON are deterministic within this database.
CREATE FUNCTION collab.history_archive_hash(files jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(files::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION collab.history_archive_hash(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collab.history_archive_hash(jsonb) TO pi_collab_app;
CREATE TABLE collab.history_archives (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES collab.organizations(id),
 project_id uuid NOT NULL REFERENCES collab.projects(id), owner_id text NOT NULL REFERENCES public."user"(id),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), shared boolean NOT NULL DEFAULT false,
 files jsonb NOT NULL CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 1 AND 20 AND octet_length(files::text)<=65000000),
 byte_count bigint GENERATED ALWAYS AS (collab.history_archive_bytes(files)) STORED CHECK(byte_count BETWEEN 1 AND 10485760),
 content_hash text GENERATED ALWAYS AS (collab.history_archive_hash(files)) STORED,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,owner_id,content_hash,shared)
);
ALTER TABLE collab.history_archives ENABLE ROW LEVEL SECURITY;
CREATE POLICY archive_read ON collab.history_archives FOR SELECT USING(collab.project_role(project_id) IS NOT NULL AND (owner_id=collab.actor() OR shared));
CREATE POLICY archive_insert ON collab.history_archives FOR INSERT WITH CHECK(collab.project_role(project_id) IN ('maintainer','developer') AND collab.actor_has_mfa() AND owner_id=collab.actor() AND organization_id=(SELECT p.organization_id FROM collab.projects p WHERE p.id=project_id));
CREATE POLICY archive_delete ON collab.history_archives FOR DELETE USING(collab.project_role(project_id) IS NOT NULL AND collab.actor_has_mfa() AND owner_id=collab.actor());
GRANT SELECT,INSERT,DELETE ON collab.history_archives TO pi_collab_app;
CREATE INDEX history_archive_listing ON collab.history_archives(project_id,created_at DESC,id DESC);
CREATE FUNCTION collab.guard_history_archive() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE file jsonb; total bigint;
BEGIN
 IF collab.project_role(NEW.project_id) NOT IN ('maintainer','developer') OR collab.project_role(NEW.project_id) IS NULL OR NEW.owner_id IS DISTINCT FROM collab.actor() OR NOT collab.actor_has_mfa() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text,811));
 FOR file IN SELECT value FROM jsonb_array_elements(NEW.files) LOOP
  IF jsonb_typeof(file->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(file->'source') IS DISTINCT FROM 'string' OR octet_length(file->>'source') NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'invalid_history_archive' USING ERRCODE='P0001';END IF;
 END LOOP;
 -- An identical upload is a replay even at the quota boundary.
 IF EXISTS(SELECT 1 FROM collab.history_archives WHERE project_id=NEW.project_id AND owner_id=NEW.owner_id AND files=NEW.files AND shared=NEW.shared) THEN RETURN NEW;END IF;
 total:=collab.history_archive_bytes(NEW.files);
 IF (SELECT count(*) FROM collab.history_archives WHERE project_id=NEW.project_id AND owner_id=NEW.owner_id)>=50
 OR (SELECT coalesce(sum(byte_count),0) FROM collab.history_archives WHERE project_id=NEW.project_id AND owner_id=NEW.owner_id)+total>104857600
 OR (SELECT coalesce(sum(byte_count),0) FROM collab.history_archives WHERE project_id=NEW.project_id)+total>1073741824 THEN RAISE EXCEPTION 'history_archive_quota' USING ERRCODE='P0001';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION collab.guard_history_archive() FROM PUBLIC;
CREATE TRIGGER archive_limits BEFORE INSERT ON collab.history_archives FOR EACH ROW EXECUTE FUNCTION collab.guard_history_archive();
CREATE TRIGGER operations_admission BEFORE INSERT ON collab.history_archives FOR EACH ROW EXECUTE FUNCTION collab_meta.guard_admission();
