function renderNav(activePage) {
  var pages = [
    { href: 'feed.html',     icon: '🏠', label: 'Feed' },
    { href: 'projects.html', icon: '📸', label: 'Projets' },
    { href: 'friends.html',  icon: '👥', label: 'Amis' },
    { href: 'chat.html',     icon: '💬', label: 'Chat' },
    { href: 'profile.html',  icon: '👤', label: 'Profil' },
  ];

  // Sidebar
  var sidebarHtml = pages.map(function(p) {
    var isActive = p.href === activePage;
    var style = isActive
      ? 'display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:14px;color:#E91E8C;background:rgba(233,30,140,0.1);text-decoration:none;font-weight:800;font-size:15px;margin-bottom:4px;'
      : 'display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:14px;color:#888;background:transparent;text-decoration:none;font-weight:400;font-size:15px;margin-bottom:4px;';
    // Si déjà sur la page → pas de rechargement
    var href = isActive ? 'javascript:void(0)' : p.href;
    return '<a href="' + href + '" style="' + style + '"><span style="font-size:18px;">' + p.icon + '</span>' + p.label + '</a>';
  }).join('');

  // Bottom nav mobile
  var bottomHtml = pages.map(function(p) {
    var isActive = p.href === activePage;
    var style = 'flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 0;color:' + (isActive ? '#E91E8C' : '#555') + ';text-decoration:none;font-size:10px;font-weight:' + (isActive ? '800' : '400') + ';';
    var href = isActive ? 'javascript:void(0)' : p.href;
    return '<a href="' + href + '" style="' + style + '"><span style="font-size:22px;">' + p.icon + '</span>' + p.label + '</a>';
  }).join('');

  var sidebarEl = document.getElementById('sidebar-nav');
  var bottomEl = document.getElementById('bottom-nav');
  if (sidebarEl) sidebarEl.innerHTML = sidebarHtml;
  if (bottomEl) bottomEl.innerHTML = bottomHtml;
}

async function loadSidebarProfile() {
  var user = await getUser();
  if (!user) return;
  var profile = await getProfile(user.id);
  if (!profile) return;

  var avatarHtml = profile.avatar_url
    ? '<img src="' + profile.avatar_url + '" alt="">'
    : '<span style="font-size:15px;font-weight:900;">' + (profile.username ? profile.username[0].toUpperCase() : '?') + '</span>';

  var el = document.getElementById('sidebar-user');
  if (!el) return;

  el.innerHTML =
    '<div class="user-card">' +
      '<div class="avatar" style="width:36px;height:36px;">' + avatarHtml + '</div>' +
      '<div style="flex:1;overflow:hidden;">' +
        '<div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@' + profile.username + '</div>' +
        '<div style="font-size:11px;color:#555;">💰 ' + (profile.credits || 0) + ' crédits</div>' +
      '</div>' +
      '<button onclick="handleSignOut()" style="background:none;border:none;color:#555;cursor:pointer;font-size:16px;padding:4px;" title="Déconnexion">↩</button>' +
    '</div>';
}

async function handleSignOut() {
  if (!confirm('Se déconnecter ?')) return;
  await db.auth.signOut();
  window.location.href = 'login.html';
}
