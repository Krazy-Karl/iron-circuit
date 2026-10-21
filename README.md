# Iron Circuit

Course de combat en 3D façon *Death Race*, jouable directement dans le navigateur :
voitures blindées, tourelle à la souris, roquettes, pièges (huile, mines, fumée) et
plaques au sol. Deux modes :

- **Course** : 3 tours d'un circuit de pénitencier de nuit, le premier sous le drapeau gagne.
- **Arène** : 3 minutes de match à mort chacun pour soi dans une grande cour à reliefs
  (deux plateformes d'angle aux grilles brûlantes, bunkers à tunnels en L, colline
  centrale avec un bouclier, dos-d'âne, tremplins, tonneaux explosifs). Le premier à 10 destructions gagne, sinon
  le meilleur score à la fin du temps.

- **Solo** contre 5 pilotes IA, ou seul pour s'entraîner : ouvre `solo/iron-circuit.html` dans un navigateur
  (connexion Internet nécessaire pour charger le moteur 3D).
- **Réseau local (LAN)** jusqu'à 6 pilotes + IA : un PC lance le serveur Node.js,
  les autres jouent dans leur navigateur. Le guide complet est ci-dessous.

Technique : [three.js](https://threejs.org) r128 pour la 3D, un serveur Node.js sans
dépendance (HTTP + WebSocket écrits à la main), une simulation partagée entre serveur
et navigateur (`public/sim.js`) avec prédiction côté client.

## Développement

| Fichier | Rôle |
|---|---|
| `public/sim.js` | Simulation de la course (physique, IA, armes) : tourne sur le serveur, et dans le navigateur pour le solo et la prédiction |
| `public/index.html` | Le jeu : rendu 3D, sons, interface, salon, réseau |
| `server.js` | Serveur LAN : fichiers du jeu, WebSocket, boucle de simulation à 60 Hz |
| `tools/build-solo.py` | Regénère `solo/iron-circuit.html` (version solo en un fichier) après une modification |

Après avoir modifié `public/index.html` ou `public/sim.js`, lance `python3 tools/build-solo.py`
pour mettre à jour la version solo.

---

Course de combat en 3D jouable à plusieurs sur le même réseau (Wi-Fi ou câble).
Un PC fait tourner le serveur, et tout le monde joue dans son navigateur, y compris
la personne sur le PC hôte.

Jusqu'à **6 pilotes** par course. Les places libres sont prises par l'IA. Les joueurs
en plus regardent la course et rejoignent la suivante.

---

## 1. Préparer le PC hôte (une seule fois)

1. Installe **Node.js** en version **LTS** depuis https://nodejs.org (installation par défaut).
   Pas le droit d'installer de logiciel (PC du travail) ? Prends la version **ZIP portable**
   (« Windows Binary (.zip) ») : décompresse-la, puis lance `node.exe server.js` depuis le dossier
   du jeu, ou ajoute le dossier de Node au `PATH`.
2. Télécharge le projet depuis GitHub (bouton vert **Code**, puis **Download ZIP**) et décompresse-le où tu veux sur ce PC (le Bureau convient très bien).

Le jeu ne demande rien d'autre : aucun `npm install`, aucun compte, aucune connexion Internet.

## 2. Lancer le serveur

| Système | Ce qu'il faut faire |
|---|---|
| Windows | Double-clique sur `lancer-serveur-windows.bat` |
| macOS | Double-clique sur `lancer-serveur-mac.command`. La première fois : clic droit, **Ouvrir**, puis confirme. |
| Linux | `./lancer-serveur-linux.sh` dans un terminal |

Sinon, dans un terminal ouvert dans le dossier : `node server.js`

Une fenêtre s'ouvre et affiche par exemple :

```
  Sur ce PC        : http://localhost:3000
  Pour les autres  : http://192.168.1.23:3000
```

**Laisse cette fenêtre ouverte** pendant toute la partie. Pour arrêter le serveur,
ferme-la ou appuie sur `Ctrl+C`.

**Windows** : au premier lancement, le pare-feu demande d'autoriser Node.js.
Coche **Réseaux privés** et clique sur **Autoriser**. Sans ça, les autres PC ne
pourront pas se connecter.

## 3. Rejoindre la partie

- **Sur le PC hôte** : ouvre `http://localhost:3000` dans Chrome, Edge ou Firefox.
- **Sur les autres PC** : ouvre l'adresse « Pour les autres » affichée par le serveur.
  Elle est aussi écrite dans le salon du jeu.

Chacun entre son nom de pilote puis clique sur **Rejoindre**.

**Conseil** : le PC qui fait tourner le serveur n'a pas besoin de jouer. Sur un portable,
jouer et héberger en même temps peut le ralentir. Deux possibilités :
- ne pas ouvrir le jeu sur ce PC du tout (le serveur tourne seul, il consomme très peu) ;
- ou l'ouvrir et cocher **« Je regarde seulement »** dans le salon : il peut alors lancer
  les courses et suivre la partie en spectateur, en changeant de voiture avec ← →.

Le **premier joueur arrivé est l'hôte**. Dans le salon, il règle :
- le **mode de jeu** (Course ou Arène), et **qui le choisit** : lui seul, ou **un vote**
  de tout le salon (chacun clique sur le mode qu'il veut ; en cas d'égalité, le vote de
  l'hôte l'emporte) ;
- les **pilotes IA** : compléter la grille jusqu'à 6 voitures, ou **aucun** (uniquement
  les joueurs humains) ;
- le **niveau des IA**.

Il lance ensuite la partie. À la fin, il ramène tout le monde au salon avec **Retour au salon**.
Le décor du mode choisi s'affiche en fond du salon.

## 4. Pendant la course

- Clique une fois dans le jeu pour que la souris contrôle la caméra et la tourelle.
  **Échap** libère la souris. Il n'y a pas de pause en multijoueur : la course continue.
- Une voiture détruite repart après 2,5 secondes, invincible pendant 2 secondes.
- Personne ne peut tirer pendant les 5 premières secondes.
- La course se termine quand tous les joueurs ont passé la ligne. Quand le premier
  joueur arrive, les autres ont **45 secondes** pour finir, sinon ils sont « non classés ».
- Si un joueur quitte la partie, l'IA prend le volant de sa voiture.

**En mode Arène**
- Match de **3 minutes**, chacun pour soi. Le premier à **10 destructions** gagne ; sinon,
  le meilleur score à la fin du temps (à égalité, celui qui a été le moins détruit).
- Les armes sont actives **dès le départ** (en course, elles ne s'activent qu'après 5 s).
  Les voitures détruites réapparaissent au point de départ le plus éloigné des adversaires.
- Le terrain a du relief :
  - deux **plateformes** dans des coins opposés, chacune avec **deux rampes** sur deux côtés
    différents (des roquettes t'y attendent). Leurs **grilles brûlent** : toutes les 20 s,
    elles clignotent en orange pendant 2 s, puis brûlent 3 s. Impossible d'y camper ;
  - au pied des plateformes, le tireur du haut **ne peut pas te toucher** (sa tourelle ne
    descend que de 10°) : les blocs bas qui s'y trouvent servent d'approche à couvert ;
  - une **colline centrale** accessible par les quatre côtés, avec le **bouclier** au sommet,
    à découvert ;
  - deux **bunkers** traversés par un **tunnel en L** : on entre d'un côté et on ressort
    d'un autre après un virage, sans longue ligne de tir. Une plaque de **réparation**
    attend au coude de chaque tunnel ;
  - un **tunnel court** (20 m) passe aussi sous chaque plateforme, à côté de sa rampe ;
  - des **dos-d'âne** qui font décoller si on les prend vite, et deux **tremplins** jaunes.
- **Bouclier** (plaque bleue) : +50 points qui encaissent les dégâts avant le blindage,
  pendant 15 s au maximum. Une bulle bleue entoure la voiture et clignote pendant les
  3 dernières secondes ; le HUD affiche les points et les secondes restantes
  (« 75 +50 · 9 s ») avec une fine ligne qui se vide sous la barre de blindage.
  Il réapparaît 25 s après avoir été pris.
- Les chocs contre les obstacles font moins de dégâts qu'en course.
- La tourelle vise aussi en hauteur (±10°) : utile pour tirer depuis le pont ou vers lui.
- Les **tonneaux rouges** explosent quand on leur tire dessus (et les explosions se
  propagent). Ils réapparaissent 20 secondes plus tard.

### Commandes

| Touche | Action |
|---|---|
| `Z Q S D` ou flèches | Conduire |
| Souris | Viser : la tourelle suit (±75° de côté, ±10° en hauteur) |
| Clic gauche | Mitrailleuse (surchauffe si tu tires trop longtemps) |
| Clic droit | Roquette, tir droit devant |
| `Espace` | Dérapage |
| `Maj` | Turbo |
| `E` | Arme arrière : huile, mines ou fumée |
| `C` | Recentrer la caméra derrière la voiture |
| `M` | Couper ou remettre le son |
| `Échap` | Menu : réglages de sensibilité et de suivi caméra |
| `F3` | Mesures de performance (images/s, ping, charge du serveur) avec un diagnostic |

Plaques au sol : **rouge** +2 roquettes · **ambre** arme arrière · **verte** +35 de blindage.

---

## En cas de problème

**Les autres PC n'arrivent pas à se connecter**
- Vérifie que tout le monde est sur **le même réseau** (même box, même Wi-Fi).
  Un réseau « invité » isole souvent les appareils entre eux.
- Vérifie que le pare-feu autorise Node.js. Sous Windows : Paramètres, Confidentialité
  et sécurité, Sécurité Windows, Pare-feu, « Autoriser une application via le pare-feu »,
  puis coche **Node.js** sur **Privé**.
- Sous Windows, le réseau doit être en profil **Privé**, pas **Public**.
- Essaie depuis le PC hôte l'adresse « Pour les autres » : si elle ne marche pas non
  plus, ce n'est pas un problème de réseau mais de serveur.

**« Le port 3000 est déjà utilisé »**
Lance le serveur sur un autre port : `node server.js 3001`, puis utilise `:3001` dans les adresses.

**Plusieurs adresses s'affichent**
Le PC a plusieurs cartes réseau (Wi-Fi, câble, machine virtuelle…). Utilise celle qui
commence comme les adresses de ta box, en général `192.168.`.

**Les polices ne sont pas les bonnes**
Les polices viennent de Google Fonts. Sans Internet, le jeu utilise des polices de
secours et reste parfaitement jouable.

**Le clic gauche ne répond pas par moments**
- Sur un **pavé tactile** de portable, Windows ignore les clics pendant qu'une touche est
  enfoncée (protection contre les clics involontaires en tapant). Comme on tient `Z` pour
  rouler, les tirs sont perdus. Branche une **souris**, ou dans Windows : Paramètres,
  Bluetooth et appareils, Pavé tactile, Sensibilité du pavé tactile : **La plus sensible**.
- Appuie sur **F3** : la partie « Commandes » montre si le clic arrive au jeu et ce qui
  bloque le tir (surchauffe, début de course, voiture détruite…).

**Le jeu est bloqué à 30 images/s**
Si F3 affiche environ 30 images/s très régulières, c'est le navigateur ou Windows qui
économise la batterie : branche le chargeur, désactive le **mode efficacité** d'Edge
(Paramètres, Système et performances) et l'**économiseur de batterie** de Windows.

**Le jeu rame ou saccade**
- Appuie sur **F3** pendant la course : le panneau indique si le problème vient de
  l'affichage, du réseau ou du PC hôte, et quoi faire.
- La **Qualité graphique** est sur **Auto** par défaut : la résolution baisse toute seule si
  les images/s chutent. Si ça ne suffit pas, passe-la sur **Basse** (menu Échap) et recharge la page.
- Sur le PC qui héberge, coche « Je regarde seulement » ou n'ouvre pas le jeu.
- Utilise Chrome ou Edge, ferme les autres onglets et vérifie que l'accélération
  matérielle du navigateur est activée.
- Si possible, branche le PC hôte en **câble** plutôt qu'en Wi-Fi.

---

## Contenu du dossier

```
iron-circuit/
├── server.js                    serveur : fichiers du jeu, connexions, simulation de la course
├── lancer-serveur-windows.bat   lanceur Windows
├── lancer-serveur-mac.command   lanceur macOS
├── lancer-serveur-linux.sh      lanceur Linux
├── README.md                    ce guide
├── package.json                 « npm start » lance le serveur
├── tools/build-solo.py          regénère la version solo
├── solo/iron-circuit.html       version solo en un seul fichier
└── public/
    ├── index.html               le jeu (affichage, sons, salon)
    ├── sim.js                   la simulation de course, partagée avec le serveur
    └── three.min.js             moteur 3D (three.js r128, licence MIT)
```

Le serveur calcule toute la course 60 fois par seconde : physique, IA, tirs, dégâts.
Chaque navigateur calcule aussi sa propre voiture à l'avance pour que la conduite réponde
instantanément, puis se recale sur le serveur. Les autres voitures sont affichées avec
environ 50 ms de retard, pour rester fluides même si le Wi-Fi est irrégulier.
