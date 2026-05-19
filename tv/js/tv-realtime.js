// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Subscriptions Realtime
// ═══════════════════════════════════════════════════════════════════
//
// Gère les abonnements aux changements en temps réel via Supabase.
//
// MODES :
//   - 'vote' : pour les séries de vote classiques (tv-display.html)
//     écoute : series, series_projects, series_votes, series_selfies, series_participants
//   - 'quiz' : pour les séries de quizz (tv-quiz.html)
//     écoute : series, quiz_questions, quiz_answers, series_participants
//     ⚠️ Le mode PARTIE RAPIDE (tv-party.html) réutilise mode='quiz'
//        et écoute EN PLUS party_answers (ajouté nativement ici).
//
// L'objet exporté est window.TVRealtime.
// Tous les events sont remontés à l'app courante via emit() :
//   - window.TVPartyApp si présente (page tv-party.html)
//   - sinon window.TVQuizApp (mode quiz) ou window.TVApp (mode vote)
//
// ═══════════════════════════════════════════════════════════════════

window.TVRealtime = (function() {

  var subscriptions = [];
  var supabaseClient = null;
  var currentMode = null;       // 'vote' | 'quiz'
  var currentApp = null;        // référence vers TVApp ou TVQuizApp

  // ─── Démarre les subscriptions ─────────────────────────────────────
  // mode : 'vote' (défaut, rétro-compat) ou 'quiz'
  function start(seriesId, mode) {
    if (!seriesId) {
      console.error('[TVRealtime] start() : seriesId manquant');
      return;
    }
    currentMode = mode || 'vote';
    currentApp = (currentMode === 'quiz') ? window.TVQuizApp : window.TVApp;

    supabaseClient = window.supabase.createClient(
      window.TV_CONFIG.SUPABASE_URL,
      window.TV_CONFIG.SUPABASE_ANON_KEY
    );

    console.log('[TVRealtime] Démarrage des subscriptions, mode =', currentMode, ', series:', seriesId);

    // ─── series : changements de status, pause, projet courant ─────
    // (commun aux 2 modes)
    var seriesSub = supabaseClient
      .channel('tv-series-' + seriesId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'series',
        filter: 'id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] series UPDATE');
        emit('series', payload.new);
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series channel:', status);
      });
    subscriptions.push(seriesSub);

    // ⚡ ─── series_participants : INSERT + DELETE ──────────────────
    // (commun aux 2 modes : compteur joueurs)
    var participantsSub = supabaseClient
      .channel('tv-participants-' + seriesId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'series_participants',
        filter: 'series_id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] participant INSERT');
        emit('participant', payload.new);
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'series_participants',
        filter: 'series_id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] participant DELETE');
        emit('participant_left', payload.old);
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series_participants channel:', status);
      });
    subscriptions.push(participantsSub);

    // ─── Mode VOTE : tables spécifiques au vote ────────────────────
    if (currentMode === 'vote') {
      // series_projects : started_at, is_revealed
      var projectsSub = supabaseClient
        .channel('tv-projects-' + seriesId)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'series_projects',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] series_projects UPDATE');
          emit('series_project', payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVRealtime] series_projects channel:', status);
        });
      subscriptions.push(projectsSub);

      // series_votes : INSERT (compteur "X / Y ont voté")
      var votesSub = supabaseClient
        .channel('tv-votes-' + seriesId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'series_votes',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] vote INSERT');
          emit('vote', payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVRealtime] series_votes channel:', status);
        });
      subscriptions.push(votesSub);

      // series_selfies : INSERT (big reveal final)
      var selfiesSub = supabaseClient
        .channel('tv-selfies-' + seriesId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'series_selfies',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] selfie INSERT');
          emit('selfie', payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVRealtime] series_selfies channel:', status);
        });
      subscriptions.push(selfiesSub);
    }

    // ─── Mode QUIZ : tables spécifiques au quizz ───────────────────
    if (currentMode === 'quiz') {
      // quiz_questions : started_at (= démarrage d'une question)
      var questionsSub = supabaseClient
        .channel('tv-quiz-questions-' + seriesId)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'quiz_questions',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] quiz_questions UPDATE');
          emit('quiz_question', payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVRealtime] quiz_questions channel:', status);
        });
      subscriptions.push(questionsSub);

      // quiz_answers : INSERT (compteur "X / Y ont répondu")
      var answersSub = supabaseClient
        .channel('tv-quiz-answers-' + seriesId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'quiz_answers',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] quiz_answer INSERT');
          emit('quiz_answer', payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVRealtime] quiz_answers channel:', status);
        });
      subscriptions.push(answersSub);

      // party_answers : INSERT + UPDATE (compteur "X / Y ont voté"
      // du mode PARTIE RAPIDE). Le mode party réutilise mode='quiz' ;
      // on abonne donc party_answers ICI, nativement, dans le même
      // start() et sur le même client que quiz_answers — exactement
      // comme quiz_answers qui fonctionne. Les events sont remontés
      // via emit('party_answer', ...) → TVPartyApp.onRealtimeEvent().
      var partyAnswersSub = supabaseClient
        .channel('tv-party-answers-' + seriesId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'party_answers',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] party_answer INSERT');
          emit('party_answer', payload.new);
        })
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'party_answers',
          filter: 'series_id=eq.' + seriesId
        }, function(payload) {
          console.log('[TVRealtime] party_answer UPDATE');
          emit('party_answer', payload.new);
        })
        .subscribe(function(status) {
          console.log('[TVRealtime] party_answers channel:', status);
        });
      subscriptions.push(partyAnswersSub);
    }
  }

  // ─── Routage des events vers la bonne app ──────────────────────────
  function emit(type, payload) {
    // Le mode PARTIE RAPIDE réutilise mode='quiz' mais son app est
    // window.TVPartyApp (pas TVQuizApp). window.TVPartyApp n'existe
    // QUE sur la page tv-party.html ; sur les pages quiz/vote
    // classiques il est undefined, donc on retombe sur currentApp
    // (comportement quiz/vote strictement inchangé).
    var app = window.TVPartyApp || currentApp;
    if (app && app.onRealtimeEvent) {
      app.onRealtimeEvent(type, payload);
    }
  }

  function stop() {
    if (!supabaseClient) return;
    console.log('[TVRealtime] Arrêt des subscriptions');

    subscriptions.forEach(function(sub) {
      try {
        supabaseClient.removeChannel(sub);
      } catch (e) {
        console.warn('[TVRealtime] removeChannel:', e);
      }
    });

    subscriptions = [];
  }

  function getClient() {
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(
        window.TV_CONFIG.SUPABASE_URL,
        window.TV_CONFIG.SUPABASE_ANON_KEY
      );
    }
    return supabaseClient;
  }

  return {
    start: start,
    stop: stop,
    getClient: getClient
  };

})();
