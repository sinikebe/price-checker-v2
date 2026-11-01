# Extension de navigateur (prototype)

Certaines enseignes (Carrefour, Intermarché, Courses U) bloquent les lectures automatiques depuis un serveur. L’extension fait la lecture **dans votre navigateur**, sur le site de l’enseigne, avec **votre session et votre magasin choisi** : c’est une visite ordinaire, rien n’est contourné. Elle propose ensuite le prix à votre instance.

État : prototype, Carrefour uniquement, une lecture à la fois, déclenchée par vous.

## Installer

1. Administrateurs : **Paramètres → Connecteurs → Extension de navigateur** → *Télécharger l’extension*. L’archive est préparée dans le navigateur à partir des fichiers de l’application et contient l’adresse de l’instance, que l’extension reprend toute seule. (Les sources sont dans `frontend/browser-extension/`.)
2. Décompresser, puis dans Chrome, Edge ou Brave : `chrome://extensions` → activer le mode développeur → *Charger l’extension non empaquetée* → choisir le dossier décompressé.
3. Dans l’application : **Paramètres → Jetons API** → créer un jeton de portée **contribuer**.
4. Cliquer sur l’icône de l’extension et renseigner le jeton et le numéro du magasin (celui de la page du magasin dans l’application). Le navigateur demande l’autorisation de joindre votre instance, et seulement elle.

## Utiliser

1. Ouvrir `carrefour.fr` dans l’onglet actif et choisir votre drive.
2. Dans la fenêtre de l’extension, saisir ou confirmer l’EAN (repris de l’adresse de l’onglet s’il y figure), puis *Lire le prix*.
3. Comparer le prix proposé avec celui de la page, puis *Proposer ce prix*. Il arrive comme proposition à valider, avec la même relecture que les autres captures.

Si Carrefour demande une vérification, l’extension s’arrête : validez la page vous-même puis recommencez.

## Ce qu’elle fait et ne fait pas

- Elle ne s’exécute que sur `www.carrefour.fr` et ne demande l’accès qu’à votre instance. Aucun script distant, aucune télémétrie.
- Le jeton est gardé dans le stockage local de l’extension, jamais envoyé ailleurs que vers votre instance.
- La lecture est une requête de la page elle-même (`/s?q=<EAN>`) ; la réponse n’est pas documentée par l’enseigne, donc l’extension affiche **tous les prix qu’elle reconnaît et leur emplacement** et ne choisit rien à votre place. Les détails techniques de la fenêtre permettent de corriger l’analyse si le site change.
- Les prix par kilo, les anciens prix et les promotions ne sont pas pris pour le prix du rayon.

## Côté serveur

Une requête qui porte un jeton personnel (en-tête `Authorization: Bearer`) n’est pas soumise au contrôle d’origine des sessions par cookie : le navigateur n’envoie jamais de jeton de lui-même, donc un autre site ne peut pas la provoquer. Un jeton limité à la lecture ne peut rien écrire, et un jeton ne porte jamais de droits d’administrateur ou de modérateur.
