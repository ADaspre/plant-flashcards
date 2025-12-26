# 🌿 Plant Flashcards

Application web de **flashcards botaniques** permettant d’apprendre et de réviser des noms de plantes à partir d’images, avec une logique de répétition intelligente et une progression persistante par utilisateur.

Le projet est **100 % statique côté frontend**, hébergé sur **GitHub Pages**, et s’appuie sur **Supabase** pour l’authentification, la base de données et le stockage des images.

---

## ✨ Fonctionnalités

- Connexion utilisateur via **Supabase Auth (Magic Link Email)**
- Flashcards avec **3 à 4 images par plante**
- Validation par saisie du nom (Entrée ou bouton)
- États de progression :
  - `notAsked`
  - `inList`
  - `wrong`
  - `right`
- Apprentissage par **paquets de 20 plantes**
- Les plantes `wrong` et `skip` sont automatiquement réintroduites
- **Zoom d’image** au clic
- Sauvegarde automatique de la session (reprise exacte après fermeture)
- Support de **noms identiques dans des catégories différentes**
- Hébergement gratuit (GitHub Pages + Supabase)

---

## 🧱 Stack technique

### Frontend
- React
- Vite
- CSS natif

### Backend (BaaS)
- Supabase
  - Auth (Email OTP)
  - PostgreSQL (RLS activé)
  - Storage (bucket public pour images)

### Déploiement
- GitHub Pages
- GitHub Actions

---

## 🚀 Déploiement

L’application est automatiquement buildée et déployée via **GitHub Actions** à chaque push sur la branche `main`.

URL :
```
https://adaspre.github.io/plant-flashcards/
```

---

## 🔐 Sécurité

- Aucune clé secrète dans le frontend
- Utilisation exclusive de la **clé anon publique Supabase**
- RLS activé sur toutes les tables sensibles
- Données utilisateur strictement isolées par `auth.uid()`

---

## 📂 Structure du projet

```
plant-flashcards/
├── frontend/          # Application React
├── .github/           # GitHub Actions (CI/CD)
├── .gitignore
└── README.md
```

> Les dossiers `backend/`, `migrate/` et `plant_db_assets/` sont volontairement exclus du dépôt.

---

## 🛠️ Développement local

```bash
cd frontend
npm install
npm run dev
```

Créer un fichier `.env.local` dans `frontend/` :

```env
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=public-anon-key
```

---

## 📌 Notes

- Les images sont servies depuis un bucket Supabase **public**
- Le projet ne nécessite **aucun serveur dédié**
- Coût d’hébergement : **0 €**

---

## 📄 Licence

Projet personnel / éducatif.
