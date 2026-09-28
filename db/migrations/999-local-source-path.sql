-- Add source_path to track the original working directory for local repositories.
-- This fixes basename collisions (two different paths with the same folder name)
-- and enables writeback to the original directory after runs complete.

ALTER TABLE collab.repositories ADD COLUMN IF NOT EXISTS source_path text;

-- Index for dedup lookups by source path
CREATE INDEX IF NOT EXISTS idx_repositories_source_path
  ON collab.repositories (project_id, source_path)
  WHERE provider = 'local' AND source_path IS NOT NULL;
