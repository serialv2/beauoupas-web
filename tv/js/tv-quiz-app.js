// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Logique principale du mode QUIZZ
// ═══════════════════════════════════════════════════════════════════
//
// Machine à états :
//   LOBBY      : salle d'attente (status = 'preparing')
//   INTRO      : phase intro de N secondes au démarrage (status = 'active'
//                ET premier élément non commencé). Style selon quiz_style.
//   QUESTION   : question en cours, countdown actif, compteur "X/Y"
//   REVEAL     : révélation ~3s — on n'indique PLUS la bonne réponse,
//                on affiche juste les barres de répartition des votes.
//   FINISH     : status = 'finished' → vainqueur (avec wow effect) →
//                podium → leaderboard complet → stats globales
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
    detailedStats: null,      // 🆕 Stats détaillées (RPC get_quiz_detailed_stats)
    finishStep: null,         // 'winner' | 'podium' | 'leaderboard' | 'stats'
    finishStepTimeout: null
  };

  var _isAdvancing = false;     // anti double-call sur tv_advance_to_next
  var _isStartingFirst = false; // anti double-call sur tv_start_first_element

  // Durées (en ms) des étapes de fin
  var FINISH_WINNER_DURATION_MS = 8000;   // un peu plus long pour profiter du wow effect
  var FINISH_PODIUM_DURATION_MS = 8000;
  var FINISH_LEADERBOARD_DURATION_MS = 12000; // 🆕 leaderboard 12s avant stats
  // (la page stats reste affichée jusqu'à ce que l'animateur arrête)

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
        showError(window.TVI18n.t('TvDisp_Err_NotFound_Title'), window.TVI18n.t('TvDisp_Err_NotFound_Msg'));
        return;
      }

      state.series = seriesRes.data;

      if (!state.series.tv_active) {
        showError(window.TVI18n.t('TvDisp_Err_TvInactive_Title'), window.TVI18n.t('TvDisp_Err_TvInactive_Msg'));
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

    // 🎨 Style Burger : injecte le cuisinier SVG animé (fixe en bas-droite),
    // ou le retire si on bascule vers un autre style.
    var existingChef = document.getElementById('burger-chef');
    if (chosen === 'burger') {
      if (!existingChef && typeof getBurgerChefSvg === 'function') {
        var chefDiv = document.createElement('div');
        chefDiv.id = 'burger-chef';
        chefDiv.innerHTML = getBurgerChefSvg();
        document.body.appendChild(chefDiv);
      }
    } else if (existingChef) {
      existingChef.remove();
    }
  }

  /**
   * SVG d'un cuisinier cartoon animé en CSS.
   * Toque blanche + visage rond + tablier orange + bras qui balancent.
   * Les groupes (g.chef-arm-left, .chef-eyes, etc.) sont animés via
   * keyframes CSS dans tv-quiz-burger.css.
   */
  function getBurgerChefSvg() {
    return [
      '<svg viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg">',
        '<g class="chef-hat-pompom">',
          '<ellipse cx="100" cy="22" rx="42" ry="18" fill="#FFFFFF"/>',
          '<ellipse cx="80" cy="14" rx="22" ry="14" fill="#FFFFFF"/>',
          '<ellipse cx="115" cy="10" rx="24" ry="16" fill="#FFFFFF"/>',
          '<ellipse cx="100" cy="32" rx="42" ry="10" fill="#F0F0F0"/>',
        '</g>',
        '<rect x="58" y="48" width="84" height="14" rx="3" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="1.5"/>',
        '<ellipse cx="100" cy="92" rx="38" ry="36" fill="#FBD0A8" stroke="#1A1A1A" stroke-width="2"/>',
        '<g class="chef-eyes">',
          '<circle cx="86" cy="86" r="4" fill="#1A1A1A"/>',
          '<circle cx="114" cy="86" r="4" fill="#1A1A1A"/>',
          '<circle cx="87" cy="84" r="1.2" fill="#FFFFFF"/>',
          '<circle cx="115" cy="84" r="1.2" fill="#FFFFFF"/>',
        '</g>',
        '<circle cx="76" cy="100" r="4" fill="#F8A8A0" opacity="0.6"/>',
        '<circle cx="124" cy="100" r="4" fill="#F8A8A0" opacity="0.6"/>',
        '<g class="chef-mouth">',
          '<path d="M 84 105 Q 100 118 116 105" stroke="#1A1A1A" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
        '</g>',
        '<path d="M 86 102 Q 92 100 100 102 Q 108 100 114 102" stroke="#6B4423" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.7"/>',
        '<rect x="88" y="124" width="24" height="14" fill="#FBD0A8" stroke="#1A1A1A" stroke-width="2"/>',
        '<path d="M 80 138 Q 100 148 120 138 L 124 156 L 76 156 Z" fill="#C0392B" stroke="#1A1A1A" stroke-width="2"/>',
        '<circle cx="100" cy="146" r="2.5" fill="#FFD93D" stroke="#1A1A1A" stroke-width="0.8"/>',
        '<path d="M 60 156 L 50 270 L 150 270 L 140 156 Z" fill="#F39C12" stroke="#1A1A1A" stroke-width="2.5"/>',
        '<rect x="82" y="200" width="36" height="22" rx="2" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="1.5" opacity="0.7"/>',
        '<text x="100" y="216" font-family="Bangers, Comic Sans MS, cursive" font-size="14" fill="#C0392B" text-anchor="middle" font-weight="bold">BQ</text>',
        '<g class="chef-arm-left">',
          '<rect x="36" y="156" width="22" height="68" rx="11" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="2"/>',
          '<circle cx="47" cy="226" r="13" fill="#FBD0A8" stroke="#1A1A1A" stroke-width="2"/>',
        '</g>',
        '<g class="chef-arm-right">',
          '<rect x="142" y="156" width="22" height="68" rx="11" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="2"/>',
          '<circle cx="153" cy="226" r="13" fill="#FBD0A8" stroke="#1A1A1A" stroke-width="2"/>',
          '<rect x="148" y="200" width="3" height="32" fill="#8B4513" stroke="#1A1A1A" stroke-width="0.8"/>',
          '<rect x="142" y="194" width="15" height="10" rx="2" fill="#C0C0C0" stroke="#1A1A1A" stroke-width="1"/>',
        '</g>',
      '</svg>'
    ].join('');
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
  // RPCs : démarrer / avancer
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
      var firstQuestion = state.questions[0];
      if (firstQuestion && !firstQuestion.started_at) {
        if (state.currentScreen !== 'intro') {
          renderIntro();
        }
      } else {
        var idx = s.current_project_index || 0;
        var q = state.questions[idx];
        if (q && q.started_at) {
          renderQuestion(q, idx);
        } else {
          console.log('[TVQuizApp] Question sans started_at, on attend le realtime');
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

    var title = state.series.title || 'Quizz BeauOuPas';
    var code = state.accessCode;
    var nbQuestions = state.questions.length;

    var html =
      '<div class="tv-lobby-title">' + escapeHtml(title) + '</div>' +
      '<div class="tv-lobby-subtitle">' + window.TVI18n.tf(nbQuestions > 1 ? 'TvQuiz_Lobby_Subtitle_Many' : 'TvQuiz_Lobby_Subtitle_One', nbQuestions) + '</div>' +
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
      // ⚡ NOUVEAU : génération réelle du QR code
      // Le QR pointe vers join.html?code=XXX qui :
      //   - si app installée → ouvre l'app via deep link beauoupas://join?code=XXX
      //   - si app pas installée → propose le Play Store
      qrEl.innerHTML = ''; // Nettoie le placeholder

      var baseUrl = window.location.protocol + '//' + window.location.host;
      var pathParts = window.location.pathname.split('/');
      pathParts.pop(); // tv-quiz.html
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

    var title = state.series.title || 'Quizz';
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
            '<span class="quiz-intro-meta-label">question' + (nbQuestions > 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="quiz-intro-meta-item">' +
            '<span class="quiz-intro-meta-value" id="intro-participants-count">' + state.participantsCount + '</span>' +
            '<span class="quiz-intro-meta-label">joueur' + (state.participantsCount > 1 ? 's' : '') + '</span>' +
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
  // Écran 3 : QUESTION en cours
  // ─────────────────────────────────────────────────────────────────

  async function renderQuestion(question, idx) {
    setActiveScreen('question');

    var sb = window.TVRealtime.getClient();
    var optsRes = await sb.rpc('get_quiz_question_for_tv', {
      p_series_id: state.series.id
    });

    if (optsRes.error) {
      console.error('[TVQuizApp] get_quiz_question_for_tv error:', optsRes.error);
      showError('Erreur', optsRes.error.message || 'Impossible de charger la question');
      return;
    }

    var rawData = optsRes.data;
    if (!rawData || !rawData.question) {
      console.warn('[TVQuizApp] Pas de question retournée par le RPC', rawData);
      return;
    }
    var qData = rawData.question;
    if (rawData.vote_duration_seconds && state.series) {
      state.series.vote_duration_seconds = rawData.vote_duration_seconds;
    }

    var totalQuestions = state.questions.length;
    var pos = idx + 1;
    var answerCount = state.answerCounts[qData.id] || 0;
    var totalParticipants = Math.max(1, state.participantsCount || 1);

    var optionsHtml = (qData.options || []).map(function(opt, i) {
      var letter = String.fromCharCode(65 + i);
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
        '<div class="quiz-question-progress">' + window.TVI18n.tf('TvQuiz_Question_Progress', pos, totalQuestions) + '</div>' +
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
          '<span class="quiz-answers-counter-text" id="answers-count">' + window.TVI18n.tf('TvQuiz_Answered', answerCount, totalParticipants) + '</span>' +
          '<div class="quiz-answers-counter-bar">' +
            '<div class="quiz-answers-counter-fill" id="answers-fill" style="width: ' +
              Math.min(100, Math.round((answerCount / totalParticipants) * 100)) + '%;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-question').innerHTML = html;

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

      // 🎨 Style Millionnaire : alimente le cercle timer central
      var mTimer = document.getElementById('millionaire-timer');
      if (mTimer) {
        var progress = duration > 0
          ? Math.min(1, Math.max(0, elapsed / duration))
          : 0;
        mTimer.style.setProperty('--millionaire-progress', progress.toFixed(3));
        var mVal = document.getElementById('millionaire-timer-value');
        if (mVal) mVal.textContent = remaining;
        if (remaining <= 5) mTimer.classList.add('urgent');
        else mTimer.classList.remove('urgent');
      }

      // 🎨 Style Burger : le cuisinier s'agite quand le timer devient urgent
      var bChef = document.getElementById('burger-chef');
      if (bChef) {
        if (remaining <= 5) bChef.classList.add('urgent');
        else bChef.classList.remove('urgent');
      }

      if (remaining <= 0) {
        stopQuestionCountdown();
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
  // Écran 4 : REVEAL (~3s, juste les barres de votes — sans révéler la
  // bonne réponse, c'est gardé pour la page stats finale)
  // ─────────────────────────────────────────────────────────────────

  async function triggerReveal(question) {
    if (state.revealData && state.revealData.question_id === question.id) return;

    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('get_quiz_question_results', {
        p_question_id: question.id
      });
      if (res.error) throw res.error;

      state.revealData = res.data;
      state.revealData.question_id = question.id;
      renderReveal(question);
    } catch (err) {
      console.error('[TVQuizApp] triggerReveal error:', err);
      advanceToNext();
    }
  }

  function renderReveal(question) {
    setActiveScreen('reveal');

    var data = state.revealData;
    var idx = state.series.current_project_index || 0;
    var totalQuestions = state.questions.length;
    var pos = idx + 1;

    // RPC get_quiz_question_results retourne les options dans data.question.options
    var questionData = (data && data.question) ? data.question : data;
    var options = questionData.options || data.options || [];
    var questionText = questionData.question_text || data.question_text || '';
    var questionTitle = questionData.title || data.title || '';

    var totalAnswers = options.reduce(function(sum, opt) {
      return sum + (opt.vote_count || 0);
    }, 0);

    // 🔧 SUJET 1 : on ne révèle PLUS la bonne réponse pendant ce reveal
    // (ni ✓, ni surlignage vert). On affiche juste les barres de votes.
    // La bonne réponse sera révélée à la fin sur la page stats globale.
    var optionsHtml = options.map(function(opt, i) {
      var letter = String.fromCharCode(65 + i);
      var voteCount = opt.vote_count || 0;
      var percent = totalAnswers > 0 ? Math.round((voteCount / totalAnswers) * 100) : 0;
      var optText = opt.text || opt.option_text || '';

      // ⚠️ Pas de classe is-correct/is-wrong, pas d'icône ✓ : ce reveal
      // sert uniquement à montrer la répartition des votes.
      return '<div class="quiz-reveal-option">' +
        '<div class="quiz-reveal-option-main">' +
          '<div class="quiz-option-letter">' + letter + '</div>' +
          '<div class="quiz-option-text">' + escapeHtml(optText) + '</div>' +
        '</div>' +
        '<div class="quiz-reveal-option-stats">' +
          '<div class="quiz-reveal-option-bar">' +
            '<div class="quiz-reveal-option-fill" style="width: ' + percent + '%;"></div>' +
          '</div>' +
          '<div class="quiz-reveal-option-count">' + voteCount + ' (' + percent + '%)</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var titleHtml = questionTitle
      ? '<div class="quiz-question-category">' + escapeHtml(questionTitle) + '</div>'
      : '';

    var html =
      '<div class="quiz-question-header">' +
        '<div class="quiz-question-progress">' + window.TVI18n.tf('TvQuiz_Question_Progress', pos, totalQuestions) + '</div>' +
        '<div class="quiz-reveal-tag">' + window.TVI18n.t('TvQuiz_Reveal_Tag') + '</div>' +
      '</div>' +
      '<div class="quiz-question-body">' +
        titleHtml +
        '<div class="quiz-question-text">' + escapeHtml(questionText) + '</div>' +
        '<div class="quiz-options quiz-reveal-options">' + optionsHtml + '</div>' +
      '</div>' +
      '<div class="quiz-question-footer">' +
        '<div class="quiz-reveal-summary">' +
          window.TVI18n.tf(totalAnswers > 1 ? 'TvQuiz_Answers_Many' : 'TvQuiz_Answers_One', totalAnswers) +
        '</div>' +
      '</div>';

    document.getElementById('screen-reveal').innerHTML = html;

    var revealMs = window.TV_CONFIG.QUIZ_REVEAL_DURATION_MS || 3000;
    if (state.revealTimeout) clearTimeout(state.revealTimeout);
    state.revealTimeout = setTimeout(function() {
      advanceToNext();
    }, revealMs);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Écran 5 : FINISH (vainqueur → podium → leaderboard → stats)
  // ═══════════════════════════════════════════════════════════════════

  async function renderFinish() {
    setActiveScreen('finish');

    document.getElementById('screen-finish').innerHTML =
      '<div style="margin: auto;"><div class="tv-loading-spinner"></div></div>';

    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('get_quiz_final_results', {
        p_series_id: state.series.id
      });
      if (res.error) throw res.error;
      state.finalResults = res.data;

      // 🆕 Charge en parallèle les stats détaillées pour la dernière étape
      // (on ne bloque pas le rendu si ça échoue)
      sb.rpc('get_quiz_detailed_stats', { p_series_id: state.series.id })
        .then(function(r) {
          if (!r.error) {
            state.detailedStats = r.data;
            console.log('[TVQuizApp] Stats détaillées chargées');
          } else {
            console.warn('[TVQuizApp] get_quiz_detailed_stats error:', r.error);
          }
        });
    } catch (err) {
      console.error('[TVQuizApp] get_quiz_final_results error:', err);
      showError('Erreur', err.message || window.TVI18n.t('TvQuiz_Err_LoadResults'));
      return;
    }

    var top3 = state.finalResults.top3 || [];
    var leaderboard = state.finalResults.leaderboard || [];

    if (top3.length === 0 && leaderboard.length === 0) {
      document.getElementById('screen-finish').innerHTML =
        '<div style="margin: auto; text-align: center;">' +
          '<div style="font-size: 4vw; margin-bottom: 2vh;">🤔</div>' +
          '<div style="font-size: 2vw; color: white;">' + window.TVI18n.t('TvQuiz_NoParticipant') + '</div>' +
        '</div>';
      return;
    }

    // Étape 1 : vainqueur seul (avec wow effect)
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

          // 🆕 Étape 4 : page stats globales (après le leaderboard)
          state.finishStepTimeout = setTimeout(function() {
            state.finishStep = 'stats';
            renderFinishStats();
          }, FINISH_LEADERBOARD_DURATION_MS);
        }, FINISH_PODIUM_DURATION_MS);
      } else {
        // Pas de leaderboard à afficher → on saute directement aux stats
        state.finishStepTimeout = setTimeout(function() {
          state.finishStep = 'stats';
          renderFinishStats();
        }, FINISH_PODIUM_DURATION_MS);
      }
    }, FINISH_WINNER_DURATION_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 🆕 WOW EFFECT — vainqueur avec effet spectaculaire
  // ═══════════════════════════════════════════════════════════════════
  // Composition :
  //   - Overlay sombre (vignette autour du vainqueur)
  //   - Faisceau spotlight blanc descendant du haut
  //   - Couronne SVG dorée qui tombe avec rebond
  //   - Halo doré pulsant derrière l'avatar
  //   - 16 rayons dorés rotatifs autour de l'avatar
  //   - 12 étincelles SVG qui scintillent en boucle
  //   - Zoom in dramatique de l'avatar (0% → 110% → 100%)
  // ═══════════════════════════════════════════════════════════════════

  function renderFinishWinner() {
    var top3 = state.finalResults.top3 || [];
    if (top3.length === 0) return;

    var winner = top3[0];
    var avatarHtml = winner.avatar_url
      ? '<img src="' + escapeHtml(winner.avatar_url) + '" alt="">'
      : '<div class="quiz-finish-avatar-placeholder">' + escapeHtml((winner.username || '?').charAt(0).toUpperCase()) + '</div>';

    // Génère 16 rayons en SVG (étoile éclatante autour de l'avatar)
    var rays = '';
    for (var i = 0; i < 16; i++) {
      var angle = i * (360 / 16);
      rays += '<div class="winner-ray" style="transform: translate(-50%, -100%) rotate(' + angle + 'deg);"></div>';
    }

    // Génère 12 étincelles SVG dispersées autour
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
            '<path d="M12 0 L13.5 9 L24 12 L13.5 15 L12 24 L10.5 15 L0 12 L10.5 9 Z" fill="#FFD93D"/>' +
          '</svg>' +
        '</div>';
    });

    // Couronne SVG dorée
    var crownSvg =
      '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">' +
        '<defs>' +
          '<linearGradient id="crownGradient" x1="0%" y1="0%" x2="0%" y2="100%">' +
            '<stop offset="0%" style="stop-color:#FFE680"/>' +
            '<stop offset="50%" style="stop-color:#FFC107"/>' +
            '<stop offset="100%" style="stop-color:#FF8F00"/>' +
          '</linearGradient>' +
        '</defs>' +
        // Base couronne (forme cintrée)
        '<path d="M 20 70 L 30 30 L 60 60 L 100 15 L 140 60 L 170 30 L 180 70 Z" ' +
              'fill="url(#crownGradient)" stroke="#8B6914" stroke-width="2" stroke-linejoin="round"/>' +
        // Bandeau du bas
        '<rect x="20" y="68" width="160" height="14" fill="url(#crownGradient)" stroke="#8B6914" stroke-width="2"/>' +
        // Pierres précieuses (3 cercles)
        '<circle cx="60" cy="75" r="4" fill="#E91E63" stroke="#fff" stroke-width="0.8"/>' +
        '<circle cx="100" cy="75" r="5" fill="#1976D2" stroke="#fff" stroke-width="0.8"/>' +
        '<circle cx="140" cy="75" r="4" fill="#388E3C" stroke="#fff" stroke-width="0.8"/>' +
        // Points sur les pointes
        '<circle cx="30" cy="30" r="3" fill="#FFE082" stroke="#8B6914" stroke-width="1"/>' +
        '<circle cx="100" cy="15" r="4" fill="#FFE082" stroke="#8B6914" stroke-width="1"/>' +
        '<circle cx="170" cy="30" r="3" fill="#FFE082" stroke="#8B6914" stroke-width="1"/>' +
      '</svg>';

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
      // Overlay vignette : assombrit les bords pour focaliser sur le vainqueur
      '<div class="winner-vignette"></div>' +
      // Spotlight : faisceau de lumière descendant
      '<div class="winner-spotlight"></div>' +
      // Étincelles dispersées
      '<div class="winner-sparkles-layer">' + sparkles + '</div>' +
      // Conteneur central (avec animation entrance)
      '<div class="quiz-finish-winner winner-with-wow">' +
        // Couronne au-dessus de l'avatar (animation chute + rebond)
        '<div class="winner-crown">' + crownSvg + '</div>' +
        // Tag "Vainqueur"
        '<div class="quiz-finish-winner-tag">🏆 Vainqueur</div>' +
        // Avatar avec halo + rayons rotatifs derrière
        '<div class="winner-avatar-wrap">' +
          '<div class="winner-rays">' + rays + '</div>' +
          '<div class="winner-halo"></div>' +
          '<div class="quiz-finish-winner-avatar">' + avatarHtml + '</div>' +
        '</div>' +
        // Nom + score
        '<div class="quiz-finish-winner-name">' + escapeHtml(winner.username || window.TVI18n.t('TvQuiz_DefaultPlayer')) + '</div>' +
        '<div class="quiz-finish-winner-score">' +
          window.TVI18n.tf(winner.score > 1 ? 'TvQuiz_Winner_Score_Many' : 'TvQuiz_Winner_Score_One', winner.score) +
        '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function renderFinishPodium() {
    var top3 = state.finalResults.top3 || [];
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
        '<div class="quiz-podium-name">' + escapeHtml(player.username || 'Joueur') + '</div>' +
        '<div class="quiz-podium-score">' + player.score + ' pt' + (player.score > 1 ? 's' : '') + '</div>' +
      '</div>';
    }).join('');

    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
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
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
      '<div class="quiz-finish-leaderboard-wrap">' +
        '<div class="quiz-finish-leaderboard-title">Classement complet</div>' +
        '<div class="quiz-leaderboard">' + rowsHtml + '</div>' +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  // ═══════════════════════════════════════════════════════════════════
  // 🆕 PAGE STATS GLOBALES (4ème étape finish, reste affichée jusqu'à arrêt)
  // ═══════════════════════════════════════════════════════════════════

  function renderFinishStats() {
    var stats = state.detailedStats;

    // Si la RPC n'a pas répondu / a échoué : message neutre
    if (!stats || !stats.success) {
      console.warn('[TVQuizApp] Stats indisponibles, on reste sur le leaderboard');
      // On reste sur le leaderboard (pas de fallback brutal)
      return;
    }

    var totals = stats.totals || {};
    var hardest = stats.hardest_question;
    var easiest = stats.easiest_question;
    var genderArr = stats.gender_breakdown || [];
    var ageArr = stats.age_breakdown || [];

    // ─── 4 cartes totaux ──────────────────────────────────────────
    var totalsHtml =
      '<div class="quiz-stats-totals">' +
        '<div class="quiz-stats-card">' +
          '<div class="quiz-stats-card-value">' + (totals.players || 0) + '</div>' +
          '<div class="quiz-stats-card-label">Joueurs</div>' +
        '</div>' +
        '<div class="quiz-stats-card">' +
          '<div class="quiz-stats-card-value">' + (totals.questions || 0) + '</div>' +
          '<div class="quiz-stats-card-label">Questions</div>' +
        '</div>' +
        '<div class="quiz-stats-card">' +
          '<div class="quiz-stats-card-value">' + (totals.answers || 0) + '</div>' +
          '<div class="quiz-stats-card-label">' + window.TVI18n.t('TvQuiz_Stats_TotalAnswers') + '</div>' +
        '</div>' +
        '<div class="quiz-stats-card">' +
          '<div class="quiz-stats-card-value">' + (totals.success_rate || 0) + '%</div>' +
          '<div class="quiz-stats-card-label">' + window.TVI18n.t('TvQuiz_Stats_SuccessRate') + '</div>' +
        '</div>' +
      '</div>';

    // ─── 2 blocs hardest / easiest ─────────────────────────────────
    var qBlocksHtml = '<div class="quiz-stats-questions">';
    if (hardest) {
      qBlocksHtml +=
        '<div class="quiz-stats-question-card hardest">' +
          '<div class="quiz-stats-question-tag">' + window.TVI18n.t('TvQuiz_Stats_Hardest') + '</div>' +
          '<div class="quiz-stats-question-text">' + escapeHtml(hardest.question_text || '') + '</div>' +
          '<div class="quiz-stats-question-rate">' + (hardest.success_rate || 0) + window.TVI18n.t('TvQuiz_Stats_SuccessSuffix') + '</div>' +
        '</div>';
    }
    if (easiest) {
      qBlocksHtml +=
        '<div class="quiz-stats-question-card easiest">' +
          '<div class="quiz-stats-question-tag">' + window.TVI18n.t('TvQuiz_Stats_Easiest') + '</div>' +
          '<div class="quiz-stats-question-text">' + escapeHtml(easiest.question_text || '') + '</div>' +
          '<div class="quiz-stats-question-rate">' + (easiest.success_rate || 0) + window.TVI18n.t('TvQuiz_Stats_SuccessSuffix') + '</div>' +
        '</div>';
    }
    qBlocksHtml += '</div>';

    // ─── Barres genre ──────────────────────────────────────────────
    var genderLabels = { male: window.TVI18n.t('TvQuiz_Gender_Male'), female: window.TVI18n.t('TvQuiz_Gender_Female'), other: window.TVI18n.t('TvQuiz_Gender_Other'), unknown: window.TVI18n.t('TvQuiz_NotSpecified') };
    var genderBarsHtml = '';
    genderArr.forEach(function(g) {
      if (!g.count) return;
      var label = genderLabels[g.key] || window.TVI18n.t('TvQuiz_Unknown');
      genderBarsHtml +=
        '<div class="quiz-stats-bar-row">' +
          '<div class="quiz-stats-bar-header">' +
            '<span class="quiz-stats-bar-label">' + label + '</span>' +
            '<span class="quiz-stats-bar-success">✓ ' + (g.success_rate || 0) + '%</span>' +
          '</div>' +
          '<div class="quiz-stats-bar-track">' +
            '<div class="quiz-stats-bar-fill" style="width:' + Math.max(2, g.percent || 0) + '%;">' +
              '<span class="quiz-stats-bar-text">' + (g.count || 0) + ' • ' + (g.percent || 0) + '%</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    });

    // ─── Barres âge ────────────────────────────────────────────────
    var ageLabels = {
      '0_17': window.TVI18n.t('TvQuiz_Age_Under18'),
      '18_29': window.TVI18n.t('TvQuiz_Age_18_29'),
      '30_49': window.TVI18n.t('TvQuiz_Age_30_49'),
      '50_plus': window.TVI18n.t('TvQuiz_Age_50plus'),
      'unknown': window.TVI18n.t('TvQuiz_NotSpecified')
    };
    var ageBarsHtml = '';
    ageArr.forEach(function(a) {
      if (!a.count) return;
      var label = ageLabels[a.key] || window.TVI18n.t('TvQuiz_Unknown');
      ageBarsHtml +=
        '<div class="quiz-stats-bar-row">' +
          '<div class="quiz-stats-bar-header">' +
            '<span class="quiz-stats-bar-label">' + label + '</span>' +
            '<span class="quiz-stats-bar-success">✓ ' + (a.success_rate || 0) + '%</span>' +
          '</div>' +
          '<div class="quiz-stats-bar-track">' +
            '<div class="quiz-stats-bar-fill" style="width:' + Math.max(2, a.percent || 0) + '%;">' +
              '<span class="quiz-stats-bar-text">' + (a.count || 0) + ' • ' + (a.percent || 0) + '%</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    });

    var demoHtml = '<div class="quiz-stats-demo">';
    if (genderBarsHtml) {
      demoHtml +=
        '<div class="quiz-stats-demo-col">' +
          '<div class="quiz-stats-demo-title">' + window.TVI18n.t('TvQuiz_Stats_ByGender') + '</div>' +
          genderBarsHtml +
        '</div>';
    }
    if (ageBarsHtml) {
      demoHtml +=
        '<div class="quiz-stats-demo-col">' +
          '<div class="quiz-stats-demo-title">' + window.TVI18n.t('TvQuiz_Stats_ByAge') + '</div>' +
          ageBarsHtml +
        '</div>';
    }
    demoHtml += '</div>';

    // ─── Compose le HTML final ─────────────────────────────────────
    var html =
      '<button class="tv-reveal-stop-btn" id="finish-stop-btn" title="' + window.TVI18n.t('TvDisp_StopButton_Title') + '">' + window.TVI18n.t('TvDisp_StopButton') + '</button>' +
      '<div class="quiz-stats-page">' +
        '<div class="quiz-stats-title">' + window.TVI18n.t('TvQuiz_Stats_Title') + '</div>' +
        totalsHtml +
        qBlocksHtml +
        demoHtml +
      '</div>';

    document.getElementById('screen-finish').innerHTML = html;
    bindStopBtn();
  }

  function bindStopBtn() {
    var btn = document.getElementById('finish-stop-btn');
    if (btn) btn.addEventListener('click', onStopClicked);
  }

  async function onStopClicked() {
    if (!confirm(window.TVI18n.t('TvQuiz_Stop_Confirm'))) return;
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
    if (elCount) elCount.textContent = window.TVI18n.tf('TvQuiz_Answered', answerCount, totalParticipants);
    if (elFill) elFill.style.width = percent + '%';

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
        showError(window.TVI18n.t('TvDisp_Err_TvDeactivated_Title'), window.TVI18n.t('TvDisp_Err_TvDeactivated_Msg'));
        return;
      }

      if (prev.quiz_style !== payload.quiz_style) {
        applyQuizStyle(payload.quiz_style);
      }

      if (prev.status !== payload.status ||
          prev.current_project_index !== payload.current_project_index) {
        _isAdvancing = false;
        _isStartingFirst = false;
        if (prev.current_project_index !== payload.current_project_index) {
          state.revealData = null;
        }
        renderCurrentScreen();
      }
    }
    else if (type === 'quiz_question') {
      var found = state.questions.find(function(q) { return q.id === payload.id; });
      var prevStartedAt = found ? found.started_at : null;
      if (found) {
        found.started_at = payload.started_at;
      }

      var idx = state.series.current_project_index || 0;
      var currentQ = state.questions[idx];
      var newlyStarted = (!prevStartedAt && payload.started_at);
      if (currentQ && currentQ.id === payload.id && newlyStarted) {
        console.log('[TVQuizApp] Question courante a un nouveau started_at, on render');
        renderCurrentScreen();
      }
    }
    else if (type === 'quiz_answer') {
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
