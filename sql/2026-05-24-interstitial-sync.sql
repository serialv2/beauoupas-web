-- ════════════════════════════════════════════════════════════════════
-- Synchronisation des pubs interstitielles entre joueurs et TV
-- ════════════════════════════════════════════════════════════════════
-- Objectif : la TV ne lance la 1ère question qu'une fois que tous les
-- joueurs ont fini de visionner leur pub interstitielle (ou si timeout
-- de l'intro_duration_seconds atteint, par sécurité).
--
-- À appliquer dans Supabase SQL Editor.
-- ════════════════════════════════════════════════════════════════════

-- 1) Colonne pour tracker quand chaque participant a fini sa pub
ALTER TABLE series_participants
ADD COLUMN IF NOT EXISTS interstitial_seen_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN series_participants.interstitial_seen_at IS
'NULL = le joueur n''a pas encore signalé la fin de sa pub interstitielle (ou pas de pub à voir). Posé à NOW() par RPC mark_interstitial_seen quand le mobile ferme la pub OU détecte qu''aucune pub ne sera affichée.';

-- 2) RPC : le joueur signale qu'il a fini sa pub (ou n'en a pas eu)
CREATE OR REPLACE FUNCTION mark_interstitial_seen(p_series_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE series_participants
  SET interstitial_seen_at = NOW()
  WHERE series_id = p_series_id
    AND user_id = auth.uid()
    AND interstitial_seen_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_interstitial_seen(UUID) TO authenticated;

-- 3) Trigger : à chaque transition preparing→active, on remet tous les
--    interstitial_seen_at à NULL pour la série. Comme ça si la même série
--    est relancée (bouton "Remettre en préparation"), on repart à zéro.
CREATE OR REPLACE FUNCTION reset_interstitial_seen_on_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'preparing' AND NEW.status = 'active' THEN
    UPDATE series_participants
    SET interstitial_seen_at = NULL
    WHERE series_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reset_interstitial_seen_trigger ON series;
CREATE TRIGGER reset_interstitial_seen_trigger
AFTER UPDATE OF status ON series
FOR EACH ROW
EXECUTE FUNCTION reset_interstitial_seen_on_active();

-- 4) Vérifier que la table series_participants est dans la publication realtime
--    (côté TV on va écouter les UPDATE de interstitial_seen_at).
--    Devrait déjà l'être, mais on sécurise :
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'series_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE series_participants;
  END IF;
END $$;
