-- ═══════════════════════════════════════════════════════════════════
-- Lier les selfies de session à la question pendant laquelle ils ont
-- été pris. Permet à la TV d'afficher pendant la révélation d'une
-- question UNIQUEMENT les selfies pris pendant cette question.
--
-- Toujours NULLABLE :
--  - selfies du mode SERIES (vote photo) : pas de question
--  - selfies déjà uploadés avant la migration : NULL
--  - capture où on n'a pas pu déterminer la question : NULL (safe)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE series_selfies
  ADD COLUMN IF NOT EXISTS series_question_id uuid
  REFERENCES quiz_questions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_series_selfies_question_id
  ON series_selfies(series_question_id)
  WHERE series_question_id IS NOT NULL;
