// ═══════════════════════════════════════════════════════════════════
// BeauOuPas TV — Subscriptions Realtime
// ═══════════════════════════════════════════════════════════════════
//
// Gère les abonnements aux changements en temps réel via Supabase :
// - series : status, current_project_index, tv_paused, tv_active
// - series_projects : started_at (= démarrage d'un projet)
// - series_votes : INSERT (= compteur "67/100 ont voté")
// - series_selfies : INSERT (= big reveal final)
//
// L'objet exporté est window.TVRealtime.
// Tous les events sont remontés à window.TVApp.onRealtimeEvent().
//
// ═══════════════════════════════════════════════════════════════════

window.TVRealtime = (function() {

  var subscriptions = [];
  var supabaseClient = null;

  function start(seriesId) {
    if (!seriesId) {
      console.error('[TVRealtime] start() : seriesId manquant');
      return;
    }

    supabaseClient = window.supabase.createClient(
      window.TV_CONFIG.SUPABASE_URL,
      window.TV_CONFIG.SUPABASE_ANON_KEY
    );

    console.log('[TVRealtime] Démarrage des subscriptions pour series:', seriesId);

    var seriesSub = supabaseClient
      .channel('tv-series-' + seriesId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'series',
        filter: 'id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] series UPDATE');
        if (window.TVApp && window.TVApp.onRealtimeEvent) {
          window.TVApp.onRealtimeEvent('series', payload.new);
        }
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series channel:', status);
      });

    var projectsSub = supabaseClient
      .channel('tv-projects-' + seriesId)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'series_projects',
        filter: 'series_id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] series_projects UPDATE');
        if (window.TVApp && window.TVApp.onRealtimeEvent) {
          window.TVApp.onRealtimeEvent('series_project', payload.new);
        }
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series_projects channel:', status);
      });

    var votesSub = supabaseClient
      .channel('tv-votes-' + seriesId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'series_votes',
        filter: 'series_id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] vote INSERT');
        if (window.TVApp && window.TVApp.onRealtimeEvent) {
          window.TVApp.onRealtimeEvent('vote', payload.new);
        }
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series_votes channel:', status);
      });

    var selfiesSub = supabaseClient
      .channel('tv-selfies-' + seriesId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'series_selfies',
        filter: 'series_id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] selfie INSERT');
        if (window.TVApp && window.TVApp.onRealtimeEvent) {
          window.TVApp.onRealtimeEvent('selfie', payload.new);
        }
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series_selfies channel:', status);
      });

    // ⚡ Lot Mode TV : s'abonner aux nouveaux participants pour le compteur live
    var participantsSub = supabaseClient
      .channel('tv-participants-' + seriesId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'series_participants',
        filter: 'series_id=eq.' + seriesId
      }, function(payload) {
        console.log('[TVRealtime] participant INSERT');
        if (window.TVApp && window.TVApp.onRealtimeEvent) {
          window.TVApp.onRealtimeEvent('participant', payload.new);
        }
      })
      .subscribe(function(status) {
        console.log('[TVRealtime] series_participants channel:', status);
      });

    subscriptions = [seriesSub, projectsSub, votesSub, selfiesSub, participantsSub];
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
