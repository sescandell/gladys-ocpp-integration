# Tester sur une instance Gladys jetable

Pour voir l'intégration et le widget dans un vrai Gladys (≥ 5.1) **sans rien publier** et
**sans toucher à une installation réelle** : un Gladys de test dans Docker, l'intégration
construite en local et installée en mode « dev », et le [simulateur](../simulator/README.md) à la
place d'une borne.

> ⚠️ À lancer sur le Docker de **cette machine de développement**, jamais sur celui de la box
> domotique. Au démarrage, Gladys supprime de force tous les conteneurs d'intégrations externes du
> démon Docker qu'il ne connaît pas : un second Gladys détruirait ceux du premier.

## 1. Gladys de test

```powershell
docker compose -f dev/docker-compose.yml up -d     # http://localhost:8080
```

Ouvrir http://localhost:8080 et créer un compte (instance vierge, rien à voir avec la vraie).

Gladys tourne en réseau `host` (la VM Linux de Docker Desktop) ; le conteneur `gladys-test-ui`
republie son interface sur Windows. Pas de clé Zigbee / Z-Wave, pas de mode privilégié.

## 2. Installer l'intégration (build local, rien de publié)

```powershell
./dev/install-dev.ps1 -Email moi@exemple.com      # demande le mot de passe
```

Le script construit `gladys-ocpp:dev` et `gladys-ocpp-gateway:dev`, puis installe l'intégration en
mode dev (`POST /api/v1/external_integration` avec `docker_image` + manifest : les images sont
locales, les tags du manifest sont remplacés). L'image porte le manifest dans son label
`io.gladysassistant.manifest`, que Gladys relit à chaque mise à jour.

Après une modification du code : relancer **la même commande** — elle reconstruit les images puis
met l'intégration à jour (conteneurs recréés, appareils et config conservés).

| Option       | Effet                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `-Reinstall` | désinstalle d'abord : **supprime les appareils et la config** de l'instance de test, ainsi que les images locales (donc pas de `-SkipBuild`) |
| `-SkipBuild` | n'installe/ne met à jour qu'avec les images déjà construites                                                                                 |
| `-GladysUrl` | autre adresse que `http://localhost:8080`                                                                                                    |

`GLADYS_PASSWORD` (variable d'environnement) évite la saisie du mot de passe.

## 3. Brancher le simulateur

1. Dans Gladys, **Intégrations → Charger Station → Supervision** : repérer le port publié de la
   gateway (ou `docker ps`, ligne `gladys-ext-dev-charger-station-gateway`).
2. Lancer `npm start` dans `simulator/`, ouvrir http://127.0.0.1:8088/, saisir
   `ws://localhost:<port>/` et **Connecter**.
3. La borne apparaît dans **Découverte** : l'ajouter, puis créer le widget « Borne de recharge » sur
   un tableau de bord et lui choisir cet appareil.

## Tout effacer

```powershell
docker compose -f dev/docker-compose.yml down -v
docker network rm gladys-integrations      # réseau créé par Gladys, s'il reste
```

Désinstaller l'intégration dans Gladys avant (`-Reinstall`, ou l'écran Intégrations) enlève aussi
ses conteneurs ; sinon, `docker rm -f gladys-ext-dev-charger-station gladys-ext-dev-charger-station-gateway`.
