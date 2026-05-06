// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Logique principale du mode QUIZZ
// ═══════════════════════════════════════════════════════════════════
//
// Machine à états :
//   LOBBY      : salle d'attente (status = 'preparing')
//   INTRO      : phase intro de N secondes au démarrage (status = 'active'
//                ET premier élément non commencé). Style selon quiz_style.
//   QUESTION   : question en cours, countdown actif, compteur "X/Y"
//   REVEAL     : révélation ~3s (bonne réponse en vert + stats)
//   FINISH     : status = 'finished' → vainqueur seul → podium → classement
//   ERROR      : code invalide / TV désactivée / etc.
//
// La TV PILOTE l'avancement :
//   - À la fin de l'intro : appelle tv_start_first_element() puis bascule
//     sur la première question.
//   - Pendant une question : auto-avance quand 100% ont répondu (+2s) OU
//     quand le timer atteint 0.
//   - Entre 2 questions : RPC tv_advance_to_next() pour passer à la suivante.
//
// Style visuel : appliqué via une classe sur <body> = 'style-' + quiz_style.
// (style-kahoot, style-millionaire, style-burger, style-weakest)
//
// ═══════════════════════════════════════════════════════════════════

window.TVQuizApp = (function() {

  // ─────────────────────────────────────────────────────────────────
  // État interne
  // ─────────────────────────────────────────────────────────────────

  var state = {
    accessCode: null,
    series: null,
    questions: [],            // [{ id, position, title, question_text, photo_url, started_at }]
    answerCounts: {},         // { question_id: nombre_de_réponses }
    participantsCount: 0,

    currentScreen: null,      // 'lobby' | 'intro' | 'question' | 'reveal' | 'finish' | 'error' | 'loading'

    // Timers
    countdownInterval: null,
    introCountdownInterval: null,
    revealTimeout: null,
    introCompleteTimeout: null,

    // Phase reveal — données de la question en cours
    revealData: null,

    // Données de fin
    finalResults: null,
    finishStep: null,         // 'winner' | 'podium' | 'leaderboard'
    finishStepTimeout: null
  };

  var _isAdvancing = false;     // anti double-call sur tv_advance_to_next
  var _isStartingFirst = false; // anti double-call sur tv_start_first_element

  // Durées (en ms) des étapes de fin
  var FINISH_WINNER_DURATION_MS = 6000;
  var FINISH_PODIUM_DURATION_MS = 8000;
  // (le leaderboard reste affiché jusqu'à ce que l'animateur arrête)

  // ─────────────────────────────────────────────────────────────────
  // Démarrage
  // ─────────────────────────────────────────────────────────────────

  async function start() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');

    if (!code) {
      showError('Code manquant', 'L\'URL doit contenir ?code=XXXXXX');
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
        showError('Code introuvable', 'Vérifie que le code est correct.');
        return;
      }

      state.series = seriesRes.data;

      if (!state.series.tv_active) {
        showError('Mode TV non actif', 'L\'animateur doit activer le mode TV depuis l\'app.');
        return;
      }

      if (!state.series.is_quiz) {
        showError('Mauvaise page', 'Cette série n\'est pas un quizz. Retournez à la page d\'accueil.');
        return;
      }

      // Applique le style visuel choisi par l'animateur
      applyQuizStyle(state.series.quiz_style);

      // Charge les questions et données initiales
      await loadQuestions();
      await loadParticipantsCount();
      await loadAnswerCounts();

      // Démarre les subscriptions realtime en mode 'quiz'
      window.TVRealtime.start(state.series.id, 'quiz');

      renderCurrentScreen();

    } catch (err) {
      console.error('[TVQuizApp] start error:', err);
      showError('Erreur de chargement', err.message || String(err));
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Application du style visuel (classe sur <body>)
  // ─────────────────────────────────────────────────────────────────

  function applyQuizStyle(style) {
    var body = document.body;
    // Retire les anciennes classes de style
    ['style-kahoot', 'style-millionaire', 'style-burger', 'style-weakest']
      .forEach(function(c) { body.classList.remove(c); });
    // Ajoute la nouvelle (avec fallback sur kahoot)
    var validStyles = ['kahoot', 'millionaire', 'burger', 'weakest'];
    var chosen = validStyles.indexOf(style) >= 0 ? style : 'kahoot';
    body.classList.add('style-' + chosen);
    console.log('[TVQuizApp] Style appliqué : style-' + chosen);
  }

  // ─────────────────────────────────────────────────────────────────
  // Chargement des questions
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
    console.log('[TVQuizApp] Questions chargées :', state.questions.length);
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
    console.log('[TVQuizApp] Participants :', state.participantsCount);
  }

  // Recharge tous les compteurs de réponses (au démarrage uniquement —
  // ensuite ils sont incrémentés via realtime)
  async function loadAnswerCounts() {
    var sb = window.TVRealtime.getClient();
    var res = await sb
      .from('quiz_answers')
      .select('question_id')
      .eq('series_id', state.series.id);
    if (res.data) {
      res.data.forEach(function(a) {
        state.answerCounts[a.question_id] = (state.answerCounts[a.question_id] || 0) + 1;
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // RPC : démarrer la première question (à la fin de l'intro)
  // ─────────────────────────────────────────────────────────────────

  async function startFirstElement() {
    if (_isStartingFirst) return;
    _isStartingFirst = true;
    try {
      var sb = window.TVRealtime.getClient();
      console.log('[TVQuizApp] Appel RPC tv_start_first_element');
      var res = await sb.rpc('tv_start_first_element', {
        p_series_id: state.series.id
      });
      if (res.error) console.error('[TVQuizApp] tv_start_first_element error:', res.error);
      else console.log('[TVQuizApp] tv_start_first_element OK:', res.data);
    } catch (err) {
      console.error('[TVQuizApp] startFirstElement exception:', err);
    } finally {
      setTimeout(function() { _isStartingFirst = false; }, 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // RPC : passer à la question suivante
  // ─────────────────────────────────────────────────────────────────

  async function advanceToNext() {
    if (_isAdvancing) {
      console.log('[TVQuizApp] advanceToNext déjà en cours, skip');
      return;
    }
    _isAdvancing = true;
    try {
      var sb = window.TVRealtime.getClient();
      console.log('[TVQuizApp] Appel RPC tv_advance_to_next');
      var res = await sb.rpc('tv_advance_to_next', {
        p_series_id: state.series.id
      });
      if (res.error) console.error('[TVQuizApp] tv_advance_to_next error:', res.error);
      else console.log('[TVQuizApp] tv_advance_to_next OK:', res.data);
    } catch (err) {
      console.error('[TVQuizApp] advanceToNext exception:', err);
    } finally {
      setTimeout(function() { _isAdvancing = false; }, 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Routeur principal : décide quel écran afficher selon l'état
  // ─────────────────────────────────────────────────────────────────

  function renderCurrentScreen() {
    var s = state.series;
    if (!s) return;

    // Pause overlay (par-dessus tout)
    if (s.tv_paused) showPauseOverlay();
    else hidePauseOverlay();

    if (s.status === 'preparing') {
      stopAllTimers();
      renderLobby();
    } else if (s.status === 'active') {
      // Status active : on regarde si la 1ère question a déjà été démarrée
      var firstQuestion = state.questions[0];
      if (firstQuestion && !firstQuestion.started_at) {
        // Pas encore démarrée → on est en phase INTRO
        if (state.currentScreen !== 'intro') {
          renderIntro();
        }
      } else {
        // Une question est démarrée → afficher la question courante
        var idx = s.current_project_index || 0;
        var q = state.questions[idx];
        if (q && q.started_at) {
          renderQuestion(q, idx);
        } else {
          // Cas limite : pas de started_at sur la question courante
          // (ex: tout juste après tv_advance_to_next, le realtime n'a pas
          // encore propagé). On reste sur l'écran courant.
          console.log('[TVQuizApp] Question sans started_at, on attend le realtime');
        }
      }
    } else if (s.status === 'finished') {
      stopAllTimers();
      renderFinish();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 1 : LOBBY (réutilise le style classique BeauOuPas)
  // ─────────────────────────────────────────────────────────────────

  function renderLobby() {
    setActiveScreen('lobby');

    var title = state.series.title || 'Quizz BeauOuPas';
    var code = state.accessCode;
    var nbQuestions = state.questions.length;

    var html =
      '<div class="tv-lobby-title">' + escapeHtml(title) + '</div>' +
      '<div class="tv-lobby-subtitle">' + nbQuestions + ' question' + (nbQuestions > 1 ? 's' : '') + ' • Quizz interactif</div>' +
      '<div class="tv-lobby-card">' +
        '<div class="tv-lobby-qr" id="lobby-qr"></div>' +
        '<div class="tv-lobby-code-block">' +
          '<div class="tv-lobby-code-label">Code d\'accès</div>' +
          '<div class="tv-lobby-code">' + escapeHtml(code) + '</div>' +
          '<div class="tv-lobby-code-hint">Tape ce code dans l\'app BeauOuPas</div>' +
        '</div>' +
      '</div>' +
      '<div class="tv-lobby-participants" id="lobby-participants">' +
        formatParticipantsLabel(state.participantsCount) +
      '</div>' +
      '<div class="tv-lobby-waiting">L\'animateur clique "Commencer" sur son téléphone</div>';

    document.getElementById('screen-lobby').innerHTML = html;

    var qrEl = document.getElementById('lobby-qr');
    if (qrEl) {
      qrEl.innerHTML = '<div style="font-size: 11px; color: #888; padding: 8px; text-align: center;">QR Code<br>(à venir)</div>';
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 2 : INTRO (style-dépendant, durée configurable)
  // ─────────────────────────────────────────────────────────────────

  function renderIntro() {
    setActiveScreen('intro');

    var title = state.series.title || 'Quizz';
    var description = state.series.description || '';
    var nbQuestions = state.questions.length;
    var introDuration = state.series.intro_duration_seconds || 20;

    // Structure neutre — c'est le CSS du thème qui transforme tout ça
    var html =
      '<div class="quiz-intro-content">' +
        '<div class="quiz-intro-tag">Préparez-vous</div>' +
        '<div class="quiz-intro-title">' + escapeHtml(title) + '</div>' +
        (description
          ? '<div class="quiz-intro-description">' + escapeHtml(description) + '</div>'
          : '') +
        '<div class="quiz-intro-meta">' +
          '<div class="quiz-intro-meta-item">' +
            '<span class="quiz-intro-meta-value">' + nbQuestions + '</span>' +
            '<span class="quiz-intro-meta-label">question' + (nbQuestions > 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="quiz-intro-meta-item">' +
            '<span class="quiz-intro-meta-value" id="intro-participants-count">' + state.participantsCount + '</span>' +
            '<span class="quiz-intro-meta-label">joueur' + (state.participantsCount > 1 ? 's' : '') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="quiz-intro-countdown">' +
          '<span class="quiz-intro-countdown-label">Ça commence dans</span>' +
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
        // Fin de l'intro : on démarre la 1ère question
        // Le realtime sur quiz_questions UPDATE va rebasculer l'écran
        // automatiquement via renderCurrentScreen()
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
  // Écran 3 : QUESTION en cours
  // ─────────────────────────────────────────────────────────────────

  async function renderQuestion(question, idx) {
    setActiveScreen('question');

    // Charge les options de la question (sans is_correct, c'est la phase
    // pendant laquelle les joueurs répondent — pas de spoiler côté client)
    var sb = window.TVRealtime.getClient();
    var optsRes = await sb.rpc('get_quiz_question_for_tv', {
      p_series_id: state.series.id
    });

    if (optsRes.error) {
      console.error('[TVQuizApp] get_quiz_question_for_tv error:', optsRes.error);
      showError('Erreur', optsRes.error.message || 'Impossible de charger la question');
      return;
    }

    // Format de réponse RPC : { success, question: {...}, vote_duration_seconds, ... }
    // On extrait l'objet question + on récupère le vote_duration au top-level si présent
    var rawData = optsRes.data;
    if (!rawData || !rawData.question) {
      console.warn('[TVQuizApp] Pas de question retournée par le RPC', rawData);
      return;
    }
    var qData = rawData.question;
    // Si la RPC renvoie le vote_duration_seconds au top-level, on le synchronise
    // dans state.series pour que le countdown soit cohérent avec ce que voit le joueur
    if (rawData.vote_duration_seconds && state.series) {
      state.series.vote_duration_seconds = rawData.vote_duration_seconds;
    }

    var totalQuestions = state.questions.length;
    var pos = idx + 1;
    var answerCount = state.answerCounts[qData.id] || 0;
    var totalParticipants = Math.max(1, state.participantsCount || 1);

    // Construit les options (max 4)
    var optionsHtml = (qData.options || []).map(function(opt, i) {
      var letter = String.fromCharCode(65 + i); // A, B, C, D
      // RPC renvoie soit `text` soit `option_text` selon les versions, on supporte les 2
      var optText = opt.text || opt.option_text || '';
      return '<div class="quiz-option" data-option-idx="' + i + '">' +
        '<div class="quiz-option-letter">' + letter + '</div>' +
        '<div class="quiz-option-text">' + escapeHtml(optText) + '</div>' +
      '</div>';
    }).join('');

    var photoHtml = qData.photo_url
      ? '<div class="quiz-question-photo"><img src="' + escapeHtml(qData.photo_url) + '" alt=""></div>'
      : '';

    var titleHtml = qData.title
      ? '<div class="quiz-question-category">' + escapeHtml(qData.title) + '</div>'
      : '';

    var html =
      '<div class="quiz-question-header">' +
        '<div class="quiz-question-progress">Question ' + pos + ' / ' + totalQuestions + '</div>' +
        '<div class="quiz-question-countdown" id="question-countdown">--s</div>' +
      '</div>' +
      '<div class="quiz-question-body">' +
        titleHtml +
        '<div class="quiz-question-text">' + escapeHtml(qData.question_text) + '</div>' +
        photoHtml +
        '<div class="quiz-options">' + optionsHtml + '</div>' +
      '</div>' +
      '<div class="quiz-question-footer">' +
        '<div class="quiz-answers-counter">' +
          '<span class="quiz-answers-counter-text" id="answers-count">' + answerCount + ' / ' + totalParticipants + ' ont répondu</span>' +
          '<div class="quiz-answers-counter-bar">' +
            '<div class="quiz-answers-counter-fill" id="answers-fill" style="width: ' +
              Math.min(100, Math.round((answerCount / totalParticipants) * 100)) + '%;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-question').innerHTML = html;

    // Démarre le countdown synchronisé via started_at
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
        // Fin du timer → on charge les résultats et passe à la révélation
        triggerReveal(question);
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

  // ─────────────────────────────────────────────────────────────────
  // Écran 4 : REVEAL (~3s, bonne réponse en vert + stats)
  // ─────────────────────────────────────────────────────────────────

  async function triggerReveal(question) {
    // Garde-fou : si on a déjà déclenché la révélation pour cette question
    if (state.revealData && state.revealData.question_id === question.id) return;

    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('get_quiz_question_results', {
        p_question_id: question.id
      });
      if (res.error) throw res.error;

      state.revealData = res.data;
      // Marque l'ID de la question révélée pour éviter le double-déclenchement
      state.revealData.question_id = question.id;
      renderReveal(question);
    } catch (err) {
      console.error('[TVQuizApp] triggerReveal error:', err);
      // Si le reveal foire, on avance quand même pour ne pas bloquer
      advanceToNext();
    }
  }

  function renderReveal(question) {
    setActiveScreen('reveal');

    var data = state.revealData;
    var idx = state.series.current_project_index || 0;
    var totalQuestions = state.questions.length;
    var pos = idx + 1;

    // Compteur total de réponses pour cette question
    var totalAnswers = (data.options || []).reduce(function(sum, opt) {
      return sum + (opt.vote_count || 0);
    }, 0);

    var optionsHtml = (data.options || []).map(function(opt, i) {
      var letter = String.fromCharCode(65 + i);
      var voteCount = opt.vote_count || 0;
      var percent = totalAnswers > 0 ? Math.round((voteCount / totalAnswers) * 100) : 0;
      var classes = 'quiz-reveal-option';
      if (opt.is_correct) classes += ' is-correct';
      else classes += ' is-wrong';
      var optText = opt.text || opt.option_text || '';

      return '<div class="' + classes + '">' +
        '<div class="quiz-reveal-option-main">' +
          '<div class="quiz-option-letter">' + letter + '</div>' +
          '<div class="quiz-option-text">' + escapeHtml(optText) + '</div>' +
          '<div class="quiz-reveal-option-icon">' + (opt.is_correct ? '✓' : '') + '</div>' +
        '</div>' +
        '<div class="quiz-reveal-option-stats">' +
          '<div class="quiz-reveal-option-bar">' +
            '<div class="quiz-reveal-option-fill" style="width: ' + percent + '%;"></div>' +
          '</div>' +
          '<div class="quiz-reveal-option-count">' + voteCount + ' (' + percent + '%)</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var titleHtml = data.title
      ? '<div class="quiz-question-category">' + escapeHtml(data.title) + '</div>'
      : '';

    var html =
      '<div class="quiz-question-header">' +
        '<div class="quiz-question-progress">Question ' + pos + ' / ' + totalQuestions + '</div>' +
        '<div class="quiz-reveal-tag">Révélation</div>' +
      '</div>' +
      '<div class="quiz-question-body">' +
        titleHtml +
        '<div class="quiz-question-text">' + escapeHtml(data.question_text) + '</div>' +
        '<div class="quiz-options quiz-reveal-options">' + optionsHtml + '</div>' +
      '</div>' +
      '<div class="quiz-question-footer">' +
        '<div class="quiz-reveal-summary">' +
          totalAnswers + ' réponse' + (totalAnswers > 1 ? 's' : '') +
        '</div>' +
      '</div>';

    document.getElementById('screen-reveal').innerHTML = html;

    // Programme l'avancement vers la question suivante
    var revealMs = window.TV_CONFIG.QUIZ_REVEAL_DURATION_MS || 3000;
    if (state.revealTimeout) clearTimeout(state.revealTimeout);
    state.revealTimeout = setTimeout(function() {
      advanceToNext();
    }, revealMs);
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 5 : FINISH (vainqueur → podium → leaderboard complet)
  // ─────────────────────────────────────────────────────────────────

  async function renderFinish() {
    setActiveScreen('finish');

    // Spinner pendant le chargement
    document.getElementById('screen-finish').innerHTML =
      '<div style="margin: auto;"><div class="tv-loading-spinner"></div></div>';

    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('get_quiz_final_results', {
        p_series_id: state.series.id
      });
      if (res.error) throw res.error;
      state.finalResults = res.data;
    } catch (err) {
      console.error('[TVQuizApp] get_quiz_final_results error:', err);
      showError('Erreur', err.message || 'Impossible de charger les résultats');
      return;
    }

    var top3 = state.finalResults.top3 || [];
    var leaderboard = state.finalResults.leaderboard || [];

    if (top3.length === 0 && leaderboard.length === 0) {
      // Cas limite : aucun joueur n'a participé
      document.getElementById('screen-finish').innerHTML =
        '<div style="margin: auto; text-align: center;">' +
          '<div style="font-size: 4vw; margin-bottom: 2vh;">🤔</div>' +
          '<div style="font-size: 2vw; color: white;">Aucun joueur n\'a répondu à ce quizz</div>' +
        '</div>';
      return;
    }

    // Étape 1 : vainqueur seul
    state.finishStep = 'winner';
    renderFinishWinner();

    if (state.finishStepTimeout) clearTimeout(state.finishStepTimeout);
    state.finishStepTimeout = setTimeout(function() {
      // Étape 2 : podium top 3
      state.finishStep = 'podium';
      renderFinishPodium();

      // Étape 3 : leaderboard complet (si activé ET s'il y a plus de 3 joueurs)
      var showLeaderboard = state.series.show_full_leaderboard && leaderboard.length > 3;
      if (showLeaderboard) {
        state.finishStepTimeout = setTimeout(function() {
          state.finishStep = 'leaderboard';
          renderFinishLeaderboard();
        }, FINISH_PODIUM_DURATION_MS);
      }
    }, FINISH_WINNER_DURATION_MS);
  }

  function renderFinishWinner() {
    var top3 = state.finalResults.top3 || [];
    if (top3.length === 0) return;

    var winner = top3[0];
    var avatarHtml = winner.avatar_url
      ? '<img src="' + escapeHtml(winner.avatar_url) + '" alt="">'
      : '<div class="quiz-finish-avatar-placeholder">' + escapeHtml((winner.username || '?').charAt(0).toUpperCase()) + '</div>';

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="Arrêter le mode TV">✕ Arrêter</button>' +
      '<div class="quiz-finish-winner">' +
        '<div class="quiz-finish-winner-tag">🏆 Vainqueur</div>' +
        '<div class="quiz-finish-winner-avatar">' + avatarHtml + '</div>' +
        '<div class="quiz-finish-winner-name">' + escapeHtml(winner.username || 'Joueur') + '</div>' +
        '<div class="quiz-finish-winner-score">' +
          winner.score + ' bonne' + (winner.score > 1 ? 's' : '') + ' réponse' + (winner.score > 1 ? 's' : '') +
        '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function renderFinishPodium() {
    var top3 = state.finalResults.top3 || [];
    // Ordre d'affichage : 2e à gauche, 1er au centre, 3e à droite
    var positions = [
      { rank: 2, idx: 1, cls: 'second' },
      { rank: 1, idx: 0, cls: 'first' },
      { rank: 3, idx: 2, cls: 'third' }
    ];

    var podiumHtml = positions.map(function(p) {
      var player = top3[p.idx];
      if (!player) return ''; // Cas où il n'y a pas 3 joueurs
      var avatar = player.avatar_url
        ? '<img src="' + escapeHtml(player.avatar_url) + '" alt="">'
        : '<div class="quiz-finish-avatar-placeholder">' + escapeHtml((player.username || '?').charAt(0).toUpperCase()) + '</div>';
      return '<div class="quiz-podium-spot quiz-podium-' + p.cls + '">' +
        '<div class="quiz-podium-rank">' + p.rank + '</div>' +
        '<div class="quiz-podium-avatar">' + avatar + '</div>' +
        '<div class="quiz-podium-name">' + escapeHtml(player.username || 'Joueur') + '</div>' +
        '<div class="quiz-podium-score">' + player.score + ' pt' + (player.score > 1 ? 's' : '') + '</div>' +
      '</div>';
    }).join('');

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="Arrêter le mode TV">✕ Arrêter</button>' +
      '<div class="quiz-finish-podium-wrap">' +
        '<div class="quiz-finish-podium-title">Podium</div>' +
        '<div class="quiz-podium">' + podiumHtml + '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function renderFinishLeaderboard() {
    var leaderboard = state.finalResults.leaderboard || [];
    var rowsHtml = leaderboard.map(function(player, i) {
      var rank = i + 1;
      var medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      var avatar = player.avatar_url
        ? '<img src="' + escapeHtml(player.avatar_url) + '" alt="">'
        : '<div class="quiz-finish-avatar-placeholder small">' + escapeHtml((player.username || '?').charAt(0).toUpperCase()) + '</div>';
      return '<div class="quiz-leaderboard-row' + (rank <= 3 ? ' top3' : '') + '">' +
        '<div class="quiz-leaderboard-rank">' + medal + '</div>' +
        '<div class="quiz-leaderboard-avatar">' + avatar + '</div>' +
        '<div class="quiz-leaderboard-name">' + escapeHtml(player.username || 'Joueur') + '</div>' +
        '<div class="quiz-leaderboard-score">' + player.score + ' pt' + (player.score > 1 ? 's' : '') + '</div>' +
      '</div>';
    }).join('');

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="Arrêter le mode TV">✕ Arrêter</button>' +
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
    if (!confirm('Arrêter la diffusion du quizz sur la TV ?')) return;
    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('tv_deactivate', { p_series_id: state.series.id });
      if (res.error) throw res.error;
      console.log('[TVQuizApp] Mode TV désactivé');
    } catch (err) {
      console.error('[TVQuizApp] onStopClicked error:', err);
      alert('Erreur : ' + (err.message || err));
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Pause overlay
  // ─────────────────────────────────────────────────────────────────

  function showPauseOverlay() {
    var ov = document.getElementById('pause-overlay');
    if (ov) ov.classList.add('active');
  }
  function hidePauseOverlay() {
    var ov = document.getElementById('pause-overlay');
    if (ov) ov.classList.remove('active');
  }

  // ─────────────────────────────────────────────────────────────────
  // Erreur
  // ─────────────────────────────────────────────────────────────────

  function showError(title, message) {
    setActiveScreen('error');
    var html =
      '<div class="tv-error-icon">⚠️</div>' +
      '<div class="tv-error-title">' + escapeHtml(title) + '</div>' +
      '<div class="tv-error-message">' + escapeHtml(message) + '</div>';
    document.getElementById('screen-error').innerHTML = html;
  }

  // ─────────────────────────────────────────────────────────────────
  // Switch d'écrans
  // ─────────────────────────────────────────────────────────────────

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
    if (state.revealTimeout) {
      clearTimeout(state.revealTimeout);
      state.revealTimeout = null;
    }
    if (state.finishStepTimeout) {
      clearTimeout(state.finishStepTimeout);
      state.finishStepTimeout = null;
    }
  }

  function formatParticipantsLabel(n) {
    return n + ' joueur' + (n > 1 ? 's' : '') + ' connecté' + (n > 1 ? 's' : '');
  }

  function refreshLobbyParticipantsLabel() {
    var el = document.getElementById('lobby-participants');
    if (el) el.textContent = formatParticipantsLabel(state.participantsCount);
  }

  function refreshIntroParticipantsLabel() {
    var el = document.getElementById('intro-participants-count');
    if (el) el.textContent = state.participantsCount;
  }

  function updateAnswersCounter() {
    if (!state.series || state.currentScreen !== 'question') return;
    var idx = state.series.current_project_index || 0;
    var q = state.questions[idx];
    if (!q) return;

    var answerCount = state.answerCounts[q.id] || 0;
    var totalParticipants = Math.max(1, state.participantsCount || 1);
    var percent = Math.min(100, Math.round((answerCount / totalParticipants) * 100));

    var elCount = document.getElementById('answers-count');
    var elFill = document.getElementById('answers-fill');
    if (elCount) elCount.textContent = answerCount + ' / ' + totalParticipants + ' ont répondu';
    if (elFill) elFill.style.width = percent + '%';

    // Auto-avancement à 100% des réponses (+ délai 2s)
    // Conditions :
    //   - status = 'active' (question en cours)
    //   - au moins 1 participant
    //   - tout le monde a répondu (answerCount >= participants)
    //   - pas déjà en train d'avancer
    //   - pas en pause
    if (state.series.status === 'active'
        && state.participantsCount > 0
        && answerCount >= state.participantsCount
        && !_isAdvancing
        && !state.series.tv_paused) {

      console.log('[TVQuizApp] 🎯 Tout le monde a répondu ! Reveal dans 2s...');

      setTimeout(function() {
        if (state.series.status === 'active' && !_isAdvancing && !state.series.tv_paused
            && state.currentScreen === 'question') {
          stopQuestionCountdown();
          triggerReveal(q);
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
        showError('Mode TV désactivé', 'L\'animateur a quitté le mode TV.');
        return;
      }

      // Si quiz_style a changé en cours de route (rare mais possible),
      // on re-applique le style.
      if (prev.quiz_style !== payload.quiz_style) {
        applyQuizStyle(payload.quiz_style);
      }

      // Changement de status ou d'index → on re-route
      if (prev.status !== payload.status ||
          prev.current_project_index !== payload.current_project_index) {
        _isAdvancing = false;
        _isStartingFirst = false;
        // Reset le revealData quand on change de question
        if (prev.current_project_index !== payload.current_project_index) {
          state.revealData = null;
        }
        renderCurrentScreen();
      }
    }
    else if (type === 'quiz_question') {
      // Une question vient d'avoir son started_at posé (ou mis à jour)
      var found = state.questions.find(function(q) { return q.id === payload.id; });
      if (found) {
        found.started_at = payload.started_at;
      }
      // Si la question concernée est la question courante et qu'on n'est
      // pas déjà sur l'écran question, on re-route
      var idx = state.series.current_project_index || 0;
      if (state.questions[idx] && state.questions[idx].id === payload.id) {
        if (state.currentScreen !== 'question' && state.currentScreen !== 'reveal') {
          renderCurrentScreen();
        }
      }
    }
    else if (type === 'quiz_answer') {
      // Nouvelle réponse → incrémente le compteur
      var qid = payload.question_id;
      state.answerCounts[qid] = (state.answerCounts[qid] || 0) + 1;
      updateAnswersCounter();
    }
    else if (type === 'participant') {
      state.participantsCount++;
      console.log('[TVQuizApp] Nouveau joueur, total =', state.participantsCount);
      refreshLobbyParticipantsLabel();
      refreshIntroParticipantsLabel();
      updateAnswersCounter();
    }
    else if (type === 'participant_left') {
      state.participantsCount = Math.max(0, state.participantsCount - 1);
      console.log('[TVQuizApp] Joueur parti, total =', state.participantsCount);
      refreshLobbyParticipantsLabel();
      refreshIntroParticipantsLabel();
      updateAnswersCounter();
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

  return {
    start: start,
    onRealtimeEvent: onRealtimeEvent
  };

})();
