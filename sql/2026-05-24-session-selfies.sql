-- ════════════════════════════════════════════════════════════════════
-- Selfies "session" pour quiz et parties rapides
-- ════════════════════════════════════════════════════════════════════
-- Les modes QUIZ et PARTY n'ont pas de "projets" comme le mode VOTE :
-- ils ont des questions qui s'enchaînent. On veut quand même capturer
-- un selfie par session (un seul max par joueur) pour le big reveal final.
--
-- Solution : rendre series_selfies.series_project_id NULLABLE. Un selfie
-- de session quiz/party est inséré avec series_project_id = NULL,
-- attaché à la série uniquement.
--
-- À appliquer dans Supabase SQL Editor.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE series_selfies
ALTER COLUMN series_project_id DROP NOT NULL;

COMMENT ON COLUMN series_selfies.series_project_id IS
'NULL pour les selfies de session quiz/party (un seul par joueur par série, pas lié à une question particulière). Non-NULL pour les selfies du mode vote photo (un par projet du vote).';
