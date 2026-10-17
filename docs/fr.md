# Nexia, Trane Home et American Standard Home

Les thermostats de Trane Technologies (série Trane XL, American Standard Gold
/ Platinum, UX360…) dans Gladys, par le cloud de leur application : **Nexia**
(mynexia.com), **Trane Home** (tranehome.com) ou **American Standard Home**
(asairhome.com, appelée aussi Asair).

> **Intégration non officielle**, sans lien avec Trane Technologies. Elle
> utilise l’**API non officielle** de l’application mobile (celle de la
> bibliothèque [nexia](https://github.com/bdraco/nexia) et de Home
> Assistant), qui peut changer sans prévenir. Elle n’a jamais été testée avec un vrai compte :
> seulement avec les réponses enregistrées par la bibliothèque nexia. Merci de
> signaler ce que vous observez.

## Configuration

1. **Marque (application)** : l’application où vous vous connectez. Les trois
   sont le même cloud sous trois adresses.
2. **Adresse e-mail** et **mot de passe** de ce compte. Le mot de passe est
   gardé par Gladys dans sa base (non chiffré, jamais réaffiché) et envoyé
   seulement au cloud de la marque choisie.
3. Enregistrez. L’état indique combien de thermostats et de zones ont été
   trouvés ; les appareils sont dans l’onglet **Découverte**.

**Tester la connexion** se reconnecte et liste thermostats et zones.

### Mot de passe refusé

Plusieurs mauvais mots de passe de suite peuvent bloquer le compte. Quand le
cloud refuse l’e-mail ou le mot de passe, Gladys s’arrête ; il ne réessaie
seul que deux fois, 6 heures puis 24 heures plus tard (même après un
redémarrage), puis vous attend : corrigez le mot de passe et enregistrez, ou
appuyez sur **Tester la connexion**.

## Appareils

**Un appareil par thermostat** (le système) :

- humidité intérieure (%) ;
- température extérieure, si le système a une sonde (tenue à l’écart de la
  température de la pièce dans Gladys) ;
- état du système (texte du cloud : « Cooling », « System Idle »…) ;
- ventilation (auto, marche, circulation : les choix du thermostat) ;
- consignes d’humidification / de déshumidification (%), si un humidificateur
  ou un déshumidificateur est installé (lecture seule).

**Un appareil par zone** (un système sans zones a une zone, au nom du
thermostat) :

- température ;
- consigne de chauffage et consigne de refroidissement ;
- mode : arrêt, chauffage, refroidissement, auto (le chauffage de secours
  apparaît comme chauffage) ;
- fonctionnement : au repos, chauffe, refroidit ;
- programme ou maintien (texte du cloud).

Les températures sont dans l’unité du compte (°F ou °C) à la création de
l’appareil ; Gladys les convertit si le compte change d’unité ensuite.

Les valeurs sont lues **chaque minute** (le cloud répond le plus souvent
« rien de nouveau », ce qui ne coûte presque rien). Un thermostat que le
cloud signale hors ligne apparaît injoignable, et ses valeurs ne sont pas
publiées.

## Commandes (désactivées par défaut)

Par défaut Gladys ne fait que lire. Cochez **Autoriser les commandes** pour
que le tableau de bord, les scènes, les assistants vocaux et le service
Thermostat de Gladys puissent changer :

- les **consignes de chauffage et de refroidissement** d’une zone. Une valeur
  est d’abord vérifiée (40 à 99 °F, ou 4,5 à 37 °C, dans l’unité de la
  fonctionnalité Gladys) : hors de ces bornes elle est refusée, jamais
  ajustée. Elle est ensuite arrondie comme dans l’application (1 °F,
  0,5 °C) et vérifiée contre les limites du thermostat ; l’autre consigne se
  décale pour garder l’écart que demande le thermostat (la « zone morte »),
  comme dans l’application ;
- le **mode** d’une zone (arrêt, chauffage, refroidissement, auto) ;
- la **ventilation**.

Avant chaque commande, Gladys relit le thermostat : s’il est hors ligne, si
la zone a disparu ou si la valeur est déjà la bonne, rien n’est envoyé. Une
commande à la fois. Il n’y a jamais d’interrupteur pour couper le chauffage :
« tout éteindre » dans Gladys ne touche pas aux thermostats.

Une consigne changée ainsi peut ne tenir que jusqu’au prochain créneau du
programme du thermostat, comme dans l’application.

## Limites

- HTTP 429 (trop de requêtes) : toutes les requêtes attendent (1 minute à
  6 heures), même après un redémarrage.
- Cloud injoignable : nouvel essai après 1 minute, puis de moins en moins
  souvent (jusqu’à 30 minutes).
- Seulement la première maison du compte.
- Pas encore : préréglages (maison, absent, nuit), reprise du programme,
  chauffage de secours, commandes des consignes d’humidité, purificateur
  d’air, capteurs RoomIQ.

## Vie privée

L’adresse e-mail et le mot de passe ne partent que vers le cloud de la marque
choisie. La clé de session reste en mémoire. Le dossier `/data` du conteneur
ne contient qu’un identifiant aléatoire de cette installation (l’application
en envoie un), la fin d’une pause 429 et l’état d’un refus (une empreinte de
la marque et de l’e-mail, jamais le mot de passe).
