// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Système de traduction (i18n) léger, sans dépendance
// ═══════════════════════════════════════════════════════════════════
//
// Stratégie de langue :
//   1) Choix manuel mémorisé (sélecteur sur tv.html) — sessionStorage
//   2) Sinon : langue du navigateur de la TV (navigator.language)
//   3) Sinon / langue non supportée : fallback français
//
// Usage :
//   window.TVI18n.t('cle')                  → texte traduit
//   window.TVI18n.tf('cle', arg0, arg1...)  → texte avec {0}, {1}...
//   window.TVI18n.getLang()                 → 'fr' | 'en' | ...
//   window.TVI18n.setLang('en')             → force + mémorise + reload léger
//   window.TVI18n.applyDom(rootEl)          → traduit les [data-i18n] du DOM
//
// Fallback sûr : si une clé manque, t() renvoie la clé brute (jamais
// de crash). Les fins de ligne du projet sont CRLF — ce fichier aussi.
//
// Langues supportées : fr, en, de, es, it, nl, pt  (fr = défaut)
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var SUPPORTED = ['fr', 'en', 'de', 'es', 'it', 'nl', 'pt'];
  var DEFAULT_LANG = 'fr';
  var STORAGE_KEY = 'tv_lang_override';

  // ─── Table des chaînes (étendue à chaque lot W2..W5) ───────────────
  // Convention de clés alignée au maximum sur le .resx MAUI.
  var STRINGS = {
    // ─── tv.html — écran d'accueil (Lot W1) ───────────────────────
    'TvHome_Tagline': {
      fr: 'Mode TV — Soirée interactive',
      en: 'TV mode — Interactive party',
      de: 'TV-Modus — Interaktiver Abend',
      es: 'Modo TV — Velada interactiva',
      it: 'Modalità TV — Serata interattiva',
      nl: 'Tv-modus — Interactieve avond',
      pt: 'Modo TV — Serão interativo'
    },
    'TvHome_CodeLabel': {
      fr: 'Code de la série',
      en: 'Series code',
      de: 'Seriencode',
      es: 'Código de la serie',
      it: 'Codice della serie',
      nl: 'Seriecode',
      pt: 'Código da série'
    },
    'TvHome_StartButton': {
      fr: 'Démarrer la TV',
      en: 'Start the TV',
      de: 'TV starten',
      es: 'Iniciar la TV',
      it: 'Avvia la TV',
      nl: 'Tv starten',
      pt: 'Iniciar a TV'
    },
    'TvHome_Verifying': {
      fr: 'Vérification...',
      en: 'Checking...',
      de: 'Überprüfung...',
      es: 'Verificando...',
      it: 'Verifica...',
      nl: 'Controleren...',
      pt: 'A verificar...'
    },
    'TvHome_Err_CodeLength': {
      fr: 'Le code doit contenir 6 caractères.',
      en: 'The code must be 6 characters long.',
      de: 'Der Code muss 6 Zeichen lang sein.',
      es: 'El código debe tener 6 caracteres.',
      it: 'Il codice deve contenere 6 caratteri.',
      nl: 'De code moet 6 tekens bevatten.',
      pt: 'O código deve ter 6 caracteres.'
    },
    'TvHome_Err_NotFound': {
      fr: 'Code introuvable. Vérifie qu\'il est correct.',
      en: 'Code not found. Check that it is correct.',
      de: 'Code nicht gefunden. Bitte überprüfen.',
      es: 'Código no encontrado. Comprueba que sea correcto.',
      it: 'Codice non trovato. Verifica che sia corretto.',
      nl: 'Code niet gevonden. Controleer of hij klopt.',
      pt: 'Código não encontrado. Verifica se está correto.'
    },
    'TvHome_Err_TvNotActive': {
      fr: 'Le mode TV n\'est pas encore activé pour cette série. L\'animateur doit l\'activer depuis l\'app.',
      en: 'TV mode is not enabled yet for this series. The host must enable it from the app.',
      de: 'Der TV-Modus ist für diese Serie noch nicht aktiviert. Der Moderator muss ihn in der App aktivieren.',
      es: 'El modo TV aún no está activado para esta serie. El anfitrión debe activarlo desde la app.',
      it: 'La modalità TV non è ancora attivata per questa serie. L\'animatore deve attivarla dall\'app.',
      nl: 'De tv-modus is nog niet ingeschakeld voor deze serie. De gastheer moet hem in de app inschakelen.',
      pt: 'O modo TV ainda não está ativado para esta série. O anfitrião deve ativá-lo na app.'
    },
    'TvHome_Err_Generic': {
      fr: 'Erreur : ',
      en: 'Error: ',
      de: 'Fehler: ',
      es: 'Error: ',
      it: 'Errore: ',
      nl: 'Fout: ',
      pt: 'Erro: '
    },
    'TvHome_LangLabel': {
      fr: 'Langue',
      en: 'Language',
      de: 'Sprache',
      es: 'Idioma',
      it: 'Lingua',
      nl: 'Taal',
      pt: 'Idioma'
    },

    // ─── tv-app.js — mode display/vote (Lot W2) ───────────────────
    'TvDisp_DefaultTitle': {
      fr: 'Soirée BeauOuPas', en: 'BeauOuPas party', de: 'BeauOuPas-Abend',
      es: 'Velada BeauOuPas', it: 'Serata BeauOuPas', nl: 'BeauOuPas-avond', pt: 'Serão BeauOuPas'
    },
    'TvDisp_Err_CodeMissing_Title': {
      fr: 'Code manquant', en: 'Missing code', de: 'Code fehlt',
      es: 'Falta el código', it: 'Codice mancante', nl: 'Code ontbreekt', pt: 'Código em falta'
    },
    'TvDisp_Err_CodeMissing_Msg': {
      fr: 'L\'URL doit contenir ?code=XXXXXX', en: 'The URL must contain ?code=XXXXXX',
      de: 'Die URL muss ?code=XXXXXX enthalten', es: 'La URL debe contener ?code=XXXXXX',
      it: 'L\'URL deve contenere ?code=XXXXXX', nl: 'De URL moet ?code=XXXXXX bevatten',
      pt: 'O URL deve conter ?code=XXXXXX'
    },
    'TvDisp_Err_NotFound_Title': {
      fr: 'Code introuvable', en: 'Code not found', de: 'Code nicht gefunden',
      es: 'Código no encontrado', it: 'Codice non trovato', nl: 'Code niet gevonden', pt: 'Código não encontrado'
    },
    'TvDisp_Err_NotFound_Msg': {
      fr: 'Vérifie que le code est correct.', en: 'Check that the code is correct.',
      de: 'Bitte überprüfe den Code.', es: 'Comprueba que el código sea correcto.',
      it: 'Verifica che il codice sia corretto.', nl: 'Controleer of de code klopt.',
      pt: 'Verifica se o código está correto.'
    },
    'TvDisp_Err_TvInactive_Title': {
      fr: 'Mode TV non actif', en: 'TV mode inactive', de: 'TV-Modus inaktiv',
      es: 'Modo TV inactivo', it: 'Modalità TV non attiva', nl: 'Tv-modus niet actief', pt: 'Modo TV inativo'
    },
    'TvDisp_Err_TvInactive_Msg': {
      fr: 'L\'animateur doit activer le mode TV depuis l\'app.',
      en: 'The host must enable TV mode from the app.',
      de: 'Der Moderator muss den TV-Modus in der App aktivieren.',
      es: 'El anfitrión debe activar el modo TV desde la app.',
      it: 'L\'animatore deve attivare la modalità TV dall\'app.',
      nl: 'De gastheer moet de tv-modus in de app inschakelen.',
      pt: 'O anfitrião deve ativar o modo TV na app.'
    },
    'TvDisp_Err_Load_Title': {
      fr: 'Erreur de chargement', en: 'Loading error', de: 'Ladefehler',
      es: 'Error de carga', it: 'Errore di caricamento', nl: 'Laadfout', pt: 'Erro de carregamento'
    },
    'TvDisp_Err_LoadResults_Title': {
      fr: 'Erreur de chargement des résultats', en: 'Error loading results',
      de: 'Fehler beim Laden der Ergebnisse', es: 'Error al cargar los resultados',
      it: 'Errore nel caricamento dei risultati', nl: 'Fout bij laden van resultaten',
      pt: 'Erro ao carregar os resultados'
    },
    'TvDisp_Err_ProjectNotFound_Title': {
      fr: 'Projet introuvable', en: 'Project not found', de: 'Projekt nicht gefunden',
      es: 'Proyecto no encontrado', it: 'Progetto non trovato', nl: 'Project niet gevonden', pt: 'Projeto não encontrado'
    },
    'TvDisp_Err_ProjectNotFound_Msg': {
      fr: 'Le projet n°{0} n\'a pas pu être chargé.', en: 'Project #{0} could not be loaded.',
      de: 'Projekt Nr. {0} konnte nicht geladen werden.', es: 'No se pudo cargar el proyecto n.º {0}.',
      it: 'Impossibile caricare il progetto n°{0}.', nl: 'Project nr. {0} kon niet worden geladen.',
      pt: 'Não foi possível carregar o projeto n.º {0}.'
    },
    'TvDisp_Lobby_Waiting': {
      fr: 'En attente du démarrage...', en: 'Waiting to start...', de: 'Warten auf den Start...',
      es: 'Esperando el inicio...', it: 'In attesa dell\'avvio...', nl: 'Wachten op de start...', pt: 'À espera do início...'
    },
    'TvDisp_Lobby_CodeLabel': {
      fr: 'Code d\'accès', en: 'Access code', de: 'Zugangscode',
      es: 'Código de acceso', it: 'Codice d\'accesso', nl: 'Toegangscode', pt: 'Código de acesso'
    },
    'TvDisp_Lobby_CodeHint': {
      fr: 'Tape ce code dans l\'app BeauOuPas', en: 'Enter this code in the BeauOuPas app',
      de: 'Gib diesen Code in der BeauOuPas-App ein', es: 'Introduce este código en la app BeauOuPas',
      it: 'Inserisci questo codice nell\'app BeauOuPas', nl: 'Voer deze code in de BeauOuPas-app in',
      pt: 'Introduz este código na app BeauOuPas'
    },
    'TvDisp_Lobby_Participants_One': {
      fr: '{0} participant connecté', en: '{0} participant connected', de: '{0} Teilnehmer verbunden',
      es: '{0} participante conectado', it: '{0} partecipante connesso', nl: '{0} deelnemer verbonden', pt: '{0} participante ligado'
    },
    'TvDisp_Lobby_Participants_Many': {
      fr: '{0} participants connectés', en: '{0} participants connected', de: '{0} Teilnehmer verbunden',
      es: '{0} participantes conectados', it: '{0} partecipanti connessi', nl: '{0} deelnemers verbonden', pt: '{0} participantes ligados'
    },
    'TvDisp_Lobby_HostStart': {
      fr: 'L\'animateur clique "Commencer" sur son téléphone',
      en: 'The host taps "Start" on their phone',
      de: 'Der Moderator tippt auf seinem Telefon auf „Starten“',
      es: 'El anfitrión pulsa «Empezar» en su teléfono',
      it: 'L\'animatore tocca «Inizia» sul suo telefono',
      nl: 'De gastheer tikt op \'Starten\' op zijn telefoon',
      pt: 'O anfitrião toca em «Começar» no telemóvel'
    },
    'TvDisp_QrUnavailable': {
      fr: 'QR Code<br>indisponible', en: 'QR code<br>unavailable', de: 'QR-Code<br>nicht verfügbar',
      es: 'Código QR<br>no disponible', it: 'QR code<br>non disponibile', nl: 'QR-code<br>niet beschikbaar', pt: 'Código QR<br>indisponível'
    },
    'TvDisp_Vote_Progress': {
      fr: 'Projet {0} / {1}', en: 'Project {0} / {1}', de: 'Projekt {0} / {1}',
      es: 'Proyecto {0} / {1}', it: 'Progetto {0} / {1}', nl: 'Project {0} / {1}', pt: 'Projeto {0} / {1}'
    },
    'TvDisp_Vote_Counter': {
      fr: '{0} / {1} ont voté', en: '{0} / {1} have voted', de: '{0} / {1} haben abgestimmt',
      es: '{0} / {1} han votado', it: '{0} / {1} hanno votato', nl: '{0} / {1} hebben gestemd', pt: '{0} / {1} votaram'
    },
    'TvDisp_Vote_Waiting': {
      fr: 'En attente', en: 'Waiting', de: 'Warten',
      es: 'Esperando', it: 'In attesa', nl: 'Wachten', pt: 'A aguardar'
    },
    'TvDisp_DuelPhotosMissing': {
      fr: 'Photos du duel introuvables', en: 'Duel photos not found',
      de: 'Duell-Fotos nicht gefunden', es: 'Fotos del duelo no encontradas',
      it: 'Foto del duello non trovate', nl: 'Duelfoto\'s niet gevonden', pt: 'Fotos do duelo não encontradas'
    },
    'TvDisp_PollNoOption': {
      fr: 'Aucune option pour ce sondage', en: 'No options for this poll',
      de: 'Keine Optionen für diese Umfrage', es: 'Sin opciones para esta encuesta',
      it: 'Nessuna opzione per questo sondaggio', nl: 'Geen opties voor deze peiling', pt: 'Sem opções para esta sondagem'
    },
    'TvDisp_PhotoMissing': {
      fr: 'Photo introuvable', en: 'Photo not found', de: 'Foto nicht gefunden',
      es: 'Foto no encontrada', it: 'Foto non trovata', nl: 'Foto niet gevonden', pt: 'Foto não encontrada'
    },
    'TvDisp_Trans_VoteEnded': {
      fr: 'Vote terminé', en: 'Voting ended', de: 'Abstimmung beendet',
      es: 'Votación terminada', it: 'Voto terminato', nl: 'Stemming afgelopen', pt: 'Votação terminada'
    },
    'TvDisp_Trans_NextProject': {
      fr: 'Projet suivant...', en: 'Next project...', de: 'Nächstes Projekt...',
      es: 'Siguiente proyecto...', it: 'Prossimo progetto...', nl: 'Volgend project...', pt: 'Próximo projeto...'
    },
    'TvDisp_Reveal_Results': {
      fr: 'Résultats', en: 'Results', de: 'Ergebnisse',
      es: 'Resultados', it: 'Risultati', nl: 'Resultaten', pt: 'Resultados'
    },
    'TvDisp_Reveal_Stats': {
      fr: 'Statistiques', en: 'Statistics', de: 'Statistiken',
      es: 'Estadísticas', it: 'Statistiche', nl: 'Statistieken', pt: 'Estatísticas'
    },
    'TvDisp_Reveal_UnknownType': {
      fr: 'Type de projet inconnu', en: 'Unknown project type', de: 'Unbekannter Projekttyp',
      es: 'Tipo de proyecto desconocido', it: 'Tipo di progetto sconosciuto', nl: 'Onbekend projecttype', pt: 'Tipo de projeto desconhecido'
    },
    'TvDisp_Reveal_NoVoteYet': {
      fr: 'Pas encore de votes pour ce projet', en: 'No votes yet for this project',
      de: 'Noch keine Stimmen für dieses Projekt', es: 'Aún no hay votos para este proyecto',
      it: 'Ancora nessun voto per questo progetto', nl: 'Nog geen stemmen voor dit project', pt: 'Ainda sem votos para este projeto'
    },
    'TvDisp_Reveal_TotalVotes_One': {
      fr: '<strong>{0}</strong> vote au total', en: '<strong>{0}</strong> vote in total',
      de: '<strong>{0}</strong> Stimme insgesamt', es: '<strong>{0}</strong> voto en total',
      it: '<strong>{0}</strong> voto in totale', nl: '<strong>{0}</strong> stem in totaal', pt: '<strong>{0}</strong> voto no total'
    },
    'TvDisp_Reveal_TotalVotes_Many': {
      fr: '<strong>{0}</strong> votes au total', en: '<strong>{0}</strong> votes in total',
      de: '<strong>{0}</strong> Stimmen insgesamt', es: '<strong>{0}</strong> votos en total',
      it: '<strong>{0}</strong> voti in totale', nl: '<strong>{0}</strong> stemmen in totaal', pt: '<strong>{0}</strong> votos no total'
    },
    'TvDisp_Stats_ByGender': {
      fr: 'Par genre', en: 'By gender', de: 'Nach Geschlecht',
      es: 'Por género', it: 'Per genere', nl: 'Per geslacht', pt: 'Por género'
    },
    'TvDisp_Stats_ByAge': {
      fr: 'Par âge', en: 'By age', de: 'Nach Alter',
      es: 'Por edad', it: 'Per età', nl: 'Per leeftijd', pt: 'Por idade'
    },
    'TvDisp_Gender_Male': {
      fr: 'Hommes', en: 'Men', de: 'Männer', es: 'Hombres', it: 'Uomini', nl: 'Mannen', pt: 'Homens'
    },
    'TvDisp_Gender_Female': {
      fr: 'Femmes', en: 'Women', de: 'Frauen', es: 'Mujeres', it: 'Donne', nl: 'Vrouwen', pt: 'Mulheres'
    },
    'TvDisp_Gender_Other': {
      fr: 'Autre', en: 'Other', de: 'Andere', es: 'Otro', it: 'Altro', nl: 'Anders', pt: 'Outro'
    },
    'TvDisp_Gender_NotSpecified': {
      fr: 'Non précisé', en: 'Not specified', de: 'Keine Angabe',
      es: 'No especificado', it: 'Non specificato', nl: 'Niet opgegeven', pt: 'Não especificado'
    },
    'TvDisp_Gender_Unknown': {
      fr: 'Non renseigné', en: 'Unknown', de: 'Unbekannt',
      es: 'Sin datos', it: 'Non indicato', nl: 'Onbekend', pt: 'Sem dados'
    },
    'TvDisp_Age_Under18': {
      fr: '< 18 ans', en: '< 18 yrs', de: '< 18 J.', es: '< 18 años', it: '< 18 anni', nl: '< 18 jaar', pt: '< 18 anos'
    },
    'TvDisp_Age_18_25': {
      fr: '18-25 ans', en: '18-25 yrs', de: '18-25 J.', es: '18-25 años', it: '18-25 anni', nl: '18-25 jaar', pt: '18-25 anos'
    },
    'TvDisp_Age_26_35': {
      fr: '26-35 ans', en: '26-35 yrs', de: '26-35 J.', es: '26-35 años', it: '26-35 anni', nl: '26-35 jaar', pt: '26-35 anos'
    },
    'TvDisp_Age_36_50': {
      fr: '36-50 ans', en: '36-50 yrs', de: '36-50 J.', es: '36-50 años', it: '36-50 anni', nl: '36-50 jaar', pt: '36-50 anos'
    },
    'TvDisp_Age_Over50': {
      fr: '> 50 ans', en: '> 50 yrs', de: '> 50 J.', es: '> 50 años', it: '> 50 anni', nl: '> 50 jaar', pt: '> 50 anos'
    },
    'TvDisp_Age_Unknown': {
      fr: 'Non renseigné', en: 'Unknown', de: 'Unbekannt',
      es: 'Sin datos', it: 'Non indicato', nl: 'Onbekend', pt: 'Sem dados'
    },
    'TvDisp_Stop_Confirm': {
      fr: 'Arrêter la diffusion des résultats sur la TV ?',
      en: 'Stop broadcasting the results on the TV?',
      de: 'Die Ergebnisanzeige auf dem TV beenden?',
      es: '¿Detener la difusión de los resultados en la TV?',
      it: 'Interrompere la trasmissione dei risultati sulla TV?',
      nl: 'De resultaten op de tv stoppen?',
      pt: 'Parar a transmissão dos resultados na TV?'
    },
    'TvDisp_Err_TvDeactivated_Title': {
      fr: 'Mode TV désactivé', en: 'TV mode disabled', de: 'TV-Modus deaktiviert',
      es: 'Modo TV desactivado', it: 'Modalità TV disattivata', nl: 'Tv-modus uitgeschakeld', pt: 'Modo TV desativado'
    },
    'TvDisp_Err_TvDeactivated_Msg': {
      fr: 'L\'animateur a quitté le mode TV.', en: 'The host left TV mode.',
      de: 'Der Moderator hat den TV-Modus verlassen.', es: 'El anfitrión salió del modo TV.',
      it: 'L\'animatore ha lasciato la modalità TV.', nl: 'De gastheer heeft de tv-modus verlaten.',
      pt: 'O anfitrião saiu do modo TV.'
    },
    'TvDisp_VotesCount_One': {
      fr: '{0} vote', en: '{0} vote', de: '{0} Stimme',
      es: '{0} voto', it: '{0} voto', nl: '{0} stem', pt: '{0} voto'
    },
    'TvDisp_VotesCount_Many': {
      fr: '{0} votes', en: '{0} votes', de: '{0} Stimmen',
      es: '{0} votos', it: '{0} voti', nl: '{0} stemmen', pt: '{0} votos'
    },
    'TvDisp_StopButton': {
      fr: '✕ Arrêter', en: '✕ Stop', de: '✕ Beenden',
      es: '✕ Detener', it: '✕ Ferma', nl: '✕ Stoppen', pt: '✕ Parar'
    },
    'TvDisp_StopButton_Title': {
      fr: 'Arrêter le mode TV', en: 'Stop TV mode', de: 'TV-Modus beenden',
      es: 'Detener el modo TV', it: 'Ferma la modalità TV', nl: 'Tv-modus stoppen', pt: 'Parar o modo TV'
    },
    'TvDisp_NoData': {
      fr: 'Pas de données', en: 'No data', de: 'Keine Daten',
      es: 'Sin datos', it: 'Nessun dato', nl: 'Geen gegevens', pt: 'Sem dados'
    },

    // ─── tv-party-app.js — partie rapide (Lot W3) ─────────────────
    'TvParty_DefaultTitle': {
      fr: 'Partie Rapide', en: 'Quick Party', de: 'Schnellpartie',
      es: 'Partida rápida', it: 'Partita rapida', nl: 'Snelle partij', pt: 'Partida rápida'
    },
    'TvParty_Lobby_Subtitle_One': {
      fr: '{0} question • Partie rapide entre potes',
      en: '{0} question • Quick party with friends',
      de: '{0} Frage • Schnellpartie unter Freunden',
      es: '{0} pregunta • Partida rápida entre amigos',
      it: '{0} domanda • Partita rapida tra amici',
      nl: '{0} vraag • Snelle partij met vrienden',
      pt: '{0} pergunta • Partida rápida entre amigos'
    },
    'TvParty_Lobby_Subtitle_Many': {
      fr: '{0} questions • Partie rapide entre potes',
      en: '{0} questions • Quick party with friends',
      de: '{0} Fragen • Schnellpartie unter Freunden',
      es: '{0} preguntas • Partida rápida entre amigos',
      it: '{0} domande • Partita rapida tra amici',
      nl: '{0} vragen • Snelle partij met vrienden',
      pt: '{0} perguntas • Partida rápida entre amigos'
    },
    'TvParty_Players_One': {
      fr: '{0} joueur connecté', en: '{0} player connected', de: '{0} Spieler verbunden',
      es: '{0} jugador conectado', it: '{0} giocatore connesso', nl: '{0} speler verbonden', pt: '{0} jogador ligado'
    },
    'TvParty_Players_Many': {
      fr: '{0} joueurs connectés', en: '{0} players connected', de: '{0} Spieler verbunden',
      es: '{0} jugadores conectados', it: '{0} giocatori connessi', nl: '{0} spelers verbonden', pt: '{0} jogadores ligados'
    },
    'TvParty_Intro_GetReady': {
      fr: 'Préparez-vous', en: 'Get ready', de: 'Macht euch bereit',
      es: 'Preparaos', it: 'Preparatevi', nl: 'Maak je klaar', pt: 'Preparem-se'
    },
    'TvParty_Intro_Question_One': {
      fr: 'question', en: 'question', de: 'Frage',
      es: 'pregunta', it: 'domanda', nl: 'vraag', pt: 'pergunta'
    },
    'TvParty_Intro_Question_Many': {
      fr: 'questions', en: 'questions', de: 'Fragen',
      es: 'preguntas', it: 'domande', nl: 'vragen', pt: 'perguntas'
    },
    'TvParty_Intro_Player_One': {
      fr: 'joueur', en: 'player', de: 'Spieler',
      es: 'jugador', it: 'giocatore', nl: 'speler', pt: 'jogador'
    },
    'TvParty_Intro_Player_Many': {
      fr: 'joueurs', en: 'players', de: 'Spieler',
      es: 'jugadores', it: 'giocatori', nl: 'spelers', pt: 'jogadores'
    },
    'TvParty_Intro_StartsIn': {
      fr: 'Ça commence dans', en: 'Starting in', de: 'Es beginnt in',
      es: 'Empieza en', it: 'Inizia tra', nl: 'Begint over', pt: 'Começa em'
    },
    'TvParty_Voted': {
      fr: '{0} / {1} ont voté', en: '{0} / {1} have voted', de: '{0} / {1} haben abgestimmt',
      es: '{0} / {1} han votado', it: '{0} / {1} hanno votato', nl: '{0} / {1} hebben gestemd', pt: '{0} / {1} votaram'
    },
    'TvParty_Err_LoadResults': {
      fr: 'Impossible de charger les résultats', en: 'Unable to load the results',
      de: 'Ergebnisse können nicht geladen werden', es: 'No se pueden cargar los resultados',
      it: 'Impossibile caricare i risultati', nl: 'Kan de resultaten niet laden', pt: 'Não foi possível carregar os resultados'
    },
    'TvParty_Err_WrongPage_Title': {
      fr: 'Mauvaise page', en: 'Wrong page', de: 'Falsche Seite',
      es: 'Página incorrecta', it: 'Pagina sbagliata', nl: 'Verkeerde pagina', pt: 'Página errada'
    },
    'TvParty_Err_WrongPage_Msg': {
      fr: 'Cette série n\'est pas une partie rapide. Retournez à la page d\'accueil.',
      en: 'This series is not a quick party. Go back to the home page.',
      de: 'Diese Serie ist keine Schnellpartie. Kehre zur Startseite zurück.',
      es: 'Esta serie no es una partida rápida. Vuelve a la página de inicio.',
      it: 'Questa serie non è una partita rapida. Torna alla pagina iniziale.',
      nl: 'Deze serie is geen snelle partij. Ga terug naar de startpagina.',
      pt: 'Esta série não é uma partida rápida. Volta à página inicial.'
    },
    'TvParty_NoParticipant': {
      fr: 'Personne n\'a participé à cette partie', en: 'Nobody took part in this party',
      de: 'Niemand hat an dieser Partie teilgenommen', es: 'Nadie participó en esta partida',
      it: 'Nessuno ha partecipato a questa partita', nl: 'Niemand heeft aan deze partij meegedaan',
      pt: 'Ninguém participou nesta partida'
    },
    'TvParty_NoVoteQuestion': {
      fr: 'Personne n\'a voté sur cette question', en: 'Nobody voted on this question',
      de: 'Niemand hat bei dieser Frage abgestimmt', es: 'Nadie votó en esta pregunta',
      it: 'Nessuno ha votato a questa domanda', nl: 'Niemand heeft op deze vraag gestemd',
      pt: 'Ninguém votou nesta pergunta'
    },
    'TvParty_Recap_Progress': {
      fr: 'Récap {0} / {1}', en: 'Recap {0} / {1}', de: 'Rückblick {0} / {1}',
      es: 'Resumen {0} / {1}', it: 'Riepilogo {0} / {1}', nl: 'Overzicht {0} / {1}', pt: 'Resumo {0} / {1}'
    },
    'TvParty_Recap_Tag': {
      fr: 'Résultats', en: 'Results', de: 'Ergebnisse',
      es: 'Resultados', it: 'Risultati', nl: 'Resultaten', pt: 'Resultados'
    },
    'TvParty_Finished': {
      fr: 'Partie terminée', en: 'Party finished', de: 'Partie beendet',
      es: 'Partida terminada', it: 'Partita terminata', nl: 'Partij afgelopen', pt: 'Partida terminada'
    },
    'TvParty_DefaultPlayer': {
      fr: 'Joueur', en: 'Player', de: 'Spieler',
      es: 'Jugador', it: 'Giocatore', nl: 'Speler', pt: 'Jogador'
    },
    'TvParty_Winner_Score_One': {
      fr: '{0} question gagnée', en: '{0} question won', de: '{0} Frage gewonnen',
      es: '{0} pregunta ganada', it: '{0} domanda vinta', nl: '{0} vraag gewonnen', pt: '{0} pergunta ganha'
    },
    'TvParty_Winner_Score_Many': {
      fr: '{0} questions gagnées', en: '{0} questions won', de: '{0} Fragen gewonnen',
      es: '{0} preguntas ganadas', it: '{0} domande vinte', nl: '{0} vragen gewonnen', pt: '{0} perguntas ganhas'
    },
    'TvParty_Stop_Confirm': {
      fr: 'Arrêter la diffusion de la partie sur la TV ?',
      en: 'Stop broadcasting the party on the TV?',
      de: 'Die Übertragung der Partie auf dem TV beenden?',
      es: '¿Detener la difusión de la partida en la TV?',
      it: 'Interrompere la trasmissione della partita sulla TV?',
      nl: 'De partij op de tv stoppen?',
      pt: 'Parar a transmissão da partida na TV?'
    },

    // ─── tv-quiz-app.js — quiz Kahoot classique (Lot W4) ──────────
    'TvQuiz_DefaultTitle': {
      fr: 'Quiz', en: 'Quiz', de: 'Quiz', es: 'Cuestionario', it: 'Quiz', nl: 'Quiz', pt: 'Quiz'
    },
    'TvQuiz_Lobby_Subtitle_One': {
      fr: '{0} question • Quiz interactif', en: '{0} question • Interactive quiz',
      de: '{0} Frage • Interaktives Quiz', es: '{0} pregunta • Cuestionario interactivo',
      it: '{0} domanda • Quiz interattivo', nl: '{0} vraag • Interactieve quiz',
      pt: '{0} pergunta • Quiz interativo'
    },
    'TvQuiz_Lobby_Subtitle_Many': {
      fr: '{0} questions • Quiz interactif', en: '{0} questions • Interactive quiz',
      de: '{0} Fragen • Interaktives Quiz', es: '{0} preguntas • Cuestionario interactivo',
      it: '{0} domande • Quiz interattivo', nl: '{0} vragen • Interactieve quiz',
      pt: '{0} perguntas • Quiz interativo'
    },
    'TvQuiz_Answered': {
      fr: '{0} / {1} ont répondu', en: '{0} / {1} have answered', de: '{0} / {1} haben geantwortet',
      es: '{0} / {1} han respondido', it: '{0} / {1} hanno risposto', nl: '{0} / {1} hebben geantwoord', pt: '{0} / {1} responderam'
    },
    'TvQuiz_Question_Progress': {
      fr: 'Question {0} / {1}', en: 'Question {0} / {1}', de: 'Frage {0} / {1}',
      es: 'Pregunta {0} / {1}', it: 'Domanda {0} / {1}', nl: 'Vraag {0} / {1}', pt: 'Pergunta {0} / {1}'
    },
    'TvQuiz_Reveal_Tag': {
      fr: 'Résultats', en: 'Results', de: 'Ergebnisse',
      es: 'Resultados', it: 'Risultati', nl: 'Resultaten', pt: 'Resultados'
    },
    'TvQuiz_Answers_One': {
      fr: '{0} réponse', en: '{0} answer', de: '{0} Antwort',
      es: '{0} respuesta', it: '{0} risposta', nl: '{0} antwoord', pt: '{0} resposta'
    },
    'TvQuiz_Answers_Many': {
      fr: '{0} réponses', en: '{0} answers', de: '{0} Antworten',
      es: '{0} respuestas', it: '{0} risposte', nl: '{0} antwoorden', pt: '{0} respostas'
    },
    'TvQuiz_Err_LoadResults': {
      fr: 'Impossible de charger les résultats', en: 'Unable to load the results',
      de: 'Ergebnisse können nicht geladen werden', es: 'No se pueden cargar los resultados',
      it: 'Impossibile caricare i risultati', nl: 'Kan de resultaten niet laden', pt: 'Não foi possível carregar os resultados'
    },
    'TvQuiz_NoParticipant': {
      fr: 'Personne n\'a répondu à ce quiz', en: 'Nobody answered this quiz',
      de: 'Niemand hat dieses Quiz beantwortet', es: 'Nadie respondió a este cuestionario',
      it: 'Nessuno ha risposto a questo quiz', nl: 'Niemand heeft deze quiz beantwoord',
      pt: 'Ninguém respondeu a este quiz'
    },
    'TvQuiz_Stats_Title': {
      fr: '📊 Statistiques du quiz', en: '📊 Quiz statistics', de: '📊 Quiz-Statistiken',
      es: '📊 Estadísticas del cuestionario', it: '📊 Statistiche del quiz', nl: '📊 Quizstatistieken', pt: '📊 Estatísticas do quiz'
    },
    'TvQuiz_Stats_TotalAnswers': {
      fr: 'Réponses totales', en: 'Total answers', de: 'Antworten insgesamt',
      es: 'Respuestas totales', it: 'Risposte totali', nl: 'Totaal antwoorden', pt: 'Respostas totais'
    },
    'TvQuiz_Stats_SuccessRate': {
      fr: 'Taux de réussite', en: 'Success rate', de: 'Erfolgsquote',
      es: 'Tasa de acierto', it: 'Tasso di successo', nl: 'Slaagpercentage', pt: 'Taxa de acerto'
    },
    'TvQuiz_Stats_Hardest': {
      fr: '❄️ Question la plus difficile', en: '❄️ Hardest question',
      de: '❄️ Schwierigste Frage', es: '❄️ Pregunta más difícil',
      it: '❄️ Domanda più difficile', nl: '❄️ Moeilijkste vraag', pt: '❄️ Pergunta mais difícil'
    },
    'TvQuiz_Stats_Easiest': {
      fr: '🔥 Question la plus facile', en: '🔥 Easiest question',
      de: '🔥 Leichteste Frage', es: '🔥 Pregunta más fácil',
      it: '🔥 Domanda più facile', nl: '🔥 Makkelijkste vraag', pt: '🔥 Pergunta mais fácil'
    },
    'TvQuiz_Stats_SuccessSuffix': {
      fr: '% de réussite', en: '% success', de: '% Erfolg',
      es: '% de acierto', it: '% di successo', nl: '% succes', pt: '% de acerto'
    },
    'TvQuiz_Stats_ByGender': {
      fr: 'Par genre', en: 'By gender', de: 'Nach Geschlecht',
      es: 'Por género', it: 'Per genere', nl: 'Per geslacht', pt: 'Por género'
    },
    'TvQuiz_Stats_ByAge': {
      fr: 'Par tranche d\'âge', en: 'By age group', de: 'Nach Altersgruppe',
      es: 'Por grupo de edad', it: 'Per fascia d\'età', nl: 'Per leeftijdsgroep', pt: 'Por faixa etária'
    },
    'TvQuiz_Gender_Male': {
      fr: 'Hommes', en: 'Men', de: 'Männer', es: 'Hombres', it: 'Uomini', nl: 'Mannen', pt: 'Homens'
    },
    'TvQuiz_Gender_Female': {
      fr: 'Femmes', en: 'Women', de: 'Frauen', es: 'Mujeres', it: 'Donne', nl: 'Vrouwen', pt: 'Mulheres'
    },
    'TvQuiz_Gender_Other': {
      fr: 'Autre', en: 'Other', de: 'Andere', es: 'Otro', it: 'Altro', nl: 'Anders', pt: 'Outro'
    },
    'TvQuiz_NotSpecified': {
      fr: 'Non précisé', en: 'Not specified', de: 'Keine Angabe',
      es: 'No especificado', it: 'Non specificato', nl: 'Niet opgegeven', pt: 'Não especificado'
    },
    'TvQuiz_Unknown': {
      fr: 'Inconnu', en: 'Unknown', de: 'Unbekannt',
      es: 'Desconocido', it: 'Sconosciuto', nl: 'Onbekend', pt: 'Desconhecido'
    },
    'TvQuiz_Age_Under18': {
      fr: 'Moins de 18 ans', en: 'Under 18', de: 'Unter 18',
      es: 'Menos de 18 años', it: 'Meno di 18 anni', nl: 'Jonger dan 18', pt: 'Menos de 18 anos'
    },
    'TvQuiz_Age_18_29': {
      fr: '18 - 29 ans', en: '18 - 29 yrs', de: '18 - 29 J.',
      es: '18 - 29 años', it: '18 - 29 anni', nl: '18 - 29 jaar', pt: '18 - 29 anos'
    },
    'TvQuiz_Age_30_49': {
      fr: '30 - 49 ans', en: '30 - 49 yrs', de: '30 - 49 J.',
      es: '30 - 49 años', it: '30 - 49 anni', nl: '30 - 49 jaar', pt: '30 - 49 anos'
    },
    'TvQuiz_Age_50plus': {
      fr: '50 ans et plus', en: '50 and over', de: '50 und älter',
      es: '50 años o más', it: '50 anni e oltre', nl: '50 jaar en ouder', pt: '50 anos ou mais'
    },
    'TvQuiz_Stop_Confirm': {
      fr: 'Arrêter la diffusion du quiz sur la TV ?',
      en: 'Stop broadcasting the quiz on the TV?',
      de: 'Die Übertragung des Quiz auf dem TV beenden?',
      es: '¿Detener la difusión del cuestionario en la TV?',
      it: 'Interrompere la trasmissione del quiz sulla TV?',
      nl: 'De quiz op de tv stoppen?',
      pt: 'Parar a transmissão do quiz na TV?'
    },
    'TvQuiz_Winner_Score_One': {
      fr: '{0} bonne réponse', en: '{0} correct answer', de: '{0} richtige Antwort',
      es: '{0} respuesta correcta', it: '{0} risposta corretta', nl: '{0} goed antwoord', pt: '{0} resposta certa'
    },
    'TvQuiz_Winner_Score_Many': {
      fr: '{0} bonnes réponses', en: '{0} correct answers', de: '{0} richtige Antworten',
      es: '{0} respuestas correctas', it: '{0} risposte corrette', nl: '{0} goede antwoorden', pt: '{0} respostas certas'
    },
    'TvQuiz_DefaultPlayer': {
      fr: 'Joueur', en: 'Player', de: 'Spieler',
      es: 'Jugador', it: 'Giocatore', nl: 'Speler', pt: 'Jogador'
    },

    // ─── Écran "En pause" (HTML statique) — Lot W5 ────────────────
    'TvPause_Title': {
      fr: 'En pause', en: 'Paused', de: 'Pausiert',
      es: 'En pausa', it: 'In pausa', nl: 'Gepauzeerd', pt: 'Em pausa'
    },
    'TvPause_Subtitle_Party': {
      fr: 'L\'animateur a mis la partie en pause',
      en: 'The host paused the party',
      de: 'Der Moderator hat die Partie pausiert',
      es: 'El anfitrión ha pausado la partida',
      it: 'L\'animatore ha messo in pausa la partita',
      nl: 'De gastheer heeft de partij gepauzeerd',
      pt: 'O anfitrião colocou a partida em pausa'
    },
    'TvPause_Subtitle_Session': {
      fr: 'L\'animateur a mis la session en pause',
      en: 'The host paused the session',
      de: 'Der Moderator hat die Sitzung pausiert',
      es: 'El anfitrión ha pausado la sesión',
      it: 'L\'animatore ha messo in pausa la sessione',
      nl: 'De gastheer heeft de sessie gepauzeerd',
      pt: 'O anfitrião colocou a sessão em pausa'
    },

    // ─── join.html — page de scan QR (Lot W5) ─────────────────────
    'Join_PageTitle': {
      fr: 'BeauOuPas — Rejoindre la session', en: 'BeauOuPas — Join the session',
      de: 'BeauOuPas — Der Sitzung beitreten', es: 'BeauOuPas — Unirse a la sesión',
      it: 'BeauOuPas — Partecipa alla sessione', nl: 'BeauOuPas — Deelnemen aan de sessie',
      pt: 'BeauOuPas — Entrar na sessão'
    },
    'Join_Sub': {
      fr: 'Rejoins la session 🎮', en: 'Join the session 🎮', de: 'Tritt der Sitzung bei 🎮',
      es: 'Únete a la sesión 🎮', it: 'Partecipa alla sessione 🎮', nl: 'Doe mee aan de sessie 🎮',
      pt: 'Entra na sessão 🎮'
    },
    'Join_NoCode_Title': {
      fr: 'Code manquant', en: 'Missing code', de: 'Code fehlt',
      es: 'Falta el código', it: 'Codice mancante', nl: 'Code ontbreekt', pt: 'Código em falta'
    },
    'Join_NoCode_Msg': {
      fr: 'Ce lien n\'a pas de code valide.<br>Scanne à nouveau le QR code affiché sur la TV.',
      en: 'This link has no valid code.<br>Scan the QR code on the TV again.',
      de: 'Dieser Link hat keinen gültigen Code.<br>Scanne den QR-Code auf dem TV erneut.',
      es: 'Este enlace no tiene un código válido.<br>Vuelve a escanear el código QR de la TV.',
      it: 'Questo link non ha un codice valido.<br>Scansiona di nuovo il QR code sulla TV.',
      nl: 'Deze link heeft geen geldige code.<br>Scan de QR-code op de tv opnieuw.',
      pt: 'Este link não tem um código válido.<br>Digitaliza novamente o código QR na TV.'
    },
    'Join_Opening_Title': {
      fr: 'Ouverture de l\'application...', en: 'Opening the app...',
      de: 'App wird geöffnet...', es: 'Abriendo la aplicación...',
      it: 'Apertura dell\'app...', nl: 'App wordt geopend...', pt: 'A abrir a aplicação...'
    },
    'Join_Opening_Msg': {
      fr: 'On t\'amène à la session', en: 'Taking you to the session',
      de: 'Wir bringen dich zur Sitzung', es: 'Te llevamos a la sesión',
      it: 'Ti portiamo alla sessione', nl: 'We brengen je naar de sessie',
      pt: 'A levar-te para a sessão'
    },
    'Join_Success_Title': {
      fr: 'Session', en: 'Session', de: 'Sitzung',
      es: 'Sesión', it: 'Sessione', nl: 'Sessie', pt: 'Sessão'
    },
    'Join_Success_Msg': {
      fr: 'Pour rejoindre, il te faut l\'application<br><strong>BeauOuPas</strong> sur ton téléphone.',
      en: 'To join, you need the<br><strong>BeauOuPas</strong> app on your phone.',
      de: 'Zum Beitreten brauchst du die<br><strong>BeauOuPas</strong>-App auf deinem Telefon.',
      es: 'Para unirte necesitas la app<br><strong>BeauOuPas</strong> en tu teléfono.',
      it: 'Per partecipare ti serve l\'app<br><strong>BeauOuPas</strong> sul telefono.',
      nl: 'Om mee te doen heb je de<br><strong>BeauOuPas</strong>-app op je telefoon nodig.',
      pt: 'Para entrar precisas da app<br><strong>BeauOuPas</strong> no teu telemóvel.'
    },
    'Join_Btn_HaveApp': {
      fr: '🚀 J\'ai l\'application', en: '🚀 I have the app', de: '🚀 Ich habe die App',
      es: '🚀 Tengo la aplicación', it: '🚀 Ho l\'app', nl: '🚀 Ik heb de app', pt: '🚀 Tenho a aplicação'
    },
    'Join_Btn_PlayStore': {
      fr: '📱 Télécharger sur Google Play', en: '📲 Download on Google Play',
      de: '📲 Bei Google Play herunterladen', es: '📲 Descargar en Google Play',
      it: '📲 Scarica su Google Play', nl: '📲 Downloaden in Google Play',
      pt: '📲 Transferir no Google Play'
    },
    'Join_Btn_Web': {
      fr: '🌐 Continuer sur le site', en: '🌐 Continue on the website',
      de: '🌐 Auf der Website fortfahren', es: '🌐 Continuar en el sitio',
      it: '🌐 Continua sul sito', nl: '🌐 Doorgaan op de site', pt: '🌐 Continuar no site'
    },
    'Join_Footer': {
      fr: 'Une fois l\'app installée, scanne à nouveau le QR code',
      en: 'Once the app is installed, scan the QR code again',
      de: 'Sobald die App installiert ist, scanne den QR-Code erneut',
      es: 'Una vez instalada la app, vuelve a escanear el código QR',
      it: 'Una volta installata l\'app, scansiona di nuovo il QR code',
      nl: 'Zodra de app is geïnstalleerd, scan de QR-code opnieuw',
      pt: 'Depois de instalar a app, digitaliza novamente o código QR'
    },

    // ─── Erreurs communes oubliées (rattrapage Lot W5) ────────────
    'TvCommon_Err_Generic': {
      fr: 'Erreur', en: 'Error', de: 'Fehler',
      es: 'Error', it: 'Errore', nl: 'Fout', pt: 'Erro'
    },
    'TvCommon_Err_LoadQuestion': {
      fr: 'Impossible de charger la question', en: 'Unable to load the question',
      de: 'Frage kann nicht geladen werden', es: 'No se puede cargar la pregunta',
      it: 'Impossibile caricare la domanda', nl: 'Kan de vraag niet laden', pt: 'Não foi possível carregar a pergunta'
    },
    'TvQuiz_Err_WrongPage_Title': {
      fr: 'Mauvaise page', en: 'Wrong page', de: 'Falsche Seite',
      es: 'Página incorrecta', it: 'Pagina sbagliata', nl: 'Verkeerde pagina', pt: 'Página errada'
    },
    'TvQuiz_Err_WrongPage_Msg': {
      fr: 'Cette série n\'est pas un quiz. Retournez à la page d\'accueil.',
      en: 'This series is not a quiz. Go back to the home page.',
      de: 'Diese Serie ist kein Quiz. Kehre zur Startseite zurück.',
      es: 'Esta serie no es un cuestionario. Vuelve a la página de inicio.',
      it: 'Questa serie non è un quiz. Torna alla pagina iniziale.',
      nl: 'Deze serie is geen quiz. Ga terug naar de startpagina.',
      pt: 'Esta série não é um quiz. Volta à página inicial.'
    },
    'TvParty_Winner_One': {
      fr: 'Vainqueur', en: 'Winner', de: 'Sieger',
      es: 'Ganador', it: 'Vincitore', nl: 'Winnaar', pt: 'Vencedor'
    },
    'TvParty_Winner_Many': {
      fr: 'Vainqueurs', en: 'Winners', de: 'Sieger',
      es: 'Ganadores', it: 'Vincitori', nl: 'Winnaars', pt: 'Vencedores'
    },
    'TvCommon_DefaultPlayer': {
      fr: 'Joueur', en: 'Player', de: 'Spieler',
      es: 'Jugador', it: 'Giocatore', nl: 'Speler', pt: 'Jogador'
    },
    'TvCommon_Err_AlertPrefix': {
      fr: 'Erreur : ', en: 'Error: ', de: 'Fehler: ',
      es: 'Error: ', it: 'Errore: ', nl: 'Fout: ', pt: 'Erro: '
    },
    'TvQuiz_Winner_Single': {
      fr: 'Vainqueur', en: 'Winner', de: 'Sieger',
      es: 'Ganador', it: 'Vincitore', nl: 'Winnaar', pt: 'Vencedor'
    },
    'TvQuiz_Stats_Players': {
      fr: 'Joueurs', en: 'Players', de: 'Spieler',
      es: 'Jugadores', it: 'Giocatori', nl: 'Spelers', pt: 'Jogadores'
    },
    'TvQuiz_Stats_Questions': {
      fr: 'Questions', en: 'Questions', de: 'Fragen',
      es: 'Preguntas', it: 'Domande', nl: 'Vragen', pt: 'Perguntas'
    },
    'TvQuiz_Intro_Question_One': {
      fr: 'question', en: 'question', de: 'Frage',
      es: 'pregunta', it: 'domanda', nl: 'vraag', pt: 'pergunta'
    },
    'TvQuiz_Intro_Question_Many': {
      fr: 'questions', en: 'questions', de: 'Fragen',
      es: 'preguntas', it: 'domande', nl: 'vragen', pt: 'perguntas'
    }
  };

  // ─── Détection de la langue ────────────────────────────────────────
  function detectLang() {
    // 1) Override manuel mémorisé
    try {
      var saved = window.sessionStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) { /* sessionStorage indispo : on ignore */ }

    // 2) Langue du navigateur de la TV
    var navLangs = [];
    if (navigator.languages && navigator.languages.length) {
      navLangs = navigator.languages.slice();
    } else if (navigator.language) {
      navLangs = [navigator.language];
    }
    for (var i = 0; i < navLangs.length; i++) {
      var two = String(navLangs[i]).toLowerCase().slice(0, 2);
      if (SUPPORTED.indexOf(two) !== -1) return two;
    }

    // 3) Fallback
    return DEFAULT_LANG;
  }

  var currentLang = detectLang();

  // ─── API publique ──────────────────────────────────────────────────
  function t(key) {
    var entry = STRINGS[key];
    if (!entry) return key;                 // fallback : clé brute
    if (entry[currentLang] != null) return entry[currentLang];
    if (entry[DEFAULT_LANG] != null) return entry[DEFAULT_LANG];
    return key;
  }

  function tf(key) {
    var s = t(key);
    var args = Array.prototype.slice.call(arguments, 1);
    return s.replace(/\{(\d+)\}/g, function (m, idx) {
      var n = parseInt(idx, 10);
      return (args[n] != null) ? String(args[n]) : m;
    });
  }

  function getLang() { return currentLang; }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1) return;
    currentLang = lang;
    try { window.sessionStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    // Recharge la page pour ré-appliquer partout proprement
    window.location.reload();
  }

  // Traduit tous les éléments [data-i18n] / [data-i18n-ph] d'un sous-arbre
  function applyDom(root) {
    root = root || document;
    var els = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-i18n'));
    }
    var phs = root.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phs.length; j++) {
      phs[j].setAttribute('placeholder', t(phs[j].getAttribute('data-i18n-ph')));
    }
    // <html lang="..">
    if (document.documentElement) {
      document.documentElement.setAttribute('lang', currentLang);
    }
  }

  // Permet aux lots W2..W5 d'enrichir la table sans toucher au socle
  function extend(moreStrings) {
    for (var k in moreStrings) {
      if (Object.prototype.hasOwnProperty.call(moreStrings, k)) {
        STRINGS[k] = moreStrings[k];
      }
    }
  }

  window.TVI18n = {
    t: t,
    tf: tf,
    getLang: getLang,
    setLang: setLang,
    applyDom: applyDom,
    extend: extend,
    SUPPORTED: SUPPORTED
  };

  // Applique automatiquement au DOM dès que possible
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyDom(); });
  } else {
    applyDom();
  }
})();
