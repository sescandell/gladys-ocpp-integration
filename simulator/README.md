# Simulateur de borne OCPP 1.6

Outil de **développement** : une fausse borne OCPP 1.6 pilotée depuis une page web, pour voir le
widget et l'intégration Gladys réagir à chaque situation (branchement, charge, pause, défaut,
sessions successives, coupure réseau) sans borne réelle.

Il est totalement indépendant de l'intégration : son propre `package.json`, rien n'est copié dans
l'image Docker de l'intégration ni dans celle de la gateway (`Dockerfile` explicite +
`.dockerignore`), et il n'est pas couvert par `npm test` à la racine.

## Lancer

```bash
cd simulator
npm install      # une seule fois (dépendance : ocpp-rpc, la même lib que la gateway)
npm start        # http://127.0.0.1:8088/
```

Variables d'environnement : `SIM_PORT` (défaut `8088`), `SIM_HOST` (défaut `127.0.0.1` ;
`0.0.0.0` pour ouvrir l'interface depuis une autre machine).

## Se connecter à une instance Gladys

1. Sur l'instance de test, dans la supervision de l'intégration, repérer l'URL OCPP de la gateway
   (`ws://<hôte-gladys>:<port>/`) : c'est la même que celle saisie dans une vraie borne.
2. Dans l'interface du simulateur, section **Connexion**, saisir cette URL (sans l'identité : le
   simulateur l'ajoute) et l'identité OCPP voulue (`SIMULATOR-1` par défaut), puis **Connecter**.
3. La borne apparaît dans l'onglet **Découverte** de Gladys : l'ajouter, puis créer le widget
   « Borne de recharge » et le rattacher à cet appareil.

La configuration est enregistrée dans `simulator/.sim-config.json` (ignoré par git).

> Sans URL d'origine configurée (action « Ajouter une borne »), la gateway répond en mode local :
> aucune connexion à un cloud n'est tentée, ce qui convient parfaitement pour tester.

## Utiliser

- **Connecteurs** : un panneau par connecteur (statut, puissance, compteur, courant, transaction)
  et les gestes d'une vraie borne : brancher, démarrer la charge, pause véhicule / borne, reprendre,
  arrêter, débrancher, puissance cible, défaut (avec code d'erreur) ou statut forcé.
- **Scénarios** : situations scriptées (session complète, charge interrompue par le véhicule, pause
  par la borne, 3 sessions à la suite pour remplir « Sessions récentes », véhicule branché sans
  charge, défaut, indisponible, coupure de connexion). La durée est en temps **réel**.
- **Accélération de l'énergie** (×60 par défaut) : multiplie l'énergie délivrée par seconde réelle.
  À ×60, une minute de charge à 7,4 kW ajoute ~7,4 kWh. Les horodatages, eux, restent réels (la
  durée de session affichée par le widget est donc la durée réelle).
- **Échanges OCPP** : journal en direct de tout ce qui est envoyé et reçu.

La borne répond aussi aux ordres du CSMS les plus courants (`RemoteStartTransaction`,
`RemoteStopTransaction`, `TriggerMessage`, `Reset`…).

## Tests

```bash
cd simulator && npm test
```

Ils font tourner le simulateur contre un mini-CSMS (`ocpp-rpc`) en mémoire.
