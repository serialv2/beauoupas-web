// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Configuration Supabase
// ═══════════════════════════════════════════════════════════════════
//
// Ce fichier contient les clés publiques Supabase utilisées par la TV.
// Ces clés sont sûres à exposer publiquement (clé "anon" + RLS) car la
// TV n'a accès qu'aux données des séries dont tv_active = TRUE.
//
// ═══════════════════════════════════════════════════════════════════
window.TV_CONFIG = {
  SUPABASE_URL: 'https://iybjtvwdnqnebuexesiz.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5Ymp0dndkbnFuZWJ1ZXhlc2l6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMDEwNjgsImV4cCI6MjA5MTU3NzA2OH0.dAImywya67QbKj1dCR3GZg4p24jxPPvQi5wGkJvdNLk',
  // Durée du timer de vote (doit correspondre à VoteSeconds dans le Maui)
  VOTE_DURATION_SECONDS: 20,
  // Durée de la transition entre 2 projets
  TRANSITION_DURATION_MS: 2500,
  // ─── Big reveal final ─────────────────────────────────────────────
  // La page résultats fonctionne en BOUCLE jusqu'à ce que l'animateur
  // l'arrête (clic sur le bouton "Arrêter" ou désactivation TV depuis
  // l'app MAUI). Pour chaque projet on enchaîne 2 phases :
  //   1) Phase brute : icônes + nb votes par option + selfies polaroids
  //   2) Phase stats : répartition par genre + par tranche d'âge
  // Puis on passe au projet suivant. Quand on a fait tous les projets,
  // on revient au premier (boucle infinie).
  RESULTS_RAW_DURATION_MS: 20000,    // 20s phase 1 par projet
  RESULTS_STATS_DURATION_MS: 20000   // 20s phase 2 par projet
};
