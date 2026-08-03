# Passerelle OCPP pour borne de recharge

Ceci est la documentation utilisateur de l'intégration. Gladys ré-héberge ce
fichier et affiche un lien **Documentation** permanent vers lui dans l'écran
de configuration (dans la langue de l'utilisateur, avec l'anglais en repli) —
c'est au moment de configurer que l'utilisateur en a le plus besoin.

## Portée de cette version

**Supervision en lecture seule, rien d'autre.** Cette intégration observe un
nombre quelconque de bornes de recharge OCPP 1.6 et affiche leur état dans
Gladys (statut, branchée, en charge, puissance, courant, tension, énergie
totale) — il n'est pas encore possible de démarrer, arrêter ou limiter une
charge depuis Gladys.

## Fonctionnement

L'intégration embarque son propre relais OCPP dans un sous-conteneur,
démarré automatiquement à l'installation. Chaque borne se connecte à la
**même** URL — le relais les distingue grâce à l'identity que chacune
annonce à la connexion. Une borne n'a pas besoin d'être configurée pour se
connecter : le relais supervise localement **toute** borne qui se connecte,
tout de suite (elle lui répond normalement, il observe son statut réel), et
ne transmet son trafic vers **son propre** cloud d'origine configuré
qu'une fois que vous lui en avez associé un (voir Installation ci-dessous)
— si bien que chaque borne continue de fonctionner exactement comme avant,
rien n'est changé ni remplacé côté service d'aucun fabricant. Le relais se
contente d'_observer_ ce qui transite pour construire l'état affiché dans
Gladys ; il n'invente ni ne retient jamais rien sur le fil, dans aucun des
deux modes.

## Prérequis

L'application ou le portail de chaque borne doit permettre de consulter et
de modifier l'URL du serveur OCPP auquel elle se connecte. Tous les
fabricants ne proposent pas cette option — si le vôtre ne le fait pas, cette
intégration ne peut pas être utilisée pour cette borne.

**Avant de changer quoi que ce soit, notez l'URL du serveur OCPP actuellement
affichée par l'application du fabricant.** C'est le seul moyen de revenir au
cloud d'origine pour cette borne si vous souhaitez un jour arrêter d'utiliser
cette intégration.

## Installation

Aucun ordre requis : pointez une borne vers le relais quand vous voulez,
avant ou après l'avoir configurée. Elle apparaît dans Découverte dès qu'elle
se connecte, qu'elle ait ou non un cloud d'origine.

1. Installez l'intégration — son relais démarre automatiquement, aucune
   configuration n'est nécessaire pour l'instant.
2. Ouvrez l'écran **Supervision** de l'intégration : le statut de connexion
   affiche une URL OCPP prête à l'emploi, `ws://<adresse LAN de cet hôte
