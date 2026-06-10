# Sequence Mail

Outil de séquences email (cold outreach) multi-comptes Google Workspace : campagnes indépendantes, import CSV / Attio, détection automatique des réponses, répartition de charge entre comptes et protection de la délivrabilité.

## Démarrage

```bash
npm install
cp .env.example .env   # puis renseigner GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm start              # ouvre http://localhost:3000
```

### Configuration Google (obligatoire)

1. Sur [console.cloud.google.com](https://console.cloud.google.com), créer un projet et activer l'**API Gmail**.
2. Créer des identifiants **OAuth client ID** de type *Web application*, avec l'URI de redirection `http://localhost:3000/auth/google/callback`.
3. Copier le client ID / secret dans `.env`.
4. Sur le tableau de bord, cliquer **« + Connecter un compte Google »** pour chaque adresse Google Workspace à utiliser pour les envois.

### Configuration Attio (bonus, optionnel)

Renseigner `ATTIO_API_KEY` dans `.env`, puis utiliser le formulaire « Synchroniser depuis Attio » du tableau de bord en indiquant le slug de l'attribut statut (ex. `stage`) et les valeurs à importer.

**Mise à jour retour vers Attio** : en renseignant `ATTIO_STAGE_ATTRIBUTE` (slug d'un attribut *texte* sur l'objet « people »), l'avancement de chaque contact est écrit automatiquement sur sa fiche Attio : « Étape 2/3 envoyée », « A répondu ✅ », « Séquence terminée », « Échec d'envoi ⚠️ ». La base SQLite reste la source de vérité (transactions, aucune perte en cas d'incident) ; Attio est un miroir temps réel.

## Fonctionnement

### Campagnes et séquences
- Chaque campagne est indépendante et contient une séquence d'étapes (email initial + relances avec délai en jours).
- Les corps et sujets acceptent des variables : `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}` et toute colonne supplémentaire du CSV.
- Une relance **sans sujet** part dans le même fil Gmail (`Re:`, en-têtes `In-Reply-To`/`References`), ce qui améliore la délivrabilité et le taux de réponse.

### Import des contacts
- **CSV** : colonnes `email` (obligatoire), `first_name`, `last_name`, `company` ; toute autre colonne devient une variable de template. Les doublons (même email déjà inscrit à la campagne) sont ignorés.
- **Attio** : import des personnes dont un attribut de statut CRM correspond aux valeurs choisies.

### Gestion des réponses
- Le système interroge les boîtes connectées toutes les ~4–7 minutes.
- Dès qu'un contact répond (n'importe quel message du fil qui ne vient pas du compte émetteur), il passe au statut `replied` et est **retiré du workflow** : plus aucune relance ne lui sera envoyée, même après l'envoi de la dernière étape.

### Répartition entre comptes
- Le premier email d'un contact part du compte **le moins chargé** du jour (équilibrage automatique).
- Les relances partent toujours **du même compte** que le premier email (continuité du fil).
- Quota quotidien par compte configurable depuis le tableau de bord (défaut : `DEFAULT_DAILY_LIMIT`).
- Chaque compte a son **nom d'expéditeur** (champ « De ») et sa **signature**, configurables dans le tableau de bord. La signature est ajoutée à la fin de chaque email du compte et accepte les variables. Le template peut aussi utiliser `{{sender_name}}` pour mentionner l'expéditeur dans le corps.

### Délivrabilité
- Fenêtre d'envoi configurable (`SEND_WINDOW_START`/`END`, heures locales), envois en semaine uniquement par défaut.
- Délai aléatoire de 90 à 420 s entre deux envois d'un même compte (`MIN_GAP_SECONDS`/`MAX_GAP_SECONDS`).
- Jitter de 0 à 4 h sur la planification des relances : aucun envoi à heure fixe.
- Emails en texte brut, envoyés via l'API Gmail (réputation du domaine préservée, pas de SMTP tiers).
- Petit volume par tick (max 5 envois) avec pauses aléatoires entre chaque.

### Fiabilité
- Toutes les données (comptes, campagnes, contacts, statuts, historique des envois) sont stockées dans **SQLite** (`data/sequence-mail.db`, mode WAL).
- Au redémarrage, le scheduler reprend exactement où il s'était arrêté : rien n'est perdu, aucun email n'est renvoyé en double (l'état est mis à jour transactionnellement après chaque envoi).
- En cas d'échec d'envoi, 3 tentatives espacées de 1–2 h, puis le contact passe en `failed` avec le message d'erreur visible via l'API.

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/auth/google` | Connecter un compte Google |
| GET | `/api/accounts` | Liste des comptes d'envoi |
| PATCH | `/api/accounts/:id` | Modifier quota / actif |
| GET | `/api/campaigns` | Campagnes + statistiques (taux de réponse, progression, volume) |
| POST | `/api/campaigns` | Créer une campagne `{ name, steps: [{subject, body, wait_days}] }` |
| POST | `/api/campaigns/:id/pause` · `/resume` | Mettre en pause / reprendre |
| POST | `/api/campaigns/:id/import` | Importer un CSV (body brut, `Content-Type: text/csv`) |
| POST | `/api/campaigns/:id/attio-sync` | `{ status_attribute, statuses[] }` |
| GET | `/api/campaigns/:id/contacts` | Détail par contact (statut, étape, émetteur, erreurs) |
