// ─── Supabase client ─────────────────────────────────────────────
const { createClient } = supabase

const SUPABASE_URL = 'https://iybjtvwdnqnebuexesiz.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5Ymp0dndkbnFuZWJ1ZXhlc2l6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMDEwNjgsImV4cCI6MjA5MTU3NzA2OH0.dAImywya67QbKj1dCR3GZg4p24jxPPvQi5wGkJvdNLk'

const db = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Auth helpers ─────────────────────────────────────────────────
async function getUser() {
  const { data: { user } } = await db.auth.getUser()
  return user
}

async function getProfile(userId) {
  const { data } = await db.from('profiles').select('*').eq('id', userId).single()
  return data
}

async function requireAuth() {
  const user = await getUser()
  if (!user) { window.location.href = 'login.html'; return null }
  return user
}

function showError(id, msg) {
  const el = document.getElementById(id)
  if (el) { el.textContent = msg; el.style.display = 'block' }
}

function showSuccess(id, msg) {
  const el = document.getElementById(id)
  if (el) { el.textContent = msg; el.style.display = 'block'; el.style.background = 'rgba(76,175,80,0.15)'; el.style.borderColor = 'rgba(76,175,80,0.4)'; el.style.color = '#4CAF50' }
}

function setLoading(btnId, loading, text) {
  const btn = document.getElementById(btnId)
  if (btn) { btn.disabled = loading; btn.textContent = loading ? '⏳ Chargement...' : text }
}
