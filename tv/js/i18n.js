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
