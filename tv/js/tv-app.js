// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Logique principale
// ═══════════════════════════════════════════════════════════════════
//
// Machine à états :
//   LOBBY       : salle d'attente (avant que l'animateur démarre)
//   VOTE        : projet en cours, countdown actif
//   TRANSITION  : 2,5s entre 2 projets
//   REVEAL      : page résultats détaillée (boucle infinie phase1/phase2)
//   ERROR       : erreur (code invalide, série désactivée, etc.)
//
// La TV PILOTE l'avancement (appelle tv_advance_to_next quand le
// timer arrive à 0). Les téléphones suivent via Realtime.
//
// ═══════════════════════════════════════════════════════════════════

window.TVApp = (function() {

  // ─────────────────────────────────────────────────────────────────
  // État interne
  // ─────────────────────────────────────────────────────────────────

  var state = {
    accessCode: null,
    series: null,
    projects: [],
    profiles: {},
    voteCounts: {},
    selfies: [],
    participantsCount: 0,
    countdownInterval: null,
    transitionTimeout: null,
    // ─── État de la page résultats ─────────────────────────────────
    resultsData: null,         // JSON renvoyé par get_series_results
    revealProjectIdx: 0,       // Index du projet actuellement affiché
    revealPhase: 'raw',        // 'raw' ou 'stats'
    revealTimeout: null,       // Timeout pour passer à la phase suivante
    revealRefreshInterval: null, // Refresh des données toutes les 30s
    polaroidsTimeout: null     // Timeout pour spawner les polaroids
  };

  var _isAdvancing = false;

  // Labels & emojis des options de vote (cohérent avec l'app MAUI)
  var OPTION_META = {
    like:    { emoji: '❤️', label: 'J\'aime',     cssVal: 'val-like' },
    meh:     { emoji: '😐', label: 'Bof',         cssVal: 'val-meh' },
    dislike: { emoji: '👎', label: 'J\'aime pas', cssVal: 'val-dislike' },
    A:       { emoji: '🅰️', label: 'A',          cssVal: 'val-A' },
    B:       { emoji: '🅱️', label: 'B',          cssVal: 'val-B' }
  };

  // Ordre d'affichage des options pour photo_vote / duel
  var OPTION_ORDER_PHOTO = ['like', 'meh', 'dislike'];
  var OPTION_ORDER_DUEL  = ['A', 'B'];

  // Labels & ordre des tranches d'âge (correspond à get_series_results.sql)
  var AGE_BUCKETS = [
    { key: 'under_18', label: '< 18 ans' },
    { key: '18_25',    label: '18-25 ans' },
    { key: '26_35',    label: '26-35 ans' },
    { key: '36_50',    label: '36-50 ans' },
    { key: 'over_50',  label: '> 50 ans' },
    { key: 'unknown',  label: 'Non renseigné' }
  ];

  // Labels des genres
  var GENDER_LABELS = {
    male:               'Hommes',
    female:             'Femmes',
    other:              'Autre',
    prefer_not_to_say:  'Non précisé',
    unknown:            'Non renseigné'
  };
  var GENDER_ORDER = ['male', 'female', 'other', 'prefer_not_to_say', 'unknown'];

  // ─────────────────────────────────────────────────────────────────
  // Démarrage : appelé au chargement de tv-display.html
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

      await loadProjects();
      await loadParticipantsCount();

      window.TVRealtime.start(state.series.id);

      renderCurrentScreen();

    } catch (err) {
      console.error('[TVApp] start error:', err);
      showError('Erreur de chargement', err.message || String(err));
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Chargement des projets
  // ─────────────────────────────────────────────────────────────────

  async function loadProjects() {
    var sb = window.TVRealtime.getClient();

    var res = await sb
      .from('series_projects')
      .select('*, projects(id, title, description, type, owner_id, project_photos(id, url, side), poll_options(id, text, position))')
      .eq('series_id', state.series.id)
      .order('position', { ascending: true });

    if (res.error) throw res.error;

    state.projects = res.data || [];

    var ownerIds = state.projects
      .map(function(sp) { return sp.projects && sp.projects.owner_id; })
      .filter(function(id) { return id; });

    if (ownerIds.length > 0) {
      var profilesRes = await sb
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', ownerIds);

      if (profilesRes.data) {
        profilesRes.data.forEach(function(p) {
          state.profiles[p.id] = p;
        });
      }
    }

    var votesRes = await sb
      .from('series_votes')
      .select('series_project_id')
      .eq('series_id', state.series.id);

    if (votesRes.data) {
      votesRes.data.forEach(function(v) {
        state.voteCounts[v.series_project_id] = (state.voteCounts[v.series_project_id] || 0) + 1;
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Compter les participants depuis series_participants
  // ─────────────────────────────────────────────────────────────────

  async function loadParticipantsCount() {
    var sb = window.TVRealtime.getClient();

    var res = await sb
      .from('series_participants')
      .select('user_id', { count: 'exact', head: true })
      .eq('series_id', state.series.id);

    if (res.count !== null && res.count !== undefined) {
      state.participantsCount = res.count;
    }
    console.log('[TVApp] Participants count loaded:', state.participantsCount);
  }

  // ─────────────────────────────────────────────────────────────────
  // La TV appelle tv_advance_to_next quand le timer expire
  // ─────────────────────────────────────────────────────────────────

  async function advanceToNextProject() {
    if (_isAdvancing) {
      console.log('[TVApp] advanceToNext déjà en cours, skip');
      return;
    }
    _isAdvancing = true;

    try {
      var sb = window.TVRealtime.getClient();
      console.log('[TVApp] Appel RPC tv_advance_to_next');
      var res = await sb.rpc('tv_advance_to_next', {
        p_series_id: state.series.id
      });
      if (res.error) {
        console.error('[TVApp] tv_advance_to_next error:', res.error);
      } else {
        console.log('[TVApp] tv_advance_to_next OK:', res.data);
      }
    } catch (err) {
      console.error('[TVApp] advanceToNext exception:', err);
    } finally {
      // Reset après 3s pour éviter les double-appels rapprochés
      setTimeout(function() { _isAdvancing = false; }, 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Routeur : décide quel écran afficher selon l'état actuel
  // ─────────────────────────────────────────────────────────────────

  function renderCurrentScreen() {
    var s = state.series;
    if (!s) return;

    if (s.tv_paused) {
      showPauseOverlay();
    } else {
      hidePauseOverlay();
    }

    if (s.status === 'preparing') {
      stopRevealLoop();
      renderLobby();
    } else if (s.status === 'active') {
      stopRevealLoop();
      renderVote();
    } else if (s.status === 'finished') {
      renderReveal();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 1 : Lobby
  // ─────────────────────────────────────────────────────────────────

  function renderLobby() {
    setActiveScreen('lobby');

    var title = state.series.title || 'Soirée BeauOuPas';
    var code = state.accessCode;

    var html =
      '<div class="tv-lobby-title">' + escapeHtml(title) + '</div>' +
      '<div class="tv-lobby-subtitle">En attente du démarrage...</div>' +
      '<div class="tv-lobby-card">' +
        '<div class="tv-lobby-qr" id="lobby-qr"></div>' +
        '<div class="tv-lobby-code-block">' +
          '<div class="tv-lobby-code-label">Code d\'accès</div>' +
          '<div class="tv-lobby-code">' + escapeHtml(code) + '</div>' +
          '<div class="tv-lobby-code-hint">Tape ce code dans l\'app BeauOuPas</div>' +
        '</div>' +
      '</div>' +
      '<div class="tv-lobby-participants" id="lobby-participants">' +
        state.participantsCount + ' participant' + (state.participantsCount > 1 ? 's' : '') + ' connecté' + (state.participantsCount > 1 ? 's' : '') +
      '</div>' +
      '<div class="tv-lobby-waiting">L\'animateur clique "Commencer" sur son téléphone</div>';

    document.getElementById('screen-lobby').innerHTML = html;

    var qrEl = document.getElementById('lobby-qr');
    if (qrEl) {
      qrEl.innerHTML = '<div style="font-size: 11px; color: #888; padding: 8px; text-align: center;">QR Code<br>(à venir)</div>';
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 2 : Vote en cours
  // ─────────────────────────────────────────────────────────────────

  function renderVote() {
    setActiveScreen('vote');

    var sIdx = state.series.current_project_index || 0;
    var sp = state.projects[sIdx];

    if (!sp || !sp.projects) {
      showError('Projet introuvable', 'Le projet n°' + (sIdx + 1) + ' n\'a pas pu être chargé.');
      return;
    }

    var p = sp.projects;
    var totalProjects = state.projects.length;

    var photosHtml = renderProjectPhotos(p);

    var voteCount = state.voteCounts[sp.id] || 0;
    var totalParticipants = Math.max(1, state.participantsCount || 1);
    var percent = Math.min(100, Math.round((voteCount / totalParticipants) * 100));

    var html =
      '<div class="tv-vote-header">' +
        '<div class="tv-vote-progress">Projet ' + (sIdx + 1) + ' / ' + totalProjects + '</div>' +
        '<div class="tv-vote-countdown" id="vote-countdown">--s</div>' +
      '</div>' +
      (p.title ? '<div class="tv-vote-title">' + escapeHtml(p.title) + '</div>' : '') +
      (p.description ? '<div class="tv-vote-description">' + escapeHtml(p.description) + '</div>' : '') +
      photosHtml +
      '<div class="tv-vote-counter">' +
        '<div class="tv-vote-counter-row">' +
          '<span class="tv-vote-counter-text" id="vote-count">' + voteCount + ' / ' + totalParticipants + ' ont voté</span>' +
          '<span class="tv-vote-counter-percent" id="vote-percent">' + percent + '%</span>' +
        '</div>' +
        '<div class="tv-vote-counter-bar">' +
          '<div class="tv-vote-counter-fill" id="vote-fill" style="width: ' + percent + '%;"></div>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-vote').innerHTML = html;

    startCountdown(sp);
  }

  function renderProjectPhotos(project) {
    var photos = project.project_photos || [];
    var type = project.type;

    if (type === 'duel') {
      var photoL = photos.find(function(ph) { return ph.side === 'left' || ph.side === 'A'; }) || photos[0];
      var photoR = photos.find(function(ph) { return ph.side === 'right' || ph.side === 'B'; }) || photos[1];

      if (!photoL || !photoR) {
        return '<div class="tv-vote-photos"><div style="color: #ef5350;">Photos du duel introuvables</div></div>';
      }

      return '<div class="tv-vote-photos duel">' +
        '<div class="tv-vote-photo">' +
          '<img src="' + escapeHtml(photoL.url) + '" alt="A">' +
          '<div class="tv-vote-photo-label">A</div>' +
        '</div>' +
        '<div class="tv-vote-photo">' +
          '<img src="' + escapeHtml(photoR.url) + '" alt="B">' +
          '<div class="tv-vote-photo-label">B</div>' +
        '</div>' +
      '</div>';
    }

    if (type === 'poll') {
      var options = (project.poll_options || []).slice().sort(function(a, b) {
        return (a.position || 0) - (b.position || 0);
      });

      if (options.length === 0) {
        return '<div class="tv-vote-photos"><div style="color: #888;">Aucune option pour ce sondage</div></div>';
      }

      return '<div class="tv-vote-photos poll">' +
        '<div class="tv-vote-poll-options">' +
          options.map(function(opt) {
            return '<div class="tv-vote-poll-option">' + escapeHtml(opt.text) + '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }

    var photo = photos.find(function(ph) { return ph.side === 'single'; }) || photos[0];
    if (!photo) {
      return '<div class="tv-vote-photos"><div style="color: #ef5350;">Photo introuvable</div></div>';
    }

    return '<div class="tv-vote-photos">' +
      '<div class="tv-vote-photo" style="max-width: 80%;">' +
        '<img src="' + escapeHtml(photo.url) + '" alt="Photo">' +
      '</div>' +
    '</div>';
  }

  // ─────────────────────────────────────────────────────────────────
  // Countdown synchronisé via started_at
  // ─────────────────────────────────────────────────────────────────

  function startCountdown(seriesProject) {
    stopCountdown();

    if (!seriesProject.started_at) {
      var el = document.getElementById('vote-countdown');
      if (el) el.textContent = 'En attente';
      return;
    }

    var startedAt = new Date(seriesProject.started_at).getTime();
    var duration = window.TV_CONFIG.VOTE_DURATION_SECONDS * 1000;

    function tick() {
      if (state.series && state.series.tv_paused) return;

      var elapsed = Date.now() - startedAt;
      var remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));

      var el = document.getElementById('vote-countdown');
      if (el) {
        el.textContent = remaining + 's';
        if (remaining <= 5) {
          el.classList.add('urgent');
        } else {
          el.classList.remove('urgent');
        }
      }

      if (remaining <= 0) {
        stopCountdown();
        // La TV pilote l'avancement
        advanceToNextProject();
        renderTransition();
      }
    }

    tick();
    state.countdownInterval = setInterval(tick, 200);
  }

  function stopCountdown() {
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 3 : Transition
  // ─────────────────────────────────────────────────────────────────

  function renderTransition() {
    setActiveScreen('transition');

    var html =
      '<div class="tv-transition-icon" id="trans-icon">✅</div>' +
      '<div class="tv-transition-title" id="trans-title">Vote terminé</div>' +
      '<div class="tv-transition-subtitle" id="trans-subtitle">Projet suivant...</div>';

    document.getElementById('screen-transition').innerHTML = html;

    setTimeout(function() {
      var el = document.getElementById('trans-icon');
      if (el) el.classList.add('show');
    }, 100);
    setTimeout(function() {
      var el = document.getElementById('trans-title');
      if (el) el.classList.add('show');
    }, 500);
    setTimeout(function() {
      var el = document.getElementById('trans-subtitle');
      if (el) el.classList.add('show');
    }, 900);
  }

  // ═════════════════════════════════════════════════════════════════
  // Écran 4 : RÉSULTATS DÉTAILLÉS (boucle infinie)
  //
  // Pour chaque projet, on enchaîne 2 phases de 20s chacune :
  //   - Phase 'raw'   : photo + nb votes par option + polaroids
  //   - Phase 'stats' : répartition par genre + tranche d'âge
  // Quand on a fini tous les projets, on revient au premier.
  // L'animateur arrête en cliquant sur le bouton "Arrêter".
  // ═════════════════════════════════════════════════════════════════

  async function renderReveal() {
    setActiveScreen('reveal');

    // Affiche un spinner pendant le chargement des données
    document.getElementById('screen-reveal').innerHTML =
      '<div style="margin: auto;"><div class="tv-loading-spinner"></div></div>';

    // Charge les résultats détaillés via la fonction RPC
    var ok = await loadResultsData();
    if (!ok) return;

    // Démarre la boucle au premier projet, phase 'raw'
    state.revealProjectIdx = 0;
    state.revealPhase = 'raw';
    showRevealCurrent();

    // Refresh des données toutes les 30s pour récupérer d'éventuels
    // nouveaux selfies si le bug d'enregistrement est corrigé en MAUI
    if (state.revealRefreshInterval) clearInterval(state.revealRefreshInterval);
    state.revealRefreshInterval = setInterval(function() {
      loadResultsData(true); // silent refresh
    }, 30000);
  }

  // ─── Charge le JSON de résultats via RPC ─────────────────────────
  async function loadResultsData(silent) {
    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('get_series_results', {
        p_series_id: state.series.id
      });
      if (res.error) throw res.error;
      state.resultsData = res.data;
      console.log('[TVApp] Résultats chargés :',
        state.resultsData && state.resultsData.projects
          ? state.resultsData.projects.length + ' projets'
          : 'vide');
      return true;
    } catch (err) {
      console.error('[TVApp] loadResultsData error:', err);
      if (!silent) {
        showError('Erreur de chargement des résultats', err.message || String(err));
      }
      return false;
    }
  }

  // ─── Stoppe tous les timers liés à la page résultats ─────────────
  function stopRevealLoop() {
    if (state.revealTimeout) {
      clearTimeout(state.revealTimeout);
      state.revealTimeout = null;
    }
    if (state.revealRefreshInterval) {
      clearInterval(state.revealRefreshInterval);
      state.revealRefreshInterval = null;
    }
    if (state.polaroidsTimeout) {
      clearTimeout(state.polaroidsTimeout);
      state.polaroidsTimeout = null;
    }
  }

  // ─── Avance vers la prochaine phase de la boucle ─────────────────
  function showNextRevealStep() {
    if (state.revealPhase === 'raw') {
      // raw → stats (même projet)
      state.revealPhase = 'stats';
    } else {
      // stats → projet suivant, phase raw (boucle si on est à la fin)
      state.revealProjectIdx++;
      if (state.revealProjectIdx >= state.resultsData.projects.length) {
        state.revealProjectIdx = 0;
      }
      state.revealPhase = 'raw';
    }
    showRevealCurrent();
  }

  // ─── Affiche le projet+phase courants ────────────────────────────
  function showRevealCurrent() {
    if (!state.resultsData || !state.resultsData.projects) return;

    var project = state.resultsData.projects[state.revealProjectIdx];
    if (!project) return;

    var html;
    if (state.revealPhase === 'raw') {
      html = renderRevealRaw(project);
    } else {
      html = renderRevealStats(project);
    }

    document.getElementById('screen-reveal').innerHTML = html;

    // Branche le clic du bouton "Arrêter"
    var stopBtn = document.getElementById('reveal-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', onStopRevealClicked);

    // (Re)démarre l'animation des polaroids
    spawnPolaroids(project);

    // Programme la transition vers la prochaine phase
    var duration = (state.revealPhase === 'raw')
      ? window.TV_CONFIG.RESULTS_RAW_DURATION_MS
      : window.TV_CONFIG.RESULTS_STATS_DURATION_MS;

    if (state.revealTimeout) clearTimeout(state.revealTimeout);
    state.revealTimeout = setTimeout(showNextRevealStep, duration);
  }

  // ─── Phase 1 : photo + votes par option ──────────────────────────
  function renderRevealRaw(project) {
    var headerHtml = renderRevealHeader(project, 'Résultats');

    var bodyHtml;
    if (project.type === 'photo_vote') {
      bodyHtml = renderPhotoVoteBody(project);
    } else if (project.type === 'duel') {
      bodyHtml = renderDuelBody(project);
    } else if (project.type === 'poll') {
      bodyHtml = renderPollBody(project);
    } else {
      bodyHtml = '<div class="tv-reveal-empty">Type de projet inconnu</div>';
    }

    var totalVotes = project.total_votes || 0;
    var totalHtml = '<div class="tv-reveal-total"><strong>' + totalVotes + '</strong> vote' +
      (totalVotes > 1 ? 's' : '') + ' au total</div>';

    return wrapRevealStage(headerHtml, bodyHtml + totalHtml);
  }

  // ─── Phase 2 : stats par genre / par âge ─────────────────────────
  function renderRevealStats(project) {
    var headerHtml = renderRevealHeader(project, 'Statistiques');

    var bodyHtml;
    if (project.total_votes === 0) {
      bodyHtml = '<div class="tv-reveal-empty">Pas encore de votes pour ce projet</div>';
    } else {
      bodyHtml =
        '<div class="tv-reveal-stats-grid">' +
          renderStatsBlock('Par genre', project, GENDER_ORDER, GENDER_LABELS, project.by_gender) +
          renderStatsBlock('Par âge', project,
            AGE_BUCKETS.map(function(b) { return b.key; }),
            AGE_BUCKETS.reduce(function(acc, b) { acc[b.key] = b.label; return acc; }, {}),
            project.by_age) +
        '</div>' +
        renderStatsLegend(project);
    }

    return wrapRevealStage(headerHtml, bodyHtml);
  }

  // ─── Squelette commun (header + zone polaroids + bouton stop) ────
  function wrapRevealStage(headerHtml, bodyHtml) {
    return headerHtml +
      '<div class="tv-reveal-stage">' +
        '<div class="tv-reveal-polaroids" id="reveal-polaroids"></div>' +
        '<div class="tv-reveal-content">' + bodyHtml + '</div>' +
      '</div>' +
      '<button class="tv-reveal-stop-btn" id="reveal-stop-btn" title="Arrêter le mode TV">✕ Arrêter</button>';
  }

  function renderRevealHeader(project, phaseLabel) {
    var totalProjects = state.resultsData.projects.length;
    var pos = state.revealProjectIdx + 1;
    return '<div class="tv-reveal-header">' +
      '<div class="tv-reveal-progress">Projet ' + pos + ' / ' + totalProjects + '</div>' +
      '<div class="tv-reveal-title">' + escapeHtml(project.title || 'Sans titre') + '</div>' +
      (project.description
        ? '<div class="tv-reveal-description">' + escapeHtml(project.description) + '</div>'
        : '') +
      '<div class="tv-reveal-phase-tag">' + escapeHtml(phaseLabel) + '</div>' +
    '</div>';
  }

  // ─── Body : photo_vote (1 photo + 3 options ❤️/😐/👎) ────────────
  function renderPhotoVoteBody(project) {
    var photos = project.photos || [];
    var photo = photos.find(function(ph) { return ph.side === 'single'; }) || photos[0];

    // Détermine l'option gagnante
    var votes = project.votes || {};
    var winningKey = findWinningKey(votes, OPTION_ORDER_PHOTO);

    var photoHtml = '';
    if (photo && photo.url) {
      photoHtml =
        '<div class="tv-reveal-photos">' +
          '<div class="tv-reveal-photo">' +
            '<img src="' + escapeHtml(photo.url) + '" alt="">' +
          '</div>' +
        '</div>';
    }

    var optionsHtml = '<div class="tv-reveal-options">' +
      OPTION_ORDER_PHOTO.map(function(key) {
        return renderOptionCard(key, votes[key] || 0, key === winningKey);
      }).join('') +
    '</div>';

    return photoHtml + optionsHtml;
  }

  // ─── Body : duel (2 photos avec leur score) ──────────────────────
  function renderDuelBody(project) {
    var photos = project.photos || [];
    var photoL = photos.find(function(ph) { return ph.side === 'left'; });
    var photoR = photos.find(function(ph) { return ph.side === 'right'; });

    var votes = project.votes || {};
    var countA = votes.A || 0;
    var countB = votes.B || 0;
    var winningKey = findWinningKey(votes, OPTION_ORDER_DUEL);

    return '<div class="tv-reveal-photos duel">' +
        renderDuelPhoto(photoL, 'A', countA, winningKey === 'A') +
        renderDuelPhoto(photoR, 'B', countB, winningKey === 'B') +
      '</div>';
  }

  function renderDuelPhoto(photo, letter, count, isWinner) {
    var src = (photo && photo.url) ? photo.url : '';
    return '<div class="tv-reveal-photo' + (isWinner ? ' is-winner' : '') + '">' +
      (src ? '<img src="' + escapeHtml(src) + '" alt="' + letter + '">' : '') +
      '<div class="tv-reveal-photo-score">' +
        '<span class="tv-reveal-photo-score-letter">' + letter + '</span>' +
        count + ' vote' + (count > 1 ? 's' : '') +
      '</div>' +
    '</div>';
  }

  // ─── Body : poll (liste d'options en barres) ─────────────────────
  function renderPollBody(project) {
    var options = (project.poll_options || []).slice().sort(function(a, b) {
      return (a.position || 0) - (b.position || 0);
    });
    var votes = project.votes || {};
    var total = project.total_votes || 0;

    if (options.length === 0) {
      return '<div class="tv-reveal-empty">Aucune option pour ce sondage</div>';
    }

    // Trouve l'option gagnante (UUID avec le plus de votes)
    var winningId = null;
    var maxCount = 0;
    options.forEach(function(opt) {
      var c = votes[opt.id] || 0;
      if (c > maxCount) { maxCount = c; winningId = opt.id; }
    });
    // Ne marque "winner" que s'il y a vraiment des votes
    if (maxCount === 0) winningId = null;

    var rowsHtml = options.map(function(opt) {
      var count = votes[opt.id] || 0;
      var pct = total > 0 ? Math.round((count / total) * 100) : 0;
      var isWinner = (opt.id === winningId);
      return '<div class="tv-reveal-poll-row' + (isWinner ? ' is-winner' : '') + '">' +
        '<div class="tv-reveal-poll-row-head">' +
          '<span class="tv-reveal-poll-row-text">' + escapeHtml(opt.text) + '</span>' +
          '<span class="tv-reveal-poll-row-count">' + count + ' (' + pct + '%)</span>' +
        '</div>' +
        '<div class="tv-reveal-poll-row-bar">' +
          '<div class="tv-reveal-poll-row-fill" style="width: ' + pct + '%;"></div>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="tv-reveal-poll-list">' + rowsHtml + '</div>';
  }

  // ─── Carte option (❤️/😐/👎) ─────────────────────────────────────
  function renderOptionCard(key, count, isWinner) {
    var meta = OPTION_META[key] || { emoji: '?', label: key };
    return '<div class="tv-reveal-option' + (isWinner ? ' is-winner' : '') + '">' +
      '<div class="tv-reveal-option-emoji">' + meta.emoji + '</div>' +
      '<div class="tv-reveal-option-count">' + count + '</div>' +
      '<div class="tv-reveal-option-label">' + escapeHtml(meta.label) + '</div>' +
    '</div>';
  }

  // ─── Trouve la clé d'option avec le plus de votes ────────────────
  function findWinningKey(votes, keys) {
    var winningKey = null;
    var maxCount = 0;
    keys.forEach(function(k) {
      var c = votes[k] || 0;
      if (c > maxCount) { maxCount = c; winningKey = k; }
    });
    return maxCount > 0 ? winningKey : null;
  }

  // ─── Bloc statistiques (par genre OU par âge) ────────────────────
  function renderStatsBlock(title, project, keys, labels, dataObj) {
    dataObj = dataObj || {};
    var optionKeys = getRelevantOptionKeys(project);

    // Filtre les clés qui ont au moins un vote
    var visibleKeys = keys.filter(function(k) {
      var inner = dataObj[k];
      if (!inner) return false;
      // Vérifie qu'il y a au moins un vote sur une des options pertinentes
      return optionKeys.some(function(ok) { return (inner[ok] || 0) > 0; });
    });

    if (visibleKeys.length === 0) {
      return '<div class="tv-reveal-stats-block">' +
        '<div class="tv-reveal-stats-block-title">' + escapeHtml(title) + '</div>' +
        '<div class="tv-reveal-empty" style="font-size:1.2vw;">Pas de données</div>' +
      '</div>';
    }

    var rowsHtml = visibleKeys.map(function(k) {
      var inner = dataObj[k] || {};
      // Total pour cette ligne (somme des votes sur les options pertinentes)
      var rowTotal = optionKeys.reduce(function(sum, ok) {
        return sum + (inner[ok] || 0);
      }, 0);

      // Construit la barre empilée
      var segmentsHtml = optionKeys.map(function(ok) {
        var c = inner[ok] || 0;
        var pct = rowTotal > 0 ? (c / rowTotal) * 100 : 0;
        var cssVal = getCssValForOption(ok, project.type);
        return '<div class="tv-reveal-stats-bar-segment ' + cssVal + '" style="width: ' + pct + '%;"></div>';
      }).join('');

      return '<div class="tv-reveal-stats-row">' +
        '<div class="tv-reveal-stats-row-head">' +
          '<span class="tv-reveal-stats-row-label">' + escapeHtml(labels[k] || k) + '</span>' +
          '<span class="tv-reveal-stats-row-count">' + rowTotal + ' vote' + (rowTotal > 1 ? 's' : '') + '</span>' +
        '</div>' +
        '<div class="tv-reveal-stats-bar">' + segmentsHtml + '</div>' +
      '</div>';
    }).join('');

    return '<div class="tv-reveal-stats-block">' +
      '<div class="tv-reveal-stats-block-title">' + escapeHtml(title) + '</div>' +
      rowsHtml +
    '</div>';
  }

  // ─── Légende couleurs sous les graphiques ────────────────────────
  function renderStatsLegend(project) {
    var optionKeys = getRelevantOptionKeys(project);
    var itemsHtml = optionKeys.map(function(ok) {
      var label = getLabelForOption(ok, project);
      var cssVal = getCssValForOption(ok, project.type);
      return '<div class="tv-reveal-stats-legend-item">' +
        '<span class="tv-reveal-stats-legend-dot ' + cssVal + '"></span>' +
        '<span>' + escapeHtml(label) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="tv-reveal-stats-legend">' + itemsHtml + '</div>';
  }

  // ─── Helpers options par type de projet ──────────────────────────
  function getRelevantOptionKeys(project) {
    if (project.type === 'photo_vote') return OPTION_ORDER_PHOTO;
    if (project.type === 'duel')       return OPTION_ORDER_DUEL;
    if (project.type === 'poll') {
      // Pour les polls, on prend les UUIDs des options du projet
      return (project.poll_options || []).map(function(o) { return o.id; });
    }
    return [];
  }

  function getCssValForOption(optionKey, projectType) {
    if (projectType === 'poll') return 'val-poll';
    if (OPTION_META[optionKey]) return OPTION_META[optionKey].cssVal;
    return 'val-poll';
  }

  function getLabelForOption(optionKey, project) {
    if (project.type === 'poll') {
      var opt = (project.poll_options || []).find(function(o) { return o.id === optionKey; });
      return opt ? opt.text : '?';
    }
    return (OPTION_META[optionKey] && OPTION_META[optionKey].label) || optionKey;
  }

  // ═════════════════════════════════════════════════════════════════
  // Galerie de polaroids qui défilent en arrière-plan
  // ═════════════════════════════════════════════════════════════════

  function spawnPolaroids(project) {
    // Nettoie les anciens polaroids
    var container = document.getElementById('reveal-polaroids');
    if (!container) return;
    container.innerHTML = '';
    if (state.polaroidsTimeout) clearTimeout(state.polaroidsTimeout);

    var selfies = (project && project.selfies) || [];
    if (selfies.length === 0) return; // Rien à afficher (cas du bug actuel)

    // On veut max 5 polaroids visibles à l'écran simultanément.
    // Chaque polaroid traverse l'écran en ~14s. On en spawn un toutes les ~2,8s
    // pour avoir une cadence régulière.
    var SPAWN_INTERVAL_MS = 2800;
    var TRAVERSE_DURATION_MS = 14000;
    var idx = 0;

    function spawnNext() {
      if (!document.getElementById('reveal-polaroids')) return; // L'écran a changé
      var selfie = selfies[idx % selfies.length];
      idx++;
      addPolaroid(container, selfie, TRAVERSE_DURATION_MS);
      state.polaroidsTimeout = setTimeout(spawnNext, SPAWN_INTERVAL_MS);
    }

    // Spawn initial : 2 polaroids tout de suite (puis cadence régulière)
    addPolaroid(container, selfies[0], TRAVERSE_DURATION_MS);
    if (selfies.length > 1) {
      setTimeout(function() {
        var c = document.getElementById('reveal-polaroids');
        if (c) addPolaroid(c, selfies[1 % selfies.length], TRAVERSE_DURATION_MS);
      }, 1400);
    }
    idx = 2;
    state.polaroidsTimeout = setTimeout(spawnNext, SPAWN_INTERVAL_MS);
  }

  function addPolaroid(container, selfie, durationMs) {
    var el = document.createElement('div');
    el.className = 'tv-polaroid';

    // Position verticale aléatoire entre 10% et 70% de la zone
    var topPct = 10 + Math.random() * 60;
    // Rotation aléatoire entre -8° et +8°
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

    // Auto-retire le polaroid après son animation
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, durationMs + 200);
  }

  // ═════════════════════════════════════════════════════════════════
  // Bouton "Arrêter" → désactive le mode TV
  // ═════════════════════════════════════════════════════════════════

  async function onStopRevealClicked() {
    if (!confirm('Arrêter la diffusion des résultats sur la TV ?')) return;
    try {
      var sb = window.TVRealtime.getClient();
      var res = await sb.rpc('tv_deactivate', { p_series_id: state.series.id });
      if (res.error) throw res.error;
      console.log('[TVApp] Mode TV désactivé via bouton Arrêter');
      // Le realtime va recevoir l'UPDATE et basculer sur l'écran d'erreur
    } catch (err) {
      console.error('[TVApp] onStopRevealClicked error:', err);
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
  // Écrans
  // ─────────────────────────────────────────────────────────────────

  function setActiveScreen(name) {
    var screens = ['lobby', 'vote', 'transition', 'reveal', 'error'];
    screens.forEach(function(n) {
      var el = document.getElementById('screen-' + n);
      if (el) {
        if (n === name) el.classList.add('active');
        else el.classList.remove('active');
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers pour mettre à jour l'écran lobby/vote
  // ─────────────────────────────────────────────────────────────────

  function refreshLobbyParticipantsLabel() {
    var elLobby = document.getElementById('lobby-participants');
    if (elLobby) {
      elLobby.textContent = state.participantsCount + ' participant' +
        (state.participantsCount > 1 ? 's' : '') + ' connecté' +
        (state.participantsCount > 1 ? 's' : '');
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
        stopRevealLoop();
        showError('Mode TV désactivé', 'L\'animateur a quitté le mode TV.');
        return;
      }

      if (prev.status !== payload.status ||
          prev.current_project_index !== payload.current_project_index) {
        // Reset le flag d'avancement quand on change de projet
        _isAdvancing = false;
        renderCurrentScreen();
      }
    }
    else if (type === 'series_project') {
      var found = state.projects.find(function(sp) { return sp.id === payload.id; });
      if (found) {
        found.started_at = payload.started_at;
        found.is_revealed = payload.is_revealed;
      }
      if (state.series.status === 'active') {
        var sIdx = state.series.current_project_index || 0;
        if (state.projects[sIdx] && state.projects[sIdx].id === payload.id) {
          renderVote();
        }
      }
    }
    else if (type === 'vote') {
      var spId = payload.series_project_id;
      state.voteCounts[spId] = (state.voteCounts[spId] || 0) + 1;
      updateVoteCounter();
    }
    else if (type === 'selfie') {
      state.selfies.push(payload);
      // Si on est en page résultats, déclenche un refresh silencieux
      // pour que le nouveau selfie apparaisse dans la galerie polaroids
      if (state.series && state.series.status === 'finished') {
        loadResultsData(true);
      }
    }
    // ⚡ Nouveau participant rejoint la salle d'attente
    else if (type === 'participant') {
      state.participantsCount++;
      console.log('[TVApp] Nouveau participant, total =', state.participantsCount);
      refreshLobbyParticipantsLabel();
      updateVoteCounter();
    }
    // ⚡ un participant a quitté (Retour Android, "Quitter", "Repréparer")
    else if (type === 'participant_left') {
      state.participantsCount = Math.max(0, state.participantsCount - 1);
      console.log('[TVApp] Participant parti, total =', state.participantsCount);
      refreshLobbyParticipantsLabel();
      updateVoteCounter();
    }
  }

  function updateVoteCounter() {
    if (!state.series) return;
    var sIdx = state.series.current_project_index || 0;
    var sp = state.projects[sIdx];
    if (!sp) return;

    var voteCount = state.voteCounts[sp.id] || 0;
    var totalParticipants = Math.max(1, state.participantsCount || 1);
    var percent = Math.min(100, Math.round((voteCount / totalParticipants) * 100));

    var elCount = document.getElementById('vote-count');
    var elPercent = document.getElementById('vote-percent');
    var elFill = document.getElementById('vote-fill');

    if (elCount) elCount.textContent = voteCount + ' / ' + totalParticipants + ' ont voté';
    if (elPercent) elPercent.textContent = percent + '%';
    if (elFill) {
      elFill.style.width = percent + '%';
      if (percent >= 100) elFill.classList.add('complete');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
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
