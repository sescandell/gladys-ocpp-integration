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

1. Installez l'intégration — son relais démarre automatiquement, aucune
   configuration n'est nécessaire pour l'instant.
2. Ouvrez le bloc de supervision de l'intégration pour trouver le **port
   hôte** assigné par Gladys au port OCPP du sous-conteneur `gateway` (une
   étiquette/lien "Ouvrir" à côté de l'entrée `gateway`, également rappelé
   dans le message de statut de connexion). Ce port est **le même pour
   toutes les bornes**.
3. Dans l'application d'une borne, faites pointer son URL de serveur OCPP
   vers `ws://<adresse-LAN-de-cet-hôte-Gladys>:<port assigné>/` — adressage
   OCPP standard (la borne s'identifie dans le chemin de l'URL, comme elle
   l'a toujours fait).
4. La borne tente de se connecter, mais le relais ne sait pas encore où la
   relayer : le statut de connexion la liste alors comme **détectée, en
   attente de configuration**, avec son identity (également visible dans
   les logs du sous-conteneur `gateway`). Copiez cette identity.
5. Lancez l'action **"Configurer une borne détectée"** (écran
   Configuration) : collez l'identity, et l'**URL du cloud d'origine**
   telle qu'affichée par l'application de cette borne — y compris une
   éventuelle chaîne de requête finale que certains fabricants utilisent
   (ex. se terminant par `?sn=`). Une telle astuce ne concerne que la
   connexion sortante du relais vers le cloud de ce fabricant — elle est
   invisible pour la borne elle-même.
6. La borne se reconnecte (elle réessaie de elle-même) et le relais commence
   à fonctionner. Rendez-vous dans l'onglet **Découverte** : une fois
   qu'elle a envoyé ses premiers statuts, son ou ses connecteurs y
   apparaissent, prêts à être ajoutés comme appareils.
7. Répétez les étapes 3 à 6 pour chaque autre borne — même port, sa propre
   identity, sa propre URL de cloud d'origine, même d'un fabricant
   différent.

Pour corriger une erreur ou changer l'URL du cloud d'origine d'une borne,
relancez l'action avec la même identity et l'URL corrigée. Pour retirer une
borne, relancez l'action avec son identity et une URL **vide**.

## Connecteurs multiples

Si une borne possède plusieurs connecteurs physiques, chacun devient son
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