Gladys>:<port>/` — le port est déjà rempli pour vous, il ne reste qu'à
   remplacer le texte générique par l'adresse LAN réelle de cet hôte Gladys.
   Cette URL est **la même pour toutes les bornes**.
3. Dans l'application de la borne, faites pointer son URL de serveur OCPP
   vers cette adresse. Elle se connecte tout de suite et apparaît dans
   l'onglet **Découverte**, prête à être créée comme appareil — son statut
   réel (branchée, en charge, etc.) est déjà supervisé même si elle n'est
   pas encore relayée vers un cloud.
4. Quand vous êtes prêt à la router vers son vrai cloud : trouvez
   l'**identity** de la borne (parfois appelée numéro de série ou
   identifiant de la borne — visible sur sa fiche Découverte/appareil, dans
   son application fabricant, ou sur une étiquette de la borne) et lancez
   l'action **"Ajouter une borne"** (écran Configuration) avec cette
   identity et l'**URL du cloud d'origine** telle qu'affichée par
   l'application de cette borne — y compris une éventuelle chaîne de requête
   finale que certains fabricants utilisent (ex. se terminant par `?sn=`).
   Une telle astuce ne concerne que la connexion sortante du relais vers le
   cloud de ce fabricant — elle est invisible pour la borne elle-même. La
   borne se reconnecte automatiquement en quelques secondes et commence à
   être relayée au lieu d'être simplement supervisée localement. Son URL de
   cloud d'origine configurée est alors affichée directement sur sa fiche
   (Découverte, puis l'appareil une fois créé) — c'est le seul endroit pour
   la consulter, il n'existe aucune liste des bornes configurées ailleurs.
5. Répétez l'étape 4 pour chaque autre borne à relayer — même URL, sa propre
   identity, sa propre URL de cloud d'origine, même d'un fabricant
   différent.

Pour corriger une erreur ou changer l'URL du cloud d'origine d'une borne,
relancez l'action avec la même identity et l'URL corrigée (vérifiez d'abord
son URL actuelle sur sa fiche appareil). Pour détacher une borne de son
cloud et la remettre en supervision locale uniquement, relancez l'action
avec son identity et une URL **vide** — prend effet à la prochaine
reconnexion de cette borne (elle continue d'être relayée via sa connexion
en cours jusque-là).

## Connecteurs multiples

Une borne est un seul appareil dans Gladys, quel que soit son nombre de
connecteurs physiques. Elle démarre avec les fonctionnalités d'un seul
connecteur (statut, branchée, en charge, puissance, courant, tension,
énergie) ; si elle possède plusieurs connecteurs physiques, les
supplémentaires apparaissent comme fonctionnalités additionnelles
("Connecteur 2 - ...", etc.) une fois que le relais les a réellement vus
rapporter leur statut au moins une fois. Si vous avez déjà créé l'appareil,
Gladys affiche un bouton **Mettre à jour** dès que de nouveaux connecteurs
sont détectés — rien n'est ajouté silencieusement à un appareil déjà créé.
Si un connecteur n'apparaît pas encore, essayez **Relancer un scan** depuis
l'onglet Découverte après avoir utilisé ce connecteur.

## Note de sécurité

Exposer le port OCPP du relais le rend joignable par tout appareil de votre
réseau local, sans authentification — c'est inhérent à la façon dont les
bornes OCPP se connectent à un serveur. Le relais se contente d'_observer_ ce
qui transite et ne prend jamais de décision de lui-même (il n'invente jamais
de transaction, n'autorise jamais une charge) : au pire, un appareil
malveillant de votre réseau local pourrait injecter des données trompeuses
dans la vue de cette intégration, mais il ne peut pas affecter une borne
réelle, qui garde sa propre connexion indépendante au cloud de son fabricant
via le relais. Gardez cela à l'esprit sur un réseau partagé ou non fiable.

## Limitations connues (cette version)

- **L'état du relais est réinitialisé à chaque redémarrage** (redémarrage de
  l'hôte, plantage) : il ne se souvient que de ce qu'il a vu depuis son
  dernier démarrage, y compris quelles bornes sont configurées — l'intégration
  renvoie l'ensemble complet des bornes configurées dès qu'elle se reconnecte
  à Gladys, donc ça se répare tout seul en quelques secondes, sans avoir à
  relancer l'action. Juste après un redémarrage, des bornes déjà connues
  disparaissent brièvement jusqu'à leur reconnexion (généralement quelques
  secondes) ; cela ne supprime jamais un appareil déjà créé dans Gladys.
- **Démarrer une charge pendant qu'une borne est encore supervisée
  localement (pas de cloud d'origine associé), puis associer un cloud en
  cours de session :** la borne peut continuer de référencer la session
  démarrée localement une fois reconnectée en mode relais, que le vrai cloud
  d'origine n'a jamais vue. Un chevauchement rare en pratique (associer un
  cloud se fait généralement une seule fois, juste après la première
  connexion) — si cela arrive, les données de cette session peuvent ne pas
  remonter correctement au cloud d'origine ; la session suivante n'est pas
  affectée.
- **Aucun pilotage depuis Gladys.** Démarrer, arrêter ou limiter une charge
  n'est pas possible dans cette version.

## Dépannage

Consultez les logs de l'intégration depuis l'interface Gladys (bloc de
supervision → sélecteur de conteneur), pour le conteneur principal et,
séparément, pour le sous-conteneur `gateway` — c'est là que le relais OCPP
lui-même journalise chaque connexion, déconnexion et message relayé (payload
complet, dans les deux sens) pour chaque borne.
