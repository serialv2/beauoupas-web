// Génère la navbar selon la page active
function renderNav(activePage) {
  const pages = [
    { href: 'feed.html',     icon: '🏠', label: 'Feed' },
    { href: 'projects.html', icon: '📸', label: 'Projets' },
    { href: 'friends.html',  icon: '👥', label: 'Amis' },
    { href: 'chat.html',     icon: '💬', label: 'Chat' },
    { href: 'profile.html',  icon: '👤', label: 'Profil' },
  ]

  // Sidebar
  const sidebarNav = pages.map(p => `
    <a href="${p.href}" class="nav-item ${p.href === activePage ? 'active' : ''}">
      <span style="font-size:18px;">${p.icon}</span> ${p.label}
    </a>
  `).join('')

  // Bottom nav mobile
  const bottomNav = pages.map(p => `
    <a href="${p.href}" class="${p.href === activePage ? 'active' : ''}">
      <span class="nav-icon">${p.icon}</span>${p.label}
    </a>
  `).join('')

  document.getElementById('sidebar-nav').innerHTML = sidebarNav
  document.getElementById('bottom-nav').innerHTML = bottomNav
}

// Charger le profil dans la sidebar
async function loadSidebarProfile() {
  const user = await getUser()
  if (!user) return
  const profile = await getProfile(user.id)
  if (!profile) return

  const avatarHtml = profile.avatar_url
    ? `<img src="${profile.avatar_url}" alt="">`
    : `<span style="font-size:15px;font-weight:900;">${profile.username?.[0]?.toUpperCase() || '?'}</span>`

  document.getElementById('sidebar-user').innerHTML = `
    <div class="user-card">
      <div class="avatar" style="width:36px;height:36px;">${avatarHtml}</div>
      <div style="flex:1;overflow:hidden;">
        <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@${profile.username}</div>
        <div style="font-size:11px;color:#555;">💰 ${profile.credits} crédits</div>
      </div>
      <button onclick="handleSignOut()" style="background:none;border:none;color:#555;cursor:pointer;font-size:16px;padding:4px;" title="Déconnexion">↩</button>
    </div>
  `
}

async function handleSignOut() {
  if (!confirm('Se déconnecter ?')) return
  await db.auth.signOut()
  window.location.href = 'login.html'
}
