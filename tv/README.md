# BeauOuPas TV — Mode TV (Phase A : Web)

Mode "TV" pour transformer une grande série de vote en expérience
événementielle (mariages, soirées d'entreprise, anniversaires, etc.).

La TV affiche les photos en grand sur un écran (PC, Chromecast,
Smart TV) tandis que les participants votent depuis leur téléphone via
l'app BeauOuPas en utilisant un code à 6 caractères.

---

## 📋 Prérequis

✅ **Patch SQL v5 appliqué** sur ta base Supabase. Si pas encore fait,
applique-le **avant** de tester la TV (sinon les fonctions `tv_*`
n'existent pas et la TV plantera).

✅ **Realtime activé** sur les tables `series`, `series_projects`,
`series_votes`, `series_selfies` (le patch v5 le fait automatiquement).

✅ **GitHub Pages activé** sur le repo `beauoupas-web`.

---

## 📂 Structure des fichiers

```
beauoupas-web/                     ← ton repo
├── (tes fichiers existants : login.html, feed.html, etc.)
└── tv/                            ← NOUVEAU : ce dossier
    ├── tv.html                    ← page d'accueil TV (saisie du code)
    ├── tv-display.html            ← écran TV plein écran (4 écrans dynamiques)
    ├── README.md                  ← ce fichier
    ├── css/
    │   └── tv.css
    └── js/
        ├── tv-config.js           ← URL + clé Supabase
        ├── tv-app.js              ← logique principale + machine à états
        └── tv-realtime.js         ← subscriptions Supabase Realtime
```

---

## 🧪 Tester en local (avant de pousser)

1. **Décompresse le zip** dans un dossier temporaire
2. **Ouvre `tv.html` directement avec Chrome** (double-clic)
3. Tu vois la page de saisie du code
4. Tape un code à 6 caractères

⚠️ **Limite** : si tu testes via `file://`, certaines fonctionnalités
peuvent ne pas marcher (CORS). Mais pour la saisie, ça suffit.

Pour un test complet, il vaut mieux pousser sur GitHub directement (voir
section suivante).

---

## 🚀 Tester en ligne (GitHub Pages)

1. **Pousse les fichiers** sur ton repo `beauoupas-web` :
   - Crée un dossier `tv/` à la racine
   - Mets-y tous les fichiers du zip
   - Commit + push

2. **Attends 30-60 secondes** que GitHub Pages déploie

3. **Ouvre l'URL** :
   ```
   https://serialv2.github.io/beauoupas-web/tv/tv.html
   ```

4. Tu vois la page de saisie du code.

---

## 🎬 Workflow complet de test

Pour tester le mode TV de bout en bout, il faut :

1. **Créer une série** dans l'app BeauOuPas (depuis ton téléphone ou
   l'app Maui). Tu obtiendras un code à 6 caractères.

2. **Activer le mode TV** sur la série depuis l'app *(à venir dans le
   prochain lot, étape "Phone — Mode télécommande")*. En attendant, tu
   peux activer manuellement via SQL :
   ```sql
   UPDATE series
   SET tv_active = TRUE,
       tv_paused = FALSE,
       animator_votes = TRUE
   WHERE access_code = 'XXXXXX';
   ```

3. **Ouvrir la page TV** : `https://serialv2.github.io/beauoupas-web/tv/tv.html`
   - Taper le code → la page bascule sur `tv-display.html?code=XXXXXX`
   - Tu vois la salle d'attente (écran 1)

4. **Démarrer la série** depuis l'app (ou via SQL) :
   ```sql
   SELECT tv_start_series(
     (SELECT id FROM series WHERE access_code = 'XXXXXX')
   );
   ```
   - La TV bascule automatiquement sur l'écran de vote

5. **Faire voter quelques participants** depuis leur téléphone
   - Le compteur "X / Y ont voté" se met à jour en live sur la TV
   - Quand le timer arrive à 0, l'écran de transition apparaît

6. **Avancer au projet suivant** :
   ```sql
   SELECT tv_advance_to_next(
     (SELECT id FROM series WHERE access_code = 'XXXXXX')
   );
   ```
   - La TV bascule sur le projet suivant

7. **Quand tous les projets sont passés**, la série passe en `finished`
   et la TV bascule sur l'écran de big reveal (slideshow + selfies)

---

## 🎨 Les 4 écrans

### 1. Salle d'attente (lobby)
Affichée tant que `series.status = 'preparing'`.
- Titre de la série
- QR code (placeholder pour l'instant)
- Code d'accès en grand (rose #E91E8C)
- Compteur de participants connectés (mis à jour en live)

### 2. Vote en cours
Affichée tant que `series.status = 'active'` et que le timer n'est pas
arrivé à 0.
- Numéro du projet (3 / 8)
- Countdown synchronisé via `series_projects.started_at`
- Titre + description (tailles adaptatives)
- Photos en grand (single, duel, ou poll)
- Compteur "X / Y ont voté" + barre de progression

### 3. Transition (2,5s)
Affichée quand le timer arrive à 0, avant que le projet suivant ne
démarre.
- ✅ Animation séquencée
- "Vote terminé" → "Projet suivant..."

### 4. Big reveal
Affichée quand `series.status = 'finished'`.
- Slideshow auto : chaque projet pendant 3 secondes (titre + photo +
  votes)
- Puis le grand gagnant pendant 6 secondes (à enrichir avec stats
  segmentées homme/femme/âge dans le prochain lot)
- Wall of selfies (mosaïque adaptative selon le nombre)

### Pause (overlay)
Si l'animateur clique "Pause", un overlay translucide apparaît
par-dessus l'écran courant. Quand il reprend, l'overlay disparaît.

---

## 🔧 Configuration Supabase

Les clés sont dans `js/tv-config.js`. La clé `anon` est publique et
exposée — c'est OK car protégée par les RLS du patch v5.

Si tu changes de projet Supabase, modifie :
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

---

## 🐛 Si quelque chose ne marche pas

**"Code introuvable" sur la page d'accueil** :
- Vérifie que le code existe dans la base : `SELECT * FROM series WHERE access_code = 'XXXXXX';`
- Vérifie que `tv_active = TRUE`

**"Mode TV non actif"** :
- Lance : `UPDATE series SET tv_active = TRUE WHERE access_code = 'XXXXXX';`

**Le compteur de votes ne se met pas à jour en live** :
- Ouvre la console navigateur (F12) et regarde les logs `[TVRealtime]`
- Vérifie que les 4 tables sont bien dans la publication `supabase_realtime` :
  ```sql
  SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
  ```

**La page reste sur "Chargement"** :
- Console F12 → onglet Console → regarde l'erreur
- Vérifie ta clé Supabase dans `tv-config.js`

---

## 🚧 À venir (lots suivants)

- **Lot Phone — Mode télécommande** : adapter l'app Maui pour cacher
  les photos quand `tv_active = TRUE`, afficher juste les boutons +
  countdown synchronisé. Bouton "Activer mode TV" + "Pause" pour
  l'animateur. Selfie au 1er vote uniquement.
- **Lot Stats segmentées** : enrichir le big reveal avec les stats
  hommes/femmes + tranches d'âge par projet.
- **Lot Android TV natif** : version native Android TV (Maui multi-target
  ou nouveau projet Kotlin).
- **Lot Thèmes** : permettre au créateur de choisir un thème (couleurs)
  à la création de la série.
