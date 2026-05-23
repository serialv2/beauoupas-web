// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Logique principale du mode PARTIE RAPIDE (party game)
// ═══════════════════════════════════════════════════════════════════
//
// Type "Most Likely To" : questions fixes ("Qui rirait à un
// enterrement ?"), réponses = les pseudos des joueurs connectés.
// Chaque joueur vote pour un autre (ou lui-même : auto-vote AUTORISÉ).
// Scoring Variante A : le plus désigné par question gagne 1 pt
// (ex-aequo : tous marquent 1 pt). Classement final = qui a gagné
// le plus de questions.
//
// Machine à états :
//   LOBBY    : salle d'attente (status = 'preparing')
//   INTRO    : phase intro de N secondes au démarrage
//   QUESTION : question en cours, countdown, compteur "X/Y ont voté".
//              ⚠️ PAS de reveal entre les questions : on enchaîne
//              directement la question suivante.
//   FINISH   : status = 'finished' →
//                1) RÉCAP : chaque question l'une après l'autre, avec
//                   mise en scène du gagnant de la question + détail
//                   des votes, ~results_duration_seconds par question
//                2) VAINQUEUR (wow effect Sézane)
//                3) PODIUM top 3
//                4) LEADERBOARD complet
//   ERROR    : code invalide / TV désactivée / etc.
//
// La TV PILOTE l'avancement :
//   - Fin de l'intro : tv_start_first_element() → 1re question.
//   - Pendant une question : auto-avance quand 100% ont voté (+2s)
//     OU quand le timer atteint 0 → tv_advance_to_next() (pas de
//     reveal intermédiaire, on passe direct à la suivante).
//
// Style visuel : classe 'style-party' sur <body> (show TV Sézane).
//
// Realtime : window.TVRealtime.start(seriesId, 'quiz') réutilisé.
// ⚠️ CORRECTIF FINAL : party_answers est désormais abonné NATIVEMENT
//    dans tv-realtime.js (comme quiz_answers) et remonté ici via
//    onRealtimeEvent(type='party_answer'). L'ancien sous-abonnement
//    interne (ensurePartyAnswersSubscription) est CONSERVÉ comme
//    simple filet de sécurité (onPartyVote est idempotent).
//
// ═══════════════════════════════════════════════════════════════════
//
// 🛠️ CORRECTIF (compteur TV bloqué à "0 réponse")
// -------------------------------------------------------------------
// Cause : startPartyAnswersSubscription() était appelé juste après
// window.TVRealtime.start(...), AVANT que le WebSocket realtime soit
// connecté. Le canal party_answers s'abonnait donc sur un client pas
// prêt → l'abonnement échouait silencieusement (CHANNEL_ERROR /
// TIMED_OUT) → onPartyVote() n'était JAMAIS appelé → votersByQuestion
// restait vide → "0 réponse" alors que les votes étaient bien en base.
//
// Correctif (sans toucher au reste du fichier) :
//  1) on attend que le client realtime soit prêt avant de créer le
//     canal (retry court) ;
//  2) on logge clairement le statut d'abonnement ;
//  3) re-souscription automatique si le canal tombe (CHANNEL_ERROR /
//     TIMED_OUT / CLOSED) ;
//  4) à CHAQUE (re)connexion réussie, on RECHARGE les votes déjà en
//     base (loadVoterCounts) et on redessine le compteur → resync même
//     si un INSERT realtime a été raté ;
//  5) filet de sécurité : un polling léger des votes pendant les
//     questions, qui se neutralise dès que le realtime fonctionne.
//
// 🛠️ CORRECTIF FINAL (compteur à 0 malgré votes en base)
// -------------------------------------------------------------------
// Le sous-abonnement party_answers greffé de l'extérieur sur le
// client de tv-realtime.js ne recevait jamais les INSERT (canal
// SUBSCRIBED mais events non propagés). Solution : party_answers est
// maintenant abonné NATIVEMENT dans tv-realtime.js, dans le même
// start()/client que quiz_answers (qui fonctionne), et les votes
// arrivent ici via onRealtimeEvent('party_answer', ...).
// ═══════════════════════════════════════════════════════════════════

