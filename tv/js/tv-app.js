// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Logique principale
// ═══════════════════════════════════════════════════════════════════
//
// Machine à états :
//   LOBBY       : salle d'attente (avant que l'animateur démarre)
//   VOTE        : projet en cours, countdown actif
//   TRANSITION  : 2,5s entre 2 projets
//   REVEAL      : big reveal final (slideshow)
//   ERROR       : erreur (code invalide, série désactivée, etc.)
//
// La TV est en mode "lecture seule" : elle observe ce qui se passe en
// DB (via Realtime) et adapte son affichage. Aucune action utilisateur
// n'est possible sur la TV elle-même.
//
// ═══════════════════════════════════════════════════════════════════

window.TVApp = (function() {

  // ─────────────────────────────────────────────────────────────────
  // État interne
  // ─────────────────────────────────────────────────────────────────

  var state = {
    accessCode: null,
    series: null,           // ligne de la table series
    projects: [],           // séries_projects + jointure projects + photos
    profiles: {},           // {profileId: profile} pour les avatars
    voteCounts: {},         // {seriesProjectId: count} pour le compteur live
    selfies: [],            // selfies pour le big reveal
    participantsCount: 0,
    countdownInterval: null,
    transitionTimeout: null,
    revealStep: 0,
    revealTimeout: null
  };

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
      // 1. Charger la série via le code
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

      // 2. Charger les projets de la série (avec photos + auteur)
      await loadProjects();

      // 3. Charger les participants existants (pour le compteur)
      await loadParticipantsCount();

      // 4. Démarrer les subscriptions Realtime
      window.TVRealtime.start(state.series.id);

      // 5. Afficher l'écran approprié selon le statut
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

    // Charger les profils des auteurs (pour afficher éventuellement)
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

    // Initialiser les compteurs de votes pour chaque projet
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
  // Compteur de participants (selfies différents = participants)
  // ─────────────────────────────────────────────────────────────────

  async function loadParticipantsCount() {
    var sb = window.TVRealtime.getClient();

    // Le nombre de "participants" est calculé par le nombre de votants distincts
    // (basé sur series_votes) — c'est plus fiable que de compter les selfies
    var res = await sb
      .from('series_votes')
      .select('voter_id')
      .eq('series_id', state.series.id);

    if (res.data) {
      var uniqueVoters = {};
      res.data.forEach(function(v) { uniqueVoters[v.voter_id] = true; });
      state.participantsCount = Object.keys(uniqueVoters).length;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Routeur : décide quel écran afficher selon l'état actuel
  // ─────────────────────────────────────────────────────────────────

  function renderCurrentScreen() {
    var s = state.series;
    if (!s) return;

    // Pause overlay
    if (s.tv_paused) {
      showPauseOverlay();
    } else {
      hidePauseOverlay();
    }

    if (s.status === 'preparing') {
      renderLobby();
    } else if (s.status === 'active') {
      renderVote();
    } else if (s.status === 'finished') {
      renderReveal();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Écran 1 : Lobby (salle d'attente)
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

    // Générer le QR code (vers l'URL de l'app — à préciser plus tard)
    // Pour l'instant on affiche un placeholder
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

    // Démarrer le countdown synchronisé via started_at
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

    // Photo simple
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
      // Si en pause, on gèle l'affichage
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
        // Le timer est arrivé à 0 — on attend que la série passe au suivant
        // (c'est l'animateur ou le RPC tv_advance_to_next qui le fait)
        stopCountdown();
        // On bascule en mode "transition" en attendant
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
  // Écran 3 : Transition (2,5s)
  // ─────────────────────────────────────────────────────────────────

  function renderTransition() {
    setActiveScreen('transition');

    var html =
      '<div class="tv-transition-icon" id="trans-icon">✅</div>' +
      '<div class="tv-transition-title" id="trans-title">Vote terminé</div>' +
      '<div class="tv-transition-subtitle" id="trans-subtitle">Projet suivant...</div>';

    document.getElementById('screen-transition').innerHTML = html;

    // Animations séquencées
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

  // ─────────────────────────────────────────────────────────────────
  // Écran 4 : Big reveal (slideshow + selfies)
  // ─────────────────────────────────────────────────────────────────

  async function renderReveal() {
    setActiveScreen('reveal');

    // Charger les selfies pour le wall final
    await loadSelfies();

    state.revealStep = 0;
    showNextRevealStep();
  }

  async function loadSelfies() {
    var sb = window.TVRealtime.getClient();
    var res = await sb
      .from('series_selfies')
      .select('*')
      .eq('series_id', state.series.id);

    if (res.data) {
      state.selfies = res.data;
    }
  }

  function showNextRevealStep() {
    var totalSteps = state.projects.length + 1; // N projets + 1 final

    if (state.revealStep >= totalSteps) {
      // Boucle au début après la fin (au cas où la TV reste allumée)
      state.revealStep = 0;
    }

    if (state.revealStep < state.projects.length) {
      // Afficher un projet
      showRevealProject(state.revealStep);
      state.revealStep++;
      state.revealTimeout = setTimeout(showNextRevealStep, window.TV_CONFIG.REVEAL_PROJECT_DURATION_MS);
    } else {
      // Afficher le grand gagnant + selfies
      showRevealFinal();
      state.revealStep++;
      state.revealTimeout = setTimeout(showNextRevealStep, window.TV_CONFIG.REVEAL_WINNER_DURATION_MS);
    }
  }

  function showRevealProject(idx) {
    var sp = state.projects[idx];
    if (!sp || !sp.projects) return;

    var p = sp.projects;
    var totalProjects = state.projects.length;

    var voteCount = state.voteCounts[sp.id] || 0;

    var photoHtml = '';
    var photos = p.project_photos || [];
    var photo = photos[0];
    if (photo) {
      photoHtml = '<div class="tv-reveal-photo"><img src="' + escapeHtml(photo.url) + '" alt=""></div>';
    }

    var html =
      '<div class="tv-reveal-progress">Projet ' + (idx + 1) + ' / ' + totalProjects + '</div>' +
      '<div class="tv-reveal-content">' +
        '<div class="tv-reveal-title">' + escapeHtml(p.title || 'Projet sans titre') + '</div>' +
        '<div class="tv-reveal-photo-container">' +
          photoHtml +
        '</div>' +
        '<div class="tv-reveal-stats">' +
          '<div class="tv-reveal-stat">' +
            '<div class="tv-reveal-stat-icon">🗳️</div>' +
            '<div class="tv-reveal-stat-value">' + voteCount + '</div>' +
            '<div class="tv-reveal-stat-label">Votes</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('screen-reveal').innerHTML = html;
  }

  function showRevealFinal() {
    // Stats segmentées (pour l'instant, juste un placeholder — sera enrichi)
    var selfiesCount = state.selfies.length;

    // Choisir la classe de taille selon le nombre de selfies
    var sizeClass = 'size-small';
    if (selfiesCount > 30 && selfiesCount <= 100) sizeClass = 'size-medium';
    else if (selfiesCount > 100) sizeClass = 'size-large';

    var selfiesHtml = state.selfies.map(function(s, i) {
      var delay = (i * 30) + 'ms';
      return '<div class="tv-reveal-selfie" style="animation-delay: ' + delay + ';">' +
        (s.photo_url ? '<img src="' + escapeHtml(s.photo_url) + '" alt="">' : '') +
      '</div>';
    }).join('');

    var html =
      '<div class="tv-reveal-progress">Résultats finaux</div>' +
      '<div class="tv-reveal-content">' +
        '<div class="tv-reveal-winner-banner">🎉 Série terminée 🎉</div>' +
        '<div class="tv-reveal-title">' + escapeHtml(state.series.title || 'Soirée BeauOuPas') + '</div>' +
        (selfiesCount > 0
          ? '<div class="tv-reveal-selfies ' + sizeClass + '">' + selfiesHtml + '</div>'
          : '<div style="color: #888; font-size: 1.4vw;">Aucun selfie cette fois</div>') +
      '</div>';

    document.getElementById('screen-reveal').innerHTML = html;
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
  // Active un écran (cache les autres)
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
  // Réception des events Realtime (depuis tv-realtime.js)
  // ─────────────────────────────────────────────────────────────────

  function onRealtimeEvent(type, payload) {
    if (type === 'series') {
      // Detecter changement de status, current_project_index, tv_paused
      var prev = state.series;
      state.series = payload;

      // Pause / reprise
      if (prev.tv_paused !== payload.tv_paused) {
        if (payload.tv_paused) showPauseOverlay();
        else hidePauseOverlay();
      }

      // Désactivation du mode TV
      if (!payload.tv_active) {
        showError('Mode TV désactivé', 'L\'animateur a quitté le mode TV.');
        return;
      }

      // Changement de status (preparing → active → finished)
      if (prev.status !== payload.status ||
          prev.current_project_index !== payload.current_project_index) {
        renderCurrentScreen();
      }
    }
    else if (type === 'series_project') {
      // Mettre à jour le projet correspondant dans state.projects
      var found = state.projects.find(function(sp) { return sp.id === payload.id; });
      if (found) {
        found.started_at = payload.started_at;
        found.is_revealed = payload.is_revealed;
      }
      // Si le projet courant vient d'avoir son started_at mis à jour, on le rerend
      if (state.series.status === 'active') {
        var sIdx = state.series.current_project_index || 0;
        if (state.projects[sIdx] && state.projects[sIdx].id === payload.id) {
          renderVote();
        }
      }
    }
    else if (type === 'vote') {
      // Incrémenter le compteur du projet
      var spId = payload.series_project_id;
      state.voteCounts[spId] = (state.voteCounts[spId] || 0) + 1;
      // Mettre à jour le compteur "X / Y" si on est sur l'écran vote
      updateVoteCounter();
    }
    else if (type === 'selfie') {
      state.selfies.push(payload);
    }
  }

  function updateVoteCounter() {
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
