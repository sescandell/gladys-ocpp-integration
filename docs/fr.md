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
démarré automatiquement à l'installation. Chaque borne se connecte au
**même** port assigné par Gladys — le relais les distingue grâce à
l'identity que chacune annonce à la connexion, et transmet le trafic de
chaque borne vers **son propre** cloud d'origine configuré, si bien que
chaque borne continue de fonctionner exactement comme avant — rien n'est
changé ni remplacé côté service d'aucun fabricant. Le relais se contente
d'_observer_ ce qui transite pour construire l'état affiché dans Gladys ; il
n'invente ni ne retient jamais rien sur le fil.

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

Configurez chaque borne **avant** de la faire pointer vers le relais. La
plupart des bornes ne terminent pas leur connexion vers un serveur qui ne
connaît pas déjà leur identity — une première tentative de connexion contre
un relais non configuré est généralement rejetée et pas réessayée
proprement, donc l'ordre des étapes compte.

1. Installez l'intégration — son relais démarre automatiquement, aucune
   configuration n'est nécessaire pour l'instant.
2. Trouvez l'**identity** de la borne (parfois appelée numéro de série ou
   identifiant de la borne) dans son application ou son portail fabricant,
   ou sur une étiquette de la borne elle-même.
3. Lancez l'action **"Ajouter une borne"** (écran Configuration) : collez
   l'identity, et l'**URL du cloud d'origine** telle qu'affichée par
   l'application de cette borne — y compris une éventuelle chaîne de requête
   finale que certains fabricants utilisent (ex. se terminant par `?sn=`).
   Une telle astuce ne concerne que la connexion sortante du relais vers le
   cloud de ce fabricant — elle est invisible pour la borne elle-même. Dès
   que l'action se termine, la borne apparaît dans l'onglet **Découverte**,
   prête à être créée comme appareil — pas besoin qu'elle se soit déjà
   connectée.
4. Ouvrez le bloc de supervision de l'intégration pour trouver le **port
   hôte** assigné par Gladys au port OCPP du sous-conteneur `gateway` (une
   étiquette/lien "Ouvrir" à côté de l'entrée `gateway`, également rappelé
   dans le message de statut de connexion). Ce port est **le même pour
   toutes les bornes**.
5. Dans l'application de la borne, faites pointer son URL de serveur OCPP
   vers `ws://<adresse-LAN-de-cet-hôte-Gladys>:<port assigné>/` — adressage
   OCPP standard (la borne s'identifie dans le chemin de l'URL, comme elle
   l'a toujours fait).
6. Étant déjà configurée, la borne se connecte et commence à être relayée
   immédiatement — l'appareil créé à l'étape 3 commence à recevoir de
   vraies données.
7. Répétez les étapes 2 à 6 pour chaque autre borne — même port, sa propre
   identity, sa propre URL de cloud d'origine, même d'un fabricant
   différent.

Pour corriger une erreur ou changer l'URL du cloud d'origine d'une borne,
relancez l'action avec la même identity et l'URL corrigée. Pour retirer une
borne, relancez l'action avec son identity et une URL **vide**.

Si une borne se connecte avant d'avoir été ajoutée ici (ou avec une identity
différente de celle saisie), elle est rejetée et listée comme **détectée, en
attente de configuration** dans le statut de connexion, avec l'identity
exacte qu'elle a annoncée — utile pour repérer une erreur de saisie, mais ce
n'est pas le fonctionnement prévu : ajoutez-la d'abord, puis faites-la
pointer vers le relais.

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
  disparaissent brièvement de l'état "détectée" jusqu'à leur reconnexion
  (généralement quelques secondes) ; cela ne supprime jamais un appareil déjà
  créé dans Gladys.
- **Aucun pilotage depuis Gladys.** Démarrer, arrêter ou limiter une charge
  n'est pas possible dans cette version.

## Dépannage

Consultez les logs de l'intégration depuis l'interface Gladys (bloc de
supervision → sélecteur de conteneur), pour le conteneur principal et,
séparément, pour le sous-conteneur `gateway` — c'est là que le relais OCPP
lui-même journalise chaque connexion, déconnexion et message relayé (payload
complet, dans les deux sens) pour chaque borne.