window.TVPartyApp = (function() {

  // ─────────────────────────────────────────────────────────────────
  // État interne
  // ─────────────────────────────────────────────────────────────────

  var state = {
    accessCode: null,
    series: null,
    questions: [],            // [{ id, position, title, question_text, photo_url, started_at }]
    votersByQuestion: {},     // { question_id: { voter_id: true } } → compteur "X/Y ont voté"
    participantsCount: 0,

    currentScreen: null,      // 'lobby' | 'intro' | 'question' | 'finish' | 'error' | 'loading'

    // Timers
    countdownInterval: null,
    introCountdownInterval: null,

    // Données de fin
    finalResults: null,       // { top3:[...], leaderboard:[...] }
    recapData: null,          // { questions:[{..., results:[...]}] }
    finishPhase: null,        // 'recap' | 'winner' | 'podium' | 'leaderboard'
    recapIndex: 0,            // index de la question récap en cours
    finishStepTimeout: null,

    // Sous-abonnement realtime dédié party_answers (filet de sécurité)
    partyAnswersChannel: null,
    partyAnswersSubscribed: false,   // true dès qu'on a reçu SUBSCRIBED
    partyAnswersRetryTimer: null,    // timer de re-souscription
    partyAnswersAttempts: 0,         // nb de tentatives d'abonnement
    votesPollTimer: null,            // filet de sécurité (polling votes)
    screenPollTimer: null            // 🛠️ filet de sécurité (polling écran)
  };

  var _isAdvancing = false;     // anti double-call sur tv_advance_to_next
  var _isStartingFirst = false; // anti double-call sur tv_start_first_element

  // Durées (en ms) des étapes de fin
  var RECAP_DEFAULT_SECONDS = 6;          // défaut si results_duration_seconds vide
  var FINISH_WINNER_DURATION_MS = 8000;
  var FINISH_PODIUM_DURATION_MS = 8000;
  // (le leaderboard reste affiché jusqu'à arrêt manuel de l'animateur)

  // ─────────────────────────────────────────────────────────────────
  // Démarrage
  // ─────────────────────────────────────────────────────────────────

  async function start() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');

    if (!code) {
      showError(window.TVI18n.t('TvDisp_Err_CodeMissing_Title'), window.TVI18n.t('TvDisp_Err_CodeMissing_Msg'));
      return;
    }

    state.accessCode = code.toUpperCase();

    try {
      var sb = window.supabase.createClient(
        window.TV_CONFIG.SUPABASE_URL,
        window.TV_CONFIG.SUPABASE_ANON_KEY
      );

      // Charge la série
      var seriesRes = await sb
        .from('series')
        .select('*')
        .eq('access_code', state.accessCode)
        .maybeSingle();

      if (seriesRes.error) throw seriesRes.error;
      if (!seriesRes.data) {
        showError(window.TVI18n.t('TvDisp_Err_NotFound_Title'), window.TVI18n.t('TvDisp_Err_NotFound_Msg'));
        return;
      }

      state.series = seriesRes.data;

      if (!state.series.tv_active) {
        showError(window.TVI18n.t('TvDisp_Err_TvInactive_Title'), window.TVI18n.t('TvDisp_Err_TvInactive_Msg'));
        return;
      }

      if (!state.series.is_quiz || state.series.quiz_style !== 'party') {
        showError(window.TVI18n.t('TvParty_Err_WrongPage_Title'), window.TVI18n.t('TvParty_Err_WrongPage_Msg'));
        return;
      }

      // Style visuel show TV
      document.body.classList.add('style-party');

      // Charge les questions et données initiales
      await loadQuestions();
      await loadParticipantsCount();
      await loadVoterCounts();

      // Subscriptions realtime en mode 'quiz' (réutilisé tel quel).
      // ⚠️ CORRECTIF FINAL : tv-realtime.js abonne désormais AUSSI
      // party_answers nativement (comme quiz_answers) ; les votes
      // arrivent via onRealtimeEvent('party_answer', ...).
      window.TVRealtime.start(state.series.id, 'quiz');

      // Filet de sécurité (conservé) : sous-abonnement interne
      // party_answers. Désormais redondant avec le canal natif de
      // tv-realtime.js, mais inoffensif (onPartyVote idempotent) et
      // utile si le canal natif tombe.
      ensurePartyAnswersSubscription();

      // 🛠️ CORRECTIF : filet de sécurité — polling léger des votes
      // tant que le realtime n'a pas confirmé son abonnement.
      startVotesSafetyPolling();

      // 🛠️ CORRECTIF : filet de sécurité ÉCRAN — resynchronise l'écran
      // affiché si un event series a été manqué (équivaut à un F5
      // automatique et invisible). Empêche la TV de rester figée sur
      // le lobby après "Démarrer".
      startScreenSafetyPolling();

      renderCurrentScreen();

    } catch (err) {
      console.error('[TVPartyApp] start error:', err);
      showError(window.TVI18n.t('TvDisp_Err_Load_Title'), err.message || String(err));
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Sous-abonnement realtime dédié party_answers (FILET DE SÉCURITÉ)
  // 🛠️ robuste (attente client prêt + retry + resync)
  // ─────────────────────────────────────────────────────────────────

  // Le client realtime de tv-realtime.js est-il prêt à ouvrir un canal ?
  function realtimeClientReady() {
    try {
      if (!window.TVRealtime || typeof window.TVRealtime.getClient !== 'function') {
        return null;
      }
      var sb = window.TVRealtime.getClient();
      // sb doit exister ET exposer .channel()
      if (sb && typeof sb.channel === 'function') return sb;
      return null;
    } catch (e) {
      return null;
    }
  }

  // Lanceur tolérant : réessaie tant que le client realtime n'est pas
  // disponible (TVRealtime.start() est asynchrone).
  function ensurePartyAnswersSubscription() {
    if (state.partyAnswersSubscribed) return;

    var sb = realtimeClientReady();
    if (!sb) {
      state.partyAnswersAttempts++;
      if (state.partyAnswersAttempts <= 40) { // ~40 * 250ms = 10s max
        if (state.partyAnswersRetryTimer) clearTimeout(state.partyAnswersRetryTimer);
        state.partyAnswersRetryTimer = setTimeout(
          ensurePartyAnswersSubscription, 250);
      } else {
        console.warn('[TVPartyApp] Client realtime indisponible après ' +
          state.partyAnswersAttempts + ' tentatives — le polling de ' +
          'secours prend le relais.');
      }
      return;
    }

    subscribePartyAnswers(sb);
  }

  function subscribePartyAnswers(sb) {
    // Nettoie un éventuel canal précédent (re-souscription)
    if (state.partyAnswersChannel) {
      try { sb.removeChannel(state.partyAnswersChannel); } catch (e) {}
      state.partyAnswersChannel = null;
    }

    try {
      state.partyAnswersChannel = sb
        .channel('tv-party-answers-fallback-' + state.series.id + '-' + Date.now())
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'party_answers',
          filter: 'series_id=eq.' + state.series.id
        }, function(payload) {
          console.log('[TVPartyApp] party_answer INSERT (filet)');
          onPartyVote(payload.new);
        })
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'party_answers',
          filter: 'series_id=eq.' + state.series.id
        }, function(payload) {
          // submit_party_vote fait un upsert (ON CONFLICT DO UPDATE) :
          // un changement de cible ne crée pas de nouveau votant, mais
          // on l'enregistre quand même pour rester cohérent.
          console.log('[TVPartyApp] party_answer UPDATE (filet)');
          onPartyVote(payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVPartyApp] party_answers channel (filet):', status);

          if (status === 'SUBSCRIBED') {
            state.partyAnswersSubscribed = true;
            if (state.partyAnswersRetryTimer) {
              clearTimeout(state.partyAnswersRetryTimer);
              state.partyAnswersRetryTimer = null;
            }
            // 🛠️ Resync : on recharge les votes déjà en base au cas où
            // des INSERT seraient passés AVANT que le canal soit prêt.
            resyncVoterCounts();
          } else if (status === 'CHANNEL_ERROR' ||
                     status === 'TIMED_OUT' ||
                     status === 'CLOSED') {
            // Le canal est tombé → on relance une souscription propre.
            state.partyAnswersSubscribed = false;
            scheduleResubscribe();
          }
        });
    } catch (err) {
      console.warn('[TVPartyApp] subscribePartyAnswers error:', err);
      state.partyAnswersSubscribed = false;
      scheduleResubscribe();
    }
  }

  function scheduleResubscribe() {
    if (state.partyAnswersRetryTimer) clearTimeout(state.partyAnswersRetryTimer);
    state.partyAnswersRetryTimer = setTimeout(function() {
      console.log('[TVPartyApp] Re-souscription party_answers (filet)…');
      var sb = realtimeClientReady();
      if (sb) subscribePartyAnswers(sb);
      else ensurePartyAnswersSubscription();
    }, 1500);
  }

  // Recharge les votes déjà présents en base puis redessine le compteur.
  async function resyncVoterCounts() {
    try {
      await loadVoterCounts();
      updateVotersCounter();
      console.log('[TVPartyApp] Resync votes OK');
    } catch (e) {
      console.warn('[TVPartyApp] resyncVoterCounts error:', e);
    }
  }

  // Filet de sécurité : si le realtime n'a jamais confirmé son
  // abonnement, on interroge périodiquement la base pendant les
  // questions pour que le compteur ne reste pas figé. Dès que le
  // realtime fonctionne (partyAnswersSubscribed = true), ce polling
  // ne fait plus rien d'utile et se contente de resynchroniser
  // rarement (inoffensif).
  function startVotesSafetyPolling() {
    if (state.votesPollTimer) return;
    state.votesPollTimer = setInterval(function() {
      if (!state.series) return;
      if (state.currentScreen !== 'question') return;
      if (state.series.tv_paused) return;
      // Si le realtime marche, on espace : resync seulement 1x/8s.
      if (state.partyAnswersSubscribed) {
        state._pollTick = (state._pollTick || 0) + 1;
        if (state._pollTick % 4 !== 0) return; // 4 * 2s = 8s
      }
      resyncVoterCounts();
    }, 2000);
  }

  // 🛠️ CORRECTIF : filet de sécurité ÉCRAN. Toutes les 3 s, on relit
  // la série en base ; si son état implique un autre écran que celui
  // affiché, on resynchronise (re-render). C'est un "F5 invisible"
  // qui garantit que la TV ne reste jamais bloquée sur le lobby même
  // si l'event realtime series a été manqué.
  function startScreenSafetyPolling() {
    if (state.screenPollTimer) return;
    state.screenPollTimer = setInterval(async function() {
      try {
        if (!state.series) return;
        if (state.series.tv_paused) return;
        var sb = window.TVRealtime.getClient();
        var res = await sb
          .from('series')
          .select('*')
          .eq('id', state.series.id)
          .maybeSingle();
        if (res.error || !res.data) return;

        var fresh = res.data;
        var prevStatus = state.series.status;
        var prevIdx = state.series.current_project_index;
        state.series = fresh;

        if (!fresh.tv_active) {
          stopAllTimers();
          showError(window.TVI18n.t('TvDisp_Err_TvDeactivated_Title'), window.TVI18n.t('TvDisp_Err_TvDeactivated_Msg'));
          return;
        }

        var changed =
          (prevStatus !== fresh.status ||
           prevIdx !== fresh.current_project_index);
        var mismatch =
          (expectedScreenFor(fresh) !== state.currentScreen);

        if (changed || mismatch) {
          console.log('[TVPartyApp] Resync écran (filet sécurité) → ' +
            expectedScreenFor(fresh));
          _isAdvancing = false;
          _isStartingFirst = false;
          // si une question vient de démarrer, recharge son started_at
          if (fresh.status === 'active') {
            try { await loadQuestions(); } catch (e) {}
          }
          renderCurrentScreen();
        }
      } catch (e) {
        // silencieux : c'est un filet de sécurité
      }
    }, 3000);
  }

  // Un vote party arrive : on enregistre le voter_id pour la question.
  // (La contrainte UNIQUE(series_id, question_id, voter_id) garantit
  //  qu'un même voter ne compte qu'une fois ; le map côté JS sécurise
  //  aussi le cas d'un UPDATE re-notifié.)
  function onPartyVote(row) {
    if (!row || !row.question_id || !row.voter_id) return;
    if (!state.votersByQuestion[row.question_id]) {
      state.votersByQuestion[row.question_id] = {};
    }
    state.votersByQuestion[row.question_id][row.voter_id] = true;
    updateVotersCounter();
  }

  // ─────────────────────────────────────────────────────────────────
  // Chargement des questions / participants / votes déjà émis
  // ─────────────────────────────────────────────────────────────────

  async function loadQuestions() {
    var sb = window.TVRealtime.getClient();
    var res = await sb
      .from('quiz_questions')
      .select('id, position, title, question_text, photo_url, started_at')
      .eq('series_id', state.series.id)
      .order('position', { ascending: true });
    if (res.error) throw res.error;
    state.questions = res.data || [];
    console.log('[TVPartyApp] Questions chargées :', state.questions.length);
  }

  async function loadParticipantsCount() {
    var sb = window.TVRealtime.getClient();
    var res = await sb
      .from('series_participants')
      .select('user_id', { count: 'exact', head: true })
      .eq('series_id', state.series.id);
    if (res.count !== null && res.count !== undefined) {
      state.participantsCount = res.count;
    }
    console.log('[TVPartyApp] Participants :', state.participantsCount);
  }

  async function loadVoterCounts() {
    var sb = window.TVRealtime.getClient();
    var res = await sb
      .from('party_answers')
      .select('question_id, voter_id')
      .eq('series_id', state.series.id);
    if (res.data) {
      res.data.forEach(function(a) {
        if (!state.votersByQuestion[a.question_id]) {
          state.votersByQuestion[a.question_id] = {};
        }
        state.votersByQuestion[a.question_id][a.voter_id] = true;
      });
    }
  }

  function voterCountFor(questionId) {
    var m = state.votersByQuestion[questionId];
    return m ? Object.keys(m).length : 0;
  }

  // ─────────────────────────────────────────────────────────────────
  // RPCs : démarrer / avancer
  // ─────────────────────────────────────────────────────────────────

  async function startFirstElement() {
    if (_isStartingFirst) return;
    _isStartingFirst = true;
    try {
      var sb = window.TVRealtime.getClient();
      console.log('[TVPartyApp] Appel RPC tv_start_first_element');
      var res = await sb.rpc('tv_start_first_element', {
        p_series_id: state.series.id
      });
      if (res.error) console.error('[TVPartyApp] tv_start_first_element error:', res.error);
      else console.log('[TVPartyApp] tv_start_first_element OK:', res.data);
    } catch (err) {
      console.error('[TVPartyApp] startFirstElement exception:', err);
    } finally {
      setTimeout(function() { _isStartingFirst = false; }, 3000);
    }
  }

  async function advanceToNext() {
    if (_isAdvancing) {
      console.log('[TVPartyApp] advanceToNext déjà en cours, skip');
      return;
    }
    _isAdvancing = true;
    try {
      var sb = window.TVRealtime.getClient();
      console.log('[TVPartyApp] Appel RPC tv_advance_to_next');
      var res = await sb.rpc('tv_advance_to_next', {
        p_series_id: state.series.id
      });
      if (res.error) console.error('[TVPartyApp] tv_advance_to_next error:', res.error);
      else console.log('[TVPartyApp] tv_advance_to_next OK:', res.data);
    } catch (err) {
      console.error('[TVPartyApp] advanceToNext exception:', err);
    } finally {
      setTimeout(function() { _isAdvancing = false; }, 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Routeur principal
  // ─────────────────────────────────────────────────────────────────

  // 🛠️ CORRECTIF : quel écran DEVRAIT être affiché pour cet état série ?
  // Sert à détecter une incohérence (TV figée) et à forcer le re-render.
  function expectedScreenFor(s) {
    if (!s) return 'loading';
    if (s.status === 'preparing') return 'lobby';
    if (s.status === 'finished')  return 'finish';
    if (s.status === 'active') {
      var fq = state.questions[0];
      if (fq && !fq.started_at) return 'intro';
      var idx = s.current_project_index || 0;
      var q = state.questions[idx];
      if (q && q.started_at) return 'question';
      return 'intro'; // active mais 1re question pas encore démarrée
    }
    return state.currentScreen; // statut inconnu : on ne force rien
  }

  // 🛠️ CORRECTIF FIX 2 (TV figée sur l'intro) :
  // Dès qu'une question a un started_at, on REND la question et on
  // laisse la RPC get_party_question_for_tv (base fraîche) être la
  // source de vérité — sans bloquer sur current_project_index ni sur
  // l'état mémoire potentiellement périmé (c'est ÇA qui figeait la TV).
  function renderCurrentScreen() {
    var s = state.series;
    if (!s) return;

    if (s.tv_paused) showPauseOverlay();
    else hidePauseOverlay();

    if (s.status === 'preparing') {
      stopAllTimers();
      renderLobby();
    } else if (s.status === 'active') {
      // On reste sur l'intro UNIQUEMENT si la 1re question n'a pas
      // encore de started_at. Dès qu'elle en a un (tv_start_first_
      // element a tourné), on bascule sur la question.
      var firstQuestion = state.questions[0];
      var stillInIntro = firstQuestion && !firstQuestion.started_at;

      if (stillInIntro) {
        if (state.currentScreen !== 'intro') {
          renderIntro();
        }
      } else {
        // Au moins une question est démarrée → on rend la question.
        // On choisit le meilleur index disponible, mais on NE bloque
        // PAS si l'état mémoire semble incomplet : renderQuestion()
        // appelle get_party_question_for_tv qui lit la base FRAÎCHE
        // et renvoie la bonne question (même logique que le quiz).
        var idx = s.current_project_index || 0;
        var q = state.questions[idx];

        // Si l'index courant ne pointe pas (encore) sur une question
        // démarrée connue en mémoire, on se rabat sur la dernière
        // question démarrée trouvée — la RPC corrigera de toute façon.
        if (!q || !q.started_at) {
          var started = state.questions.filter(function(qq) {
            return qq && qq.started_at;
          });
          if (started.length > 0) {
            q = started[started.length - 1]; // la plus récemment démarrée
            idx = state.questions.indexOf(q);
          }
        }

        if (q) {
          renderQuestion(q, idx);
        } else {
          // Vrai cas limite : aucune question démarrée connue en
          // mémoire alors que la 1re a un started_at. On recharge
          // les questions puis on re-render (la RPC tranchera).
          console.log('[TVPartyApp] Resync questions (aucune question démarrée en mémoire)');
          loadQuestions().then(function() {
            renderCurrentScreen();
          }).catch(function(e) {
            console.warn('[TVPartyApp] loadQuestions resync error:', e);
          });
        }
      }
    } else if (s.status === 'finished') {
      stopAllTimers();
      renderFinish();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 1 : LOBBY
  // ─────────────────────────────────────────────────────────────────

  function renderLobby() {
    setActiveScreen('lobby');

    var title = state.series.title || window.TVI18n.t('TvParty_DefaultTitle');
    var code = state.accessCode;
    var nbQuestions = state.questions.length;

    var html =
      '<div class="tv-lobby-title">' + escapeHtml(title) + '</div>' +
      '<div class="tv-lobby-subtitle">' + window.TVI18n.tf(nbQuestions > 1 ? 'TvParty_Lobby_Subtitle_Many' : 'TvParty_Lobby_Subtitle_One', nbQuestions) + '</div>' +
      '<div class="tv-lobby-card">' +
        '<div class="tv-lobby-qr" id="lobby-qr"></div>' +
        '<div class="tv-lobby-code-block">' +
          '<div class="tv-lobby-code-label">' + window.TVI18n.t('TvDisp_Lobby_CodeLabel') + '</div>' +
          '<div class="tv-lobby-code">' + escapeHtml(code) + '</div>' +
          '<div class="tv-lobby-code-hint">' + window.TVI18n.t('TvDisp_Lobby_CodeHint') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="tv-lobby-participants" id="lobby-participants">' +
        formatParticipantsLabel(state.participantsCount) +
      '</div>' +
      '<div class="tv-lobby-waiting">' + window.TVI18n.t('TvDisp_Lobby_HostStart') + '</div>';

    document.getElementById('screen-lobby').innerHTML = html;

    var qrEl = document.getElementById('lobby-qr');
    if (qrEl && typeof QRCode !== 'undefined') {
      qrEl.innerHTML = '';

      var baseUrl = window.location.protocol + '//' + window.location.host;
      var pathParts = window.location.pathname.split('/');
      pathParts.pop(); // tv-party.html
      pathParts.pop(); // tv
      var rootPath = pathParts.join('/');
      var joinUrl = baseUrl + rootPath + '/join.html?code=' + encodeURIComponent(code);

      try {
        new QRCode(qrEl, {
          text: joinUrl,
          width: 256,
          height: 256,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (err) {
        console.warn('QR code generation failed:', err);
        qrEl.innerHTML = '<div style="font-size: 11px; color: #888; padding: 8px; text-align: center;">QR Code<br>indisponible</div>';
      }
    } else if (qrEl) {
      qrEl.innerHTML = '<div style="font-size: 11px; color: #888; padding: 8px; text-align: center;">QR Code<br>indisponible</div>';
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 2 : INTRO
  // ─────────────────────────────────────────────────────────────────

  function renderIntro() {
    setActiveScreen('intro');

    var title = state.series.title || 'Partie Rapide';
    var description = state.series.description || '';
    var nbQuestions = state.questions.length;
    var introDuration = state.series.intro_duration_seconds || 20;

    var html =
      '<div class="quiz-intro-content">' +
        '<div class="quiz-intro-tag">' + window.TVI18n.t('TvParty_Intro_GetReady') + '</div>' +
        '<div class="quiz-intro-title">' + escapeHtml(title) + '</div>' +
        (description
          ? '<div class="quiz-intro-description">' + escapeHtml(description) + '</div>'
          : '') +
        '<div class="quiz-intro-meta">' +
          '<div class="quiz-intro-meta-item">' +
            '<span class="quiz-intro-meta-value">' + nbQuestions + '</span>' +
            '<span class="quiz-intro-meta-label">' + window.TVI18n.t(nbQuestions > 1 ? 'TvParty_Intro_Question_Many' : 'TvParty_Intro_Question_One') + '</span>' +
          '</div>' +
          '<div class="quiz-intro-meta-item">' +
            '<span class="quiz-intro-meta-value" id="intro-participants-count">' + state.participantsCount + '</span>' +
            '<span class="quiz-intro-meta-label">' + window.TVI18n.t(state.participantsCount > 1 ? 'TvParty_Intro_Player_Many' : 'TvParty_Intro_Player_One') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="quiz-intro-countdown">' +
          '<span class="quiz-intro-countdown-label">' + window.TVI18n.t('TvParty_Intro_StartsIn') + '</span>' +
          '<span class="quiz-intro-countdown-value" id="intro-countdown">' + introDuration + '</span>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-intro').innerHTML = html;

    startIntroCountdown(introDuration);
  }

  function startIntroCountdown(durationSec) {
    stopIntroCountdown();

    var startedAt = Date.now();
    var totalMs = durationSec * 1000;

    function tick() {
      if (state.series && state.series.tv_paused) return;

      var elapsed = Date.now() - startedAt;
      var remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));

      var el = document.getElementById('intro-countdown');
      if (el) el.textContent = remaining;

      if (remaining <= 0) {
        stopIntroCountdown();
        startFirstElement();
      }
    }

    tick();
    state.introCountdownInterval = setInterval(tick, 200);
  }

  function stopIntroCountdown() {
    if (state.introCountdownInterval) {
      clearInterval(state.introCountdownInterval);
      state.introCountdownInterval = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 3 : QUESTION en cours (options = joueurs connectés)
  // ─────────────────────────────────────────────────────────────────

  async function renderQuestion(question, idx) {
    setActiveScreen('question');

    var sb = window.TVRealtime.getClient();
    var optsRes = await sb.rpc('get_party_question_for_tv', {
      p_series_id: state.series.id
    });

    if (optsRes.error) {
      console.error('[TVPartyApp] get_party_question_for_tv error:', optsRes.error);
      showError(window.TVI18n.t('TvCommon_Err_Generic'), optsRes.error.message || window.TVI18n.t('TvCommon_Err_LoadQuestion'));
      return;
    }

    var rawData = optsRes.data;
    if (!rawData || !rawData.question) {
      console.warn('[TVPartyApp] Pas de question retournée par le RPC', rawData);
      return;
    }
    var qData = rawData.question;
    if (rawData.vote_duration_seconds && state.series) {
      state.series.vote_duration_seconds = rawData.vote_duration_seconds;
    }

    var totalQuestions = state.questions.length;
    var pos = idx + 1;
    var voted = voterCountFor(qData.id);
    var totalParticipants = Math.max(1, state.participantsCount || 1);

    // Options = joueurs connectés (avatar + pseudo), pas A/B/C/D
    var optionsHtml = (qData.options || []).map(function(opt) {
      var uname = opt.username || window.TVI18n.t('TvCommon_DefaultPlayer');
      var avatarHtml = opt.avatar_url
        ? '<img src="' + escapeHtml(opt.avatar_url) + '" alt="">'
        : '<div class="party-option-avatar-ph">' + escapeHtml(uname.charAt(0).toUpperCase()) + '</div>';
      return '<div class="party-option">' +
        '<div class="party-option-avatar">' + avatarHtml + '</div>' +
        '<div class="party-option-name">' + escapeHtml(uname) + '</div>' +
      '</div>';
    }).join('');

    var photoHtml = qData.photo_url
      ? '<div class="quiz-question-photo"><img src="' + escapeHtml(qData.photo_url) + '" alt=""></div>'
      : '';

    // 🏷️ Barre de titre = CATÉGORIE de la question (party_questions.category,
    // remontée par la RPC get_party_question_for_tv). Fallback sur title
    // si la RPC ne renvoie pas encore category (rétro-compat : ne casse rien).
    var catLabel = qData.category || qData.title;
    var titleHtml = catLabel
      ? '<div class="quiz-question-category">' + escapeHtml(catLabel) + '</div>'
      : '';

    var html =
      '<div class="quiz-question-header">' +
        '<div class="quiz-question-progress">' + window.TVI18n.tf('TvQuiz_Question_Progress', pos, totalQuestions) + '</div>' +
        '<div class="quiz-question-countdown" id="question-countdown">--s</div>' +
      '</div>' +
      '<div class="quiz-question-body">' +
        titleHtml +
        '<div class="quiz-question-text">' + escapeHtml(qData.question_text) + '</div>' +
        photoHtml +
        '<div class="party-options">' + optionsHtml + '</div>' +
      '</div>' +
      '<div class="quiz-question-footer">' +
        '<div class="quiz-answers-counter">' +
          '<span class="quiz-answers-counter-text" id="answers-count">' + window.TVI18n.tf('TvParty_Voted', voted, totalParticipants) + '</span>' +
          '<div class="quiz-answers-counter-bar">' +
            '<div class="quiz-answers-counter-fill" id="answers-fill" style="width: ' +
              Math.min(100, Math.round((voted / totalParticipants) * 100)) + '%;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-question').innerHTML = html;

    // 🛠️ CORRECTIF : à l'affichage de la question, on s'assure que le
    // canal realtime (filet) est bien actif ET on resynchronise
    // immédiatement le compteur depuis la base.
    ensurePartyAnswersSubscription();
    resyncVoterCounts();

    startQuestionCountdown(question);
  }

  function startQuestionCountdown(question) {
    stopQuestionCountdown();

    if (!question.started_at) {
      var el = document.getElementById('question-countdown');
      if (el) el.textContent = 'En attente';
      return;
    }

    var startedAt = new Date(question.started_at).getTime();
    var durationSec = state.series.vote_duration_seconds || 20;
    var duration = durationSec * 1000;

    function tick() {
      if (state.series && state.series.tv_paused) return;

      var elapsed = Date.now() - startedAt;
      var remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));

      var el = document.getElementById('question-countdown');
      if (el) {
        el.textContent = remaining + 's';
        if (remaining <= 5) el.classList.add('urgent');
        else el.classList.remove('urgent');
      }

      if (remaining <= 0) {
        stopQuestionCountdown();
        // ⚠️ Pas de reveal : on enchaîne directement la question suivante
        advanceToNext();
      }
    }

    tick();
    state.countdownInterval = setInterval(tick, 200);
  }

  function stopQuestionCountdown() {
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Écran 4 : FINISH
  //   Phase 1 : RÉCAP question par question (mise en scène du gagnant)
  //   Phase 2 : VAINQUEUR (wow effect Sézane)
  //   Phase 3 : PODIUM top 3
  //   Phase 4 : LEADERBOARD complet (jusqu'à arrêt manuel)
  // ═══════════════════════════════════════════════════════════════════

  async function renderFinish() {
    setActiveScreen('finish');

    document.getElementById('screen-finish').innerHTML =
      '<div style="margin: auto;"><div class="tv-loading-spinner"></div></div>';

    try {
      var sb = window.TVRealtime.getClient();

      // Récap complet (1 seul appel — RPC get_party_recap)
      var recapRes = await sb.rpc('get_party_recap', {
        p_series_id: state.series.id
      });
      if (recapRes.error) throw recapRes.error;
      state.recapData = recapRes.data;

      // Classement final (top3 + leaderboard)
      var finalRes = await sb.rpc('get_party_final_results', {
        p_series_id: state.series.id
      });
      if (finalRes.error) throw finalRes.error;
      state.finalResults = finalRes.data;

    } catch (err) {
      console.error('[TVPartyApp] renderFinish RPC error:', err);
      showError('Erreur', err.message || window.TVI18n.t('TvParty_Err_LoadResults'));
      return;
    }

    var questions = (state.recapData && state.recapData.questions) || [];
    var top3 = (state.finalResults && state.finalResults.top3) || [];
    var leaderboard = (state.finalResults && state.finalResults.leaderboard) || [];

    if (questions.length === 0 && top3.length === 0 && leaderboard.length === 0) {
      document.getElementById('screen-finish').innerHTML =
        '<div style="margin: auto; text-align: center;">' +
          '<div style="font-size: 4vw; margin-bottom: 2vh;">🤔</div>' +
          '<div style="font-size: 2vw; color: var(--party-text);">' + window.TVI18n.t('TvParty_NoParticipant') + '</div>' +
        '</div>';
      return;
    }

    // ── Phase 1 : RÉCAP question par question ───────────────────────
    state.finishPhase = 'recap';
    state.recapIndex = 0;
    if (questions.length > 0) {
      renderRecapQuestion();
    } else {
      // Pas de récap possible → on saute au vainqueur
      goToWinnerPhase();
    }
  }

  // Durée d'affichage d'une question dans le récap (paramétrable via
  // series.results_duration_seconds, défaut RECAP_DEFAULT_SECONDS)
  function recapDurationMs() {
    var s = state.series && state.series.results_duration_seconds;
    var sec = (typeof s === 'number' && s > 0) ? s : RECAP_DEFAULT_SECONDS;
    return sec * 1000;
  }

  function renderRecapQuestion() {
    var questions = (state.recapData && state.recapData.questions) || [];
    if (state.recapIndex >= questions.length) {
      goToWinnerPhase();
      return;
    }

    var q = questions[state.recapIndex];
    var pos = state.recapIndex + 1;
    var total = questions.length;
    var results = q.results || [];
    var totalVotes = q.total_votes || 0;

    var catLabel = q.category || q.title;
    var titleHtml = catLabel
      ? '<div class="quiz-question-category">' + escapeHtml(catLabel) + '</div>'
      : '';

    var bodyHtml;
    if (results.length === 0) {
      // Personne n'a voté sur cette question
      bodyHtml =
        '<div class="party-recap-novote">' +
          '<div class="party-recap-novote-icon">🤷</div>' +
          '<div class="party-recap-novote-text">' + window.TVI18n.t('TvParty_NoVoteQuestion') + '</div>' +
        '</div>';
    } else {
      var topVotes = results[0].vote_count || 0;

      // Gagnant(s) de la question = tous ceux à topVotes (ex-aequo)
      var winners = results.filter(function(r) {
        return (r.vote_count || 0) === topVotes && topVotes > 0;
      });
      var others = results.filter(function(r) {
        return (r.vote_count || 0) < topVotes || topVotes === 0;
      });

      // ── Mise en scène du / des gagnant(s) ──
      var winnerStageHtml = '<div class="party-recap-winners">';
      winners.forEach(function(w) {
        var avatarHtml = w.avatar_url
          ? '<img src="' + escapeHtml(w.avatar_url) + '" alt="">'
          : '<div class="party-recap-winner-ph">' + escapeHtml((w.username || '?').charAt(0).toUpperCase()) + '</div>';
        winnerStageHtml +=
          '<div class="party-recap-winner">' +
            '<div class="party-recap-winner-crown">👑</div>' +
            '<div class="party-recap-winner-avatar">' + avatarHtml + '</div>' +
            '<div class="party-recap-winner-name">' + escapeHtml(w.username || window.TVI18n.t('TvCommon_DefaultPlayer')) + '</div>' +
            '<div class="party-recap-winner-votes">' +
              (w.vote_count || 0) + ' vote' + ((w.vote_count || 0) > 1 ? 's' : '') +
            '</div>' +
          '</div>';
      });
      winnerStageHtml += '</div>';

      // ── Les autres, en petit, avec barre ──
      var othersHtml = '';
      if (others.length > 0) {
        othersHtml = '<div class="party-recap-others">';
        others.forEach(function(o) {
          var vc = o.vote_count || 0;
          var pct = totalVotes > 0 ? Math.round((vc / totalVotes) * 100) : 0;
          var oAvatar = o.avatar_url
            ? '<img src="' + escapeHtml(o.avatar_url) + '" alt="">'
            : '<div class="party-recap-other-ph">' + escapeHtml((o.username || '?').charAt(0).toUpperCase()) + '</div>';
          othersHtml +=
            '<div class="party-recap-other">' +
              '<div class="party-recap-other-avatar">' + oAvatar + '</div>' +
              '<div class="party-recap-other-name">' + escapeHtml(o.username || window.TVI18n.t('TvCommon_DefaultPlayer')) + '</div>' +
              '<div class="party-recap-other-bar">' +
                '<div class="party-recap-other-fill" style="width:' + pct + '%;"></div>' +
              '</div>' +
              '<div class="party-recap-other-count">' + vc + '</div>' +
            '</div>';
        });
        othersHtml += '</div>';
      }

      bodyHtml = winnerStageHtml + othersHtml;
    }

    var html =
      '<div class="party-recap-screen">' +
        '<div class="quiz-question-header">' +
          '<div class="quiz-question-progress">' + window.TVI18n.tf('TvParty_Recap_Progress', pos, total) + '</div>' +
          '<div class="party-recap-tag">' + window.TVI18n.t('TvParty_Recap_Tag') + '</div>' +
        '</div>' +
        '<div class="party-recap-body">' +
          titleHtml +
          '<div class="quiz-question-text">' + escapeHtml(q.question_text || '') + '</div>' +
          bodyHtml +
        '</div>' +
        '<div class="party-recap-progressbar">' +
          '<div class="party-recap-progressbar-fill" id="recap-progress"></div>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;

    // Barre de progression de la durée d'affichage
    var durMs = recapDurationMs();
    var pf = document.getElementById('recap-progress');
    if (pf) {
      pf.style.transition = 'none';
      pf.style.width = '0%';
      void pf.offsetWidth; // force reflow
      pf.style.transition = 'width ' + (durMs / 1000) + 's linear';
      pf.style.width = '100%';
    }

    if (state.finishStepTimeout) clearTimeout(state.finishStepTimeout);
    state.finishStepTimeout = setTimeout(function() {
      state.recapIndex++;
      renderRecapQuestion();
    }, durMs);
  }

  function goToWinnerPhase() {
    var top3 = (state.finalResults && state.finalResults.top3) || [];
    var leaderboard = (state.finalResults && state.finalResults.leaderboard) || [];

    if (top3.length === 0 && leaderboard.length === 0) {
      // rien à afficher → écran neutre avec bouton stop
      document.getElementById('screen-finish').innerHTML =
        '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
        '<div style="margin:auto;text-align:center;">' +
          '<div style="font-size:4vw;margin-bottom:2vh;">🎉</div>' +
          '<div style="font-size:2vw;color:var(--party-text);">' + window.TVI18n.t('TvParty_Finished') + '</div>' +
        '</div>';
      bindStopBtn();
      return;
    }

    state.finishPhase = 'winner';
    renderFinishWinner();

    if (state.finishStepTimeout) clearTimeout(state.finishStepTimeout);
    state.finishStepTimeout = setTimeout(function() {
      state.finishPhase = 'podium';
      renderFinishPodium();

      var showLeaderboard = state.series.show_full_leaderboard && leaderboard.length > 3;
      if (showLeaderboard) {
        state.finishStepTimeout = setTimeout(function() {
          state.finishPhase = 'leaderboard';
          renderFinishLeaderboard();
        }, FINISH_PODIUM_DURATION_MS);
      }
      // sinon on reste sur le podium jusqu'à arrêt manuel
    }, FINISH_WINNER_DURATION_MS);
  }

  // ── Vainqueur avec wow effect (couronne/rayons/étincelles Sézane) ──
  function renderFinishWinner() {
    var top3 = (state.finalResults && state.finalResults.top3) || [];
    if (top3.length === 0) return;

    var winner = top3[0];

    // Détection ex-aequo au sommet (même score que le 1er)
    var leaderboard = (state.finalResults && state.finalResults.leaderboard) || [];
    var topScore = winner.score;
    var tiedWinners = leaderboard.filter(function(p) { return p.score === topScore; });
    var isTie = tiedWinners.length > 1;

    var avatarHtml = winner.avatar_url
      ? '<img src="' + escapeHtml(winner.avatar_url) + '" alt="">'
      : '<div class="quiz-finish-avatar-placeholder">' + escapeHtml((winner.username || '?').charAt(0).toUpperCase()) + '</div>';

    // 16 rayons
    var rays = '';
    for (var i = 0; i < 16; i++) {
      var angle = i * (360 / 16);
      rays += '<div class="winner-ray" style="transform: translate(-50%, -100%) rotate(' + angle + 'deg);"></div>';
    }

    // 12 étincelles (fill terracotta clair Sézane)
    var sparkles = '';
    var sparklePositions = [
      { top: '8%',  left: '20%', delay: '0s',   size: 18 },
      { top: '15%', left: '78%', delay: '0.3s', size: 22 },
      { top: '30%', left: '12%', delay: '0.6s', size: 16 },
      { top: '40%', left: '85%', delay: '0.9s', size: 24 },
      { top: '55%', left: '22%', delay: '1.2s', size: 18 },
      { top: '60%', left: '75%', delay: '1.5s', size: 20 },
      { top: '20%', left: '50%', delay: '0.4s', size: 14 },
      { top: '70%', left: '15%', delay: '0.7s', size: 16 },
      { top: '75%', left: '82%', delay: '1.0s', size: 20 },
      { top: '35%', left: '5%',  delay: '1.3s', size: 18 },
      { top: '50%', left: '92%', delay: '1.6s', size: 16 },
      { top: '10%', left: '60%', delay: '0.5s', size: 22 }
    ];
    sparklePositions.forEach(function(p) {
      sparkles +=
        '<div class="winner-sparkle" style="top:' + p.top + ';left:' + p.left +
        ';animation-delay:' + p.delay + ';width:' + p.size + 'px;height:' + p.size + 'px;">' +
          '<svg viewBox="0 0 24 24" fill="none">' +
            '<path d="M12 0 L13.5 9 L24 12 L13.5 15 L12 24 L10.5 15 L0 12 L10.5 9 Z" fill="#FFB627"/>' +
          '</svg>' +
        '</div>';
    });

    // Couronne SVG (dégradé Sézane terracotta → doré)
    var crownSvg =
      '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">' +
        '<defs>' +
          '<linearGradient id="crownGradientParty" x1="0%" y1="0%" x2="0%" y2="100%">' +
            '<stop offset="0%" style="stop-color:#FFB627"/>' +
            '<stop offset="50%" style="stop-color:#D88A66"/>' +
            '<stop offset="100%" style="stop-color:#A35C36"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<path d="M 20 70 L 30 30 L 60 60 L 100 15 L 140 60 L 170 30 L 180 70 Z" ' +
              'fill="url(#crownGradientParty)" stroke="#3D2817" stroke-width="2" stroke-linejoin="round"/>' +
        '<rect x="20" y="68" width="160" height="14" fill="url(#crownGradientParty)" stroke="#3D2817" stroke-width="2"/>' +
        '<circle cx="60" cy="75" r="4" fill="#6B7F5C" stroke="#FAF6EF" stroke-width="0.8"/>' +
        '<circle cx="100" cy="75" r="5" fill="#B5482F" stroke="#FAF6EF" stroke-width="0.8"/>' +
        '<circle cx="140" cy="75" r="4" fill="#6B7F5C" stroke="#FAF6EF" stroke-width="0.8"/>' +
        '<circle cx="30" cy="30" r="3" fill="#FFD9A0" stroke="#3D2817" stroke-width="1"/>' +
        '<circle cx="100" cy="15" r="4" fill="#FFD9A0" stroke="#3D2817" stroke-width="1"/>' +
        '<circle cx="170" cy="30" r="3" fill="#FFD9A0" stroke="#3D2817" stroke-width="1"/>' +
      '</svg>';

    var tieBadge = isTie
      ? '<div class="party-winner-tie">Ex-aequo (' + tiedWinners.length + ' joueurs)</div>'
      : '';

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
      '<div class="winner-vignette"></div>' +
      '<div class="winner-spotlight"></div>' +
      '<div class="winner-sparkles-layer">' + sparkles + '</div>' +
      '<div class="quiz-finish-winner winner-with-wow">' +
        '<div class="winner-crown">' + crownSvg + '</div>' +
        '<div class="quiz-finish-winner-tag">🏆 ' + (isTie ? window.TVI18n.t('TvParty_Winner_Many') : window.TVI18n.t('TvParty_Winner_One')) + '</div>' +
        '<div class="winner-avatar-wrap">' +
          '<div class="winner-rays">' + rays + '</div>' +
          '<div class="winner-halo"></div>' +
          '<div class="quiz-finish-winner-avatar">' + avatarHtml + '</div>' +
        '</div>' +
        '<div class="quiz-finish-winner-name">' + escapeHtml(winner.username || window.TVI18n.t('TvParty_DefaultPlayer')) + '</div>' +
        tieBadge +
        '<div class="quiz-finish-winner-score">' +
          window.TVI18n.tf(winner.score > 1 ? 'TvParty_Winner_Score_Many' : 'TvParty_Winner_Score_One', winner.score) +
        '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function renderFinishPodium() {
    var top3 = (state.finalResults && state.finalResults.top3) || [];
    var positions = [
      { rank: 2, idx: 1, cls: 'second' },
      { rank: 1, idx: 0, cls: 'first' },
      { rank: 3, idx: 2, cls: 'third' }
    ];

    var podiumHtml = positions.map(function(p) {
      var player = top3[p.idx];
      if (!player) return '';
      var avatar = player.avatar_url
        ? '<img src="' + escapeHtml(player.avatar_url) + '" alt="">'
        : '<div class="quiz-finish-avatar-placeholder">' + escapeHtml((player.username || '?').charAt(0).toUpperCase()) + '</div>';
      return '<div class="quiz-podium-spot quiz-podium-' + p.cls + '">' +
        '<div class="quiz-podium-rank">' + p.rank + '</div>' +
        '<div class="quiz-podium-avatar">' + avatar + '</div>' +
        '<div class="quiz-podium-name">' + escapeHtml(player.username || window.TVI18n.t('TvCommon_DefaultPlayer')) + '</div>' +
        '<div class="quiz-podium-score">' + player.score + ' question' + (player.score > 1 ? 's' : '') + '</div>' +
      '</div>';
    }).join('');

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
      '<div class="quiz-finish-podium-wrap">' +
        '<div class="quiz-finish-podium-title">Podium</div>' +
        '<div class="quiz-podium">' + podiumHtml + '</div>' +
      '</div>';
// ⚡ BUG 5 — Selfies pendant la partie si selfie_enabled
if (state.series && state.series.selfie_enabled !== false) {
    loadAndSpawnSelfiePolaroids();
}
    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function renderFinishLeaderboard() {
    var leaderboard = (state.finalResults && state.finalResults.leaderboard) || [];
    var rowsHtml = leaderboard.map(function(player, i) {
      var rank = i + 1;
      var medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      var avatar = player.avatar_url
        ? '<img src="' + escapeHtml(player.avatar_url) + '" alt="">'
        : '<div class="quiz-finish-avatar-placeholder small">' + escapeHtml((player.username || '?').charAt(0).toUpperCase()) + '</div>';
      return '<div class="quiz-leaderboard-row' + (rank <= 3 ? ' top3' : '') + '">' +
        '<div class="quiz-leaderboard-rank">' + medal + '</div>' +
        '<div class="quiz-leaderboard-avatar">' + avatar + '</div>' +
        '<div class="quiz-leaderboard-name">' + escapeHtml(player.username || window.TVI18n.t('TvCommon_DefaultPlayer')) + '</div>' +
        '<div class="quiz-leaderboard-score">' + player.score + ' question' + (player.score > 1 ? 's' : '') + '</div>' +
      '</div>';
    }).join('');

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
      '<div class="quiz-finish-leaderboard-wrap">' +
        '<div class="quiz-finish-leaderboard-title">Classement complet</div>' +
        '<div class="quiz-leaderboard">' + rowsHtml + '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function bindStopBtn() {
    var btn = document.getElementById('finish-stop-btn');
    if (btn) btn.addEventListener('click', onStopClicked);
  }

  async function onStopClicked() {
    if (!confirm(window.TVI18n.t('TvParty_Stop_Confirm'))) return;
    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('tv_deactivate', { p_series_id: state.series.id });
      if (res.error) throw res.error;
      console.log('[TVPartyApp] Mode TV désactivé');
    } catch (err) {
      console.error('[TVPartyApp] onStopClicked error:', err);
      alert(window.TVI18n.t('TvCommon_Err_AlertPrefix') + (err.message || err));
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Pause overlay / erreur / switch d'écrans
  // ─────────────────────────────────────────────────────────────────

  function showPauseOverlay() {
    var ov = document.getElementById('pause-overlay');
    if (ov) ov.classList.add('active');
  }
  function hidePauseOverlay() {
    var ov = document.getElementById('pause-overlay');
    if (ov) ov.classList.remove('active');
  }

  function showError(title, message) {
    setActiveScreen('error');
    var html =
      '<div class="tv-error-icon">⚠️</div>' +
      '<div class="tv-error-title">' + escapeHtml(title) + '</div>' +
      '<div class="tv-error-message">' + escapeHtml(message) + '</div>';
    document.getElementById('screen-error').innerHTML = html;
  }

  function setActiveScreen(name) {
    var screens = ['lobby', 'intro', 'question', 'reveal', 'finish', 'error', 'loading'];
    screens.forEach(function(n) {
      var el = document.getElementById('screen-' + n);
      if (el) {
        if (n === name) el.classList.add('active');
        else el.classList.remove('active');
      }
    });
    state.currentScreen = name;
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  function stopAllTimers() {
    stopQuestionCountdown();
    stopIntroCountdown();
    if (state.finishStepTimeout) {
      clearTimeout(state.finishStepTimeout);
      state.finishStepTimeout = null;
    }
  }

  function formatParticipantsLabel(n) {
    return window.TVI18n.tf(n > 1 ? 'TvParty_Players_Many' : 'TvParty_Players_One', n);
  }

  function refreshLobbyParticipantsLabel() {
    var el = document.getElementById('lobby-participants');
    if (el) el.textContent = formatParticipantsLabel(state.participantsCount);
  }

  function refreshIntroParticipantsLabel() {
    var el = document.getElementById('intro-participants-count');
    if (el) el.textContent = state.participantsCount;
  }

  function updateVotersCounter() {
    if (!state.series || state.currentScreen !== 'question') return;
    var idx = state.series.current_project_index || 0;
    var q = state.questions[idx];
    if (!q) return;

    var voted = voterCountFor(q.id);
    var totalParticipants = Math.max(1, state.participantsCount || 1);
    var percent = Math.min(100, Math.round((voted / totalParticipants) * 100));

    var elCount = document.getElementById('answers-count');
    var elFill = document.getElementById('answers-fill');
    if (elCount) elCount.textContent = window.TVI18n.tf('TvParty_Voted', voted, totalParticipants);
    if (elFill) elFill.style.width = percent + '%';

    if (state.series.status === 'active'
        && state.participantsCount > 0
        && voted >= state.participantsCount
        && !_isAdvancing
        && !state.series.tv_paused) {

      console.log('[TVPartyApp] 🎯 Tout le monde a voté ! Question suivante dans 2s...');

      setTimeout(function() {
        if (state.series.status === 'active' && !_isAdvancing && !state.series.tv_paused
            && state.currentScreen === 'question') {
          stopQuestionCountdown();
          // Pas de reveal : on enchaîne directement
          advanceToNext();
        }
      }, 2000);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Réception des events Realtime
  // ─────────────────────────────────────────────────────────────────

  function onRealtimeEvent(type, payload) {
    if (type === 'series') {
      var prev = state.series;
      state.series = payload;

      if (prev.tv_paused !== payload.tv_paused) {
        if (payload.tv_paused) showPauseOverlay();
        else hidePauseOverlay();
      }

      if (!payload.tv_active) {
        stopAllTimers();
        showError(window.TVI18n.t('TvDisp_Err_TvDeactivated_Title'), window.TVI18n.t('TvDisp_Err_TvDeactivated_Msg'));
        return;
      }

      // 🛠️ CORRECTIF (TV bloquée sur le lobby après "Démarrer") :
      // on redessine si le statut/index a changé, MAIS AUSSI si
      // l'écran actuellement affiché ne correspond pas à l'état
      // réel de la série (cas : l'event de transition preparing→
      // active a été manqué pendant l'établissement du canal, ou
      // le payload semble identique au state déjà en mémoire).
      // Sans ça, la TV restait figée sur le QR code jusqu'à un F5.
      var statusChanged =
        (prev.status !== payload.status ||
         prev.current_project_index !== payload.current_project_index);
      var screenMismatch =
        (expectedScreenFor(payload) !== state.currentScreen);

      if (statusChanged || screenMismatch) {
        _isAdvancing = false;
        _isStartingFirst = false;
        renderCurrentScreen();
      }
    }
    else if (type === 'quiz_question') {
      var found = state.questions.find(function(q) { return q.id === payload.id; });
      var prevStartedAt = found ? found.started_at : null;
      if (found) {
        found.started_at = payload.started_at;
      }

      // 🛠️ CORRECTIF (TV figée sur l'intro après tv_start_first_element) :
      // on ne conditionne PLUS le re-render sur l'identité exacte de la
      // question courante (current_project_index n'est pas forcément
      // synchrone avec la pose du started_at). Dès qu'UNE question
      // passe de "pas démarrée" à "démarrée", on relit l'écran. La RPC
      // get_party_question_for_tv (appelée par renderQuestion) lit la
      // base et renvoie la bonne question fraîche — comme le quiz.
      var newlyStarted = (!prevStartedAt && payload.started_at);
      if (newlyStarted &&
          state.series &&
          state.series.status === 'active' &&
          !state.series.tv_paused) {
        console.log('[TVPartyApp] quiz_question started_at posé → re-render écran');
        _isStartingFirst = false;
        renderCurrentScreen();
      }
    }
    else if (type === 'quiz_answer') {
      // ⚠️ Le party n'écrit PAS dans quiz_answers. Cet event ne devrait
      // pas survenir pour une partie ; on l'ignore volontairement.
    }
    else if (type === 'party_answer') {
      // ✅ CORRECTIF FINAL : vote party reçu via le canal NATIF de
      // tv-realtime.js (même mécanisme que quiz_answer pour le quiz).
      // C'est désormais le chemin principal d'arrivée des votes.
      console.log('[TVPartyApp] party_answer reçu via TVRealtime');
      onPartyVote(payload);
    }
    else if (type === 'participant') {
      state.participantsCount++;
      console.log('[TVPartyApp] Nouveau joueur, total =', state.participantsCount);
      refreshLobbyParticipantsLabel();
      refreshIntroParticipantsLabel();
      updateVotersCounter();
    }
    else if (type === 'participant_left') {
      state.participantsCount = Math.max(0, state.participantsCount - 1);
      console.log('[TVPartyApp] Joueur parti, total =', state.participantsCount);
      refreshLobbyParticipantsLabel();
      refreshIntroParticipantsLabel();
      updateVotersCounter();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Helper HTML escape
  // ─────────────────────────────────────────────────────────────────

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─────────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────────
async function loadAndSpawnSelfiePolaroids() {
    try {
        var sb = window.TVRealtime.getClient();
        var res = await sb
            .from('series_selfies')
            .select('photo_url, user_id, profiles(username)')
            .eq('series_id', state.series.id);

        if (res.error || !res.data || res.data.length === 0) return;

        var selfies = res.data.map(function(s) {
            return {
                photo_url: s.photo_url,
                username: s.profiles ? s.profiles.username : null
            };
        });

        // Réutilise le même conteneur polaroids que tv-app.js
        var container = document.getElementById('reveal-polaroids');
        if (!container) return;
        container.innerHTML = '';

        var SPAWN_INTERVAL_MS = 2800;
        var TRAVERSE_DURATION_MS = 14000;
        var idx = 0;

        function spawnNext() {
            if (!document.getElementById('reveal-polaroids')) return;
            var selfie = selfies[idx % selfies.length];
            idx++;
            addPolaroid(container, selfie, TRAVERSE_DURATION_MS);
            setTimeout(spawnNext, SPAWN_INTERVAL_MS);
        }

        addPolaroid(container, selfies[0], TRAVERSE_DURATION_MS);
        if (selfies.length > 1) {
            setTimeout(function() {
                var c = document.getElementById('reveal-polaroids');
                if (c) addPolaroid(c, selfies[1 % selfies.length], TRAVERSE_DURATION_MS);
            }, 1400);
        }
        idx = 2;
        setTimeout(spawnNext, SPAWN_INTERVAL_MS);

    } catch (err) {
        console.warn('[TVQuizApp] loadAndSpawnSelfiePolaroids error:', err);
    }
}

function addPolaroid(container, selfie, durationMs) {
    var el = document.createElement('div');
    el.className = 'tv-polaroid';
    var topPct = 10 + Math.random() * 60;
    var rot = (Math.random() * 16 - 8).toFixed(1);
    el.style.top = topPct + '%';
    el.style.setProperty('--polaroid-rot', rot + 'deg');
    el.style.animationDuration = durationMs + 'ms';

    var imgHtml = selfie && selfie.photo_url
        ? '<img src="' + escapeHtml(selfie.photo_url) + '" alt="">'
        : '<div style="width:100%;aspect-ratio:1;background:#888;"></div>';

    var captionHtml = (selfie && selfie.username)
        ? '<div class="tv-polaroid-caption">' + escapeHtml(selfie.username) + '</div>'
        : '';

    el.innerHTML = imgHtml + captionHtml;
    container.appendChild(el);

    setTimeout(function() {
        if (el.parentNode) el.parentNode.removeChild(el);
    }, durationMs + 200);
}
  return {
    start: start,
    onRealtimeEvent: onRealtimeEvent
  };

})();
