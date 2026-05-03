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

  // Durée d'affichage de chaque projet dans le big reveal final
  REVEAL_PROJECT_DURATION_MS: 3000,

  // Durée d'affichage du grand gagnant
  REVEAL_WINNER_DURATION_MS: 6000
};
