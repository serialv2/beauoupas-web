-- ══════════════════════════════════════════════════════════════════
-- Migration : vider party_answers lors d'un Repréparer
-- ══════════════════════════════════════════════════════════════════
--
-- Problème : reset_series_for_replay (SECURITY DEFINER) nettoyait
-- quiz_answers mais pas party_answers, car party_answers a été ajouté
-- après la création de cette fonction. Résultat : après un Repréparer
-- sur une partie rapide, les anciens votes étaient encore en base
-- → le compteur TV affichait "X/Y ont voté" dès le démarrage de la
-- question suivante, et la partie avançait toute seule.
--
-- Fix option A (recommandée) : ajouter le DELETE dans reset_series_for_replay.
-- À faire : ouvrir la fonction dans Supabase > Database > Functions,
-- trouver la ligne qui delete quiz_answers et ajouter juste après :
--
--   DELETE FROM public.party_answers WHERE series_id = p_series_id;
--
-- Fix option B (appliquée ici) : RPC supplémentaire clear_party_answers
-- appelée depuis SeriesService.ResetSeriesAsync en complément de
-- reset_series_for_replay. Sûre et idempotente (no-op si pas de votes).
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.clear_party_answers(
  p_series_id uuid,
  p_user_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Vérifie que l'appelant est bien le créateur de la série
  IF NOT EXISTS (
    SELECT 1 FROM public.series
    WHERE id = p_series_id
      AND creator_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_creator');
  END IF;

  DELETE FROM public.party_answers
  WHERE series_id = p_series_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Droits : accessible par les utilisateurs authentifiés (SECURITY DEFINER
-- bypass les RLS, donc pas besoin de policy DELETE sur party_answers)
REVOKE ALL ON FUNCTION public.clear_party_answers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_party_answers(uuid, uuid) TO authenticated;
