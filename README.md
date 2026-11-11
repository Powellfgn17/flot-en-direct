# Flot en direct

Simulation en direct de la méthode de Ford-Fulkerson. Chaque étudiant devient un sommet du réseau depuis son téléphone, le système crée les liens et attribue les capacités, puis tout le monde suit la circulation du flot jusqu'au flot maximal et à la coupe minimale.

## Lancer l'application

Il faut Node.js 20 ou plus.

```bash
npm install
npm start
```

Le terminal affiche le lien présentateur, qui contient la clé. Ouvre ensuite :

| Écran | Adresse | Rôle |
|---|---|---|
| Présentateur | `/presentateur?cle=…` | Commande la séance |
| Projecteur | `/projecteur` | QR code, puis réseau et explications, sans commandes |
| Étudiants | `/` (via le QR code) | Sommet, liens, débit reçu et envoyé |

Avec un seul écran dupliqué sur le projecteur, la vue présentateur suffit : elle affiche aussi le réseau.

Pour tester sans téléphones, ajoute des sommets simulés dans la vue présentateur.

## Déroulé en salle

1. Les étudiants scannent le QR code et entrent leur nom.
2. Clique sur « Créer le réseau ». Les personnes qui arrivent ensuite suivent en spectateurs.
3. Avance avec « Suivant » ou « Lecture ». Chaque itération montre d'abord le chemin et son goulot, puis l'augmentation du flot.
4. Passe au « Graphe résiduel » au moment où un arc inverse apparaît.
5. Au résultat, la coupe minimale passe en rouge et le débit maximal s'affiche à côté de sa capacité.
6. Clique sur un sommet pour simuler une panne, ou sur un lien pour modifier sa capacité ou le couper. Le flot est recalculé aussitôt.

Raccourcis de la vue présentateur : `→` et `←` pour avancer et reculer, `espace` pour la lecture, `r` pour le graphe résiduel, `Échap` pour fermer la sélection. Une télécommande de présentation fonctionne aussi.

## Connexion de la salle

**En ligne (recommandé).** Déploie le projet sur un hébergeur qui accepte les WebSockets, avec `npm install` pour la construction et `npm start` pour le démarrage. Définis la variable `PRESENTER_KEY`. Le QR code utilise alors automatiquement l'adresse publique du site, et les étudiants peuvent utiliser leurs données mobiles. Sur une offre gratuite, le service peut se mettre en veille : ouvre la page avant le début de la présentation.

**En réseau local (secours).** Lance `npm start` sur ton PC, connecté au même Wi-Fi que les téléphones. Le QR code utilise l'adresse locale du PC. Un partage de connexion limite souvent le nombre d'appareils et certains Wi-Fi bloquent les échanges entre appareils : teste avant la présentation. Si besoin, autorise le port 3000 dans le pare-feu.

Variables disponibles :

| Variable | Rôle | Par défaut |
|---|---|---|
| `PORT` | Port du serveur | `3000` |
| `PRESENTER_KEY` | Clé de la vue présentateur | Générée à chaque démarrage et affichée dans le terminal |
| `PUBLIC_URL` | Adresse encodée dans le QR code | Détectée automatiquement |

## Fonctionnement

- `src/core/maxflow.js` contient l'algorithme, écrit sans bibliothèque de graphes. Le DFS (Ford-Fulkerson) et le BFS (Edmonds-Karp) partagent le même parcours : seule la frontière change, une pile ou une file.
- `src/core/generator.js` crée les liens et les capacités. Il évalue 300 tirages et garde le plus instructif : arc inverse utilisé, coupe à l'intérieur du réseau, sommets traversés.
- `src/session.js` gère les participants, les pannes et les images du pas à pas.
- `src/app.js` est le serveur temps réel (Express et Socket.IO).
- `public/` contient les trois écrans.

Le serveur joue le rôle d'un contrôleur central. Il calcule la répartition du flot, que les écrans animent ensuite : aucun vrai paquet ne circule entre les téléphones.

## Limites

- 25 sommets au maximum, pour que le graphe reste lisible. Les étudiants suivants deviennent spectateurs, et les étudiants passent avant les sommets simulés.
- Une seule séance à la fois, conservée en mémoire : redémarrer le serveur l'efface.
- La source et le puits ne peuvent pas tomber en panne.
- À 4 sommets, un arc inverse utilisé et une coupe passant par un lien intérieur ne peuvent pas coexister : le générateur privilégie l'arc inverse.

## Tests

```bash
npm test
```

Les tests vérifient notamment l'algorithme sur 2 000 graphes aléatoires, en comparant le résultat à l'énumération de toutes les coupes, la conservation du flot à chaque image, puis une séance complète avec 20 clients, une reconnexion et une panne.

La police Overpass est incluse sous licence SIL Open Font License (`public/fonts/LICENSE-Overpass.txt`).
