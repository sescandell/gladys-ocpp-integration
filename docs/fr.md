# Passerelle OCPP pour borne de recharge

Ceci est la documentation utilisateur de l'intégration. Gladys ré-héberge ce
fichier et affiche un lien **Documentation** permanent vers lui dans l'écran
de configuration (dans la langue de l'utilisateur, avec l'anglais en repli) —
c'est au moment de configurer que l'utilisateur en a le plus besoin.

## Portée de cette version

**Supervision en lecture seule, rien d'autre.** Cette intégration observe une
borne de recharge OCPP 1.6 et affiche son état dans Gladys (statut,
branchée, en charge, puissance, courant, tension, énergie totale) — il n'est
pas encore possible de démarrer, arrêter ou limiter une charge depuis Gladys.

## Fonctionnement

L'intégration embarque son propre relais OCPP dans un sous-conteneur : votre
borne se connecte directement à un port assigné par Gladys, et le relais
transmet tout vers le cloud de votre fabricant, si bien que la borne continue
de fonctionner exactement comme avant — rien n'est changé ni remplacé côté
service du fabricant. Le relais se contente d'_observer_ ce qui transite pour
construire l'état affiché dans Gladys ; il n'invente ni ne retient jamais
rien sur le fil.

## Prérequis

L'application ou le portail de votre fabricant de borne doit permettre de
consulter et de modifier l'URL du serveur OCPP auquel la borne se connecte.
Tous les fabricants ne proposent pas cette option — si le vôtre ne le fait
pas, cette intégration ne peut pas être utilisée.

**Avant de changer quoi que ce soit, notez l'URL du serveur OCPP actuellement
affichée par l'application du fabricant.** C'est le seul moyen de revenir au
cloud d'origine si vous souhaitez un jour arrêter d'utiliser cette
intégration.

## Installation

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez l'**URL du cloud d'origine** telle qu'affichée par l'application du
   fabricant, y compris une éventuelle chaîne de requête finale (certains
   fabricants terminent leur URL par quelque chose comme `?sn=`).
3. Enregistrez. L'intégration démarre son relais (un sous-conteneur) et
   affiche son statut.
4. Ouvrez le bloc de supervision de l'intégration pour trouver le **port
   hôte** assigné par Gladys au port OCPP du sous-conteneur `gateway` (une
   étiquette/lien "Ouvrir" à côté de l'entrée `gateway`). Ce port est
   également rappelé dans le message de statut de connexion de
   l'intégration.
5. Dans l'application du fabricant de votre borne, faites pointer l'URL de
   son serveur OCPP vers `ws://<adresse-LAN-de-cet-hôte-Gladys>:<port
assigné>/` — adressage OCPP standard (la borne s'identifie dans le chemin
   de l'URL, comme elle l'a toujours fait). Une éventuelle astuce de query
   string côté fabricant (étape 2) ne concerne que la connexion sortante du
   relais vers le cloud du fabricant — elle est invisible pour votre borne.
6. Rendez-vous dans l'onglet **Découverte** : une fois que la borne s'est
   connectée et a envoyé ses premiers statuts, son ou ses connecteurs y
   apparaissent, prêts à être ajoutés comme appareils.

## Connecteurs multiples

Si votre borne possède plusieurs connecteurs physiques, chacun devient son
propre appareil dans Gladys dès qu'il a rapporté son statut au moins une
fois. Si un connecteur n'apparaît pas encore, essayez **Relancer un scan**
depuis l'onglet Découverte après avoir utilisé ce connecteur.

## Note de sécurité

Exposer le port OCPP du relais le rend joignable par tout appareil de votre
réseau local, sans authentification — c'est inhérent à la façon dont les
bornes OCPP se connectent à un serveur. Le relais se contente d'_observer_ ce
qui transite et ne prend jamais de décision de lui-même (il n'invente jamais
de transaction, n'autorise jamais une charge) : au pire, un appareil
malveillant de votre réseau local pourrait injecter des données trompeuses
dans la vue de cette intégration, mais il ne peut pas affecter votre borne
réelle, qui garde sa propre connexion indépendante au cloud du fabricant via
le relais. Gardez cela à l'esprit sur un réseau partagé ou non fiable.

## Limitations connues (cette version)

- **Une seule borne par instance installée.** Si vous avez plusieurs bornes,
  installez l'intégration une fois par borne.
- **L'état du relais est réinitialisé à chaque redémarrage** (redémarrage de
  l'hôte, changement de l'URL du cloud d'origine, ou plantage) : il ne se
  souvient que de ce qu'il a vu depuis son dernier démarrage. Cela ne
  supprime jamais un appareil déjà créé dans Gladys — cela signifie
  seulement que des données fraîches ne reviennent qu'une fois la borne
  reconnectée et son statut renvoyé (généralement en quelques secondes).
- **Aucun pilotage depuis Gladys.** Démarrer, arrêter ou limiter une charge
  n'est pas possible dans cette version.

## Dépannage

Consultez les logs de l'intégration depuis l'interface Gladys (bloc de
supervision → sélecteur de conteneur), pour le conteneur principal et,
séparément, pour le sous-conteneur `gateway` — c'est là que le relais OCPP
lui-même journalise chaque connexion, déconnexion et message relayé.
