// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

const both = (fn) => ({ en: fn('en'), fr: fn('fr') });

export const FEATURE_NAMES = {
  state: { en: 'Print state', fr: "État de l'impression" },
  machine: { en: 'Machine state', fr: 'État de la machine' },
  progress: { en: 'Progress (%)', fr: 'Progression (%)' },
  layer: { en: 'Current layer', fr: 'Couche en cours' },
  'total-layers': { en: 'Total layers', fr: 'Nombre de couches' },
  elapsed: { en: 'Time elapsed', fr: 'Temps écoulé' },
  remaining: { en: 'Time remaining', fr: 'Temps restant' },
  file: { en: 'File', fr: 'Fichier' },
  error: { en: 'Error', fr: 'Erreur' },
  'error-code': { en: 'Error code', fr: "Code d'erreur" },
  'nozzle-temperature': { en: 'Nozzle temperature', fr: 'Température de la buse' },
  'bed-temperature': { en: 'Bed temperature', fr: 'Température du plateau' },
  'enclosure-temperature': { en: 'Enclosure temperature', fr: "Température de l'enceinte" },
  'uvled-temperature': { en: 'UV LED temperature', fr: 'Température des LED UV' },
  'vat-temperature': { en: 'Vat temperature', fr: 'Température de la cuve' },
  'model-fan': { en: 'Model fan', fr: 'Ventilateur de pièce' },
  'auxiliary-fan': { en: 'Auxiliary fan', fr: 'Ventilateur auxiliaire' },
  'enclosure-fan': { en: 'Enclosure fan', fr: "Ventilateur de l'enceinte" },
};

export const PHASE_NAMES = {
  idle: { en: 'Idle', fr: 'Au repos' },
  preparing: { en: 'Preparing', fr: 'Préparation' },
  printing: { en: 'Printing', fr: 'Impression' },
  pausing: { en: 'Pausing', fr: 'Mise en pause' },
  paused: { en: 'Paused', fr: 'En pause' },
  stopping: { en: 'Stopping', fr: 'Arrêt en cours' },
  stopped: { en: 'Stopped', fr: 'Arrêtée' },
  completed: { en: 'Completed', fr: 'Terminée' },
  error: { en: 'Error', fr: 'Erreur' },
  busy: { en: 'Busy', fr: 'Occupée' },
  unknown: { en: 'Unknown', fr: 'Inconnu' },
};

export const MACHINE_NAMES = {
  idle: { en: 'Idle', fr: 'Au repos' },
  printing: { en: 'Printing', fr: 'Impression' },
  file_transfer: { en: 'File transfer', fr: 'Transfert de fichier' },
  exposure_test: { en: 'Exposure test', fr: "Test d'exposition" },
  self_test: { en: 'Self-test', fr: 'Autotest' },
  leveling: { en: 'Leveling', fr: 'Mise à niveau' },
  input_shaping: { en: 'Input shaping', fr: 'Calibrage des vibrations' },
  stopping: { en: 'Stopping', fr: 'Arrêt en cours' },
  stopped: { en: 'Stopped', fr: 'Arrêtée' },
  homing: { en: 'Homing', fr: "Retour à l'origine" },
  loading: { en: 'Loading or unloading', fr: 'Chargement ou déchargement' },
  pid_tuning: { en: 'PID tuning', fr: 'Réglage PID' },
  recovery: { en: 'Recovery', fr: 'Reprise' },
  unknown: { en: 'Unknown', fr: 'Inconnu' },
};

/** SDCP PrintInfo.ErrorNumber. */
const PRINT_ERRORS = {
  1: { en: 'File check (MD5) failed', fr: 'Vérification du fichier (MD5) échouée' },
  2: { en: 'File read failed', fr: 'Lecture du fichier échouée' },
  3: { en: 'Resolution mismatch', fr: 'Résolution incompatible' },
  4: { en: 'Unknown file format', fr: 'Format de fichier inconnu' },
  5: { en: 'File made for another model', fr: 'Fichier prévu pour un autre modèle' },
};

/** SDCP error frames (ErrorCode). */
const FRAME_ERRORS = {
  1: { en: 'File transfer check (MD5) failed', fr: 'Vérification du transfert (MD5) échouée' },
  2: { en: 'Wrong file format', fr: 'Format de fichier incorrect' },
};

export const NO_ERROR = { en: 'None', fr: 'Aucune' };

export function printErrorText(number, phase) {
  if (number > 0) {
    return (
      PRINT_ERRORS[number] ?? both((l) => (l === 'fr' ? `Erreur ${number}` : `Error ${number}`))
    );
  }
  if (phase === 'error') {
    return { en: 'Printer error', fr: "Erreur de l'imprimante" };
  }
  return NO_ERROR;
}

export const frameErrorText = (code) =>
  FRAME_ERRORS[code] ?? both((l) => (l === 'fr' ? `Erreur ${code}` : `Error ${code}`));

/** Ack codes of the print control commands (SDCP sdcp_print_ctrl_ack_t). */
const ACKS = {
  1: { en: 'the printer is busy', fr: "l'imprimante est occupée" },
  2: { en: 'file not found', fr: 'fichier introuvable' },
  3: { en: 'file check failed', fr: 'vérification du fichier échouée' },
  4: { en: 'file read failed', fr: 'lecture du fichier échouée' },
};

const COMMAND_NAMES = {
  pause: { en: 'pause', fr: 'pause' },
  resume: { en: 'resume', fr: 'reprise' },
  stop: { en: 'stop', fr: 'arrêt' },
};

const list = (items) => items.join(', ');

export const T = {
  noPrinter: {
    en: 'No printer yet: type the IP address of your printers, or use "Find the printers".',
    fr: "Aucune imprimante pour l'instant : saisissez l'adresse IP de vos imprimantes, ou utilisez « Chercher les imprimantes ».",
  },
  status: (up, total) => ({
    en: `${up} of ${total} printer(s) connected.`,
    fr: `${up} imprimante(s) connectée(s) sur ${total}.`,
  }),
  waiting: (hosts) => ({
    en: `No answer yet from: ${list(hosts)} (printer off, wrong address, or its connections all taken).`,
    fr: `Pas encore de réponse de : ${list(hosts)} (imprimante éteinte, mauvaise adresse, ou toutes ses connexions prises).`,
  }),
  invalidAddresses: (entries) => ({
    en: `Invalid address(es) ignored: ${list(entries)}.`,
    fr: `Adresse(s) invalide(s) ignorée(s) : ${list(entries)}.`,
  }),
  find: {
    none: {
      en: 'No printer answered the search. The search goes through Gladys (UDP port 3000); if it finds nothing, type the IP addresses of the printers in the configuration.',
      fr: "Aucune imprimante n'a répondu à la recherche. Elle passe par Gladys (UDP port 3000) ; si elle ne trouve rien, saisissez l'adresse IP des imprimantes dans la configuration.",
    },
    found: (printers) => ({
      en: `Found: ${list(printers)}. They are in the Discovery tab.`,
      fr: `Trouvée(s) : ${list(printers)}. Elles sont dans l'onglet Découverte.`,
    }),
    failed: (message) => ({
      en: `The search failed: ${message}. Type the IP addresses of the printers in the configuration.`,
      fr: `La recherche a échoué : ${message}. Saisissez l'adresse IP des imprimantes dans la configuration.`,
    }),
  },
  control: {
    disabled: {
      en: 'Print control is off: allow it in the configuration of the Elegoo integration.',
      fr: "Le pilotage des impressions est désactivé : autorisez-le dans la configuration de l'intégration Elegoo.",
    },
    unknownCommand: { en: 'Unknown command.', fr: 'Commande inconnue.' },
    noPrinter: {
      en: 'Choose an Elegoo printer.',
      fr: 'Choisissez une imprimante Elegoo.',
    },
    offline: (name) => ({
      en: `${name} is not connected: command not sent.`,
      fr: `${name} n'est pas connectée : commande non envoyée.`,
    }),
    stale: (name) => ({
      en: `${name} did not send a fresh state: command not sent.`,
      fr: `${name} n'a pas renvoyé un état récent : commande non envoyée.`,
    }),
    late: (name) => ({
      en: `No time left to wait for the answer of ${name}: command not sent.`,
      fr: `Plus le temps d'attendre la réponse de ${name} : commande non envoyée.`,
    }),
    notNow: (name, command, phase) => ({
      en: `${name} is "${PHASE_NAMES[phase]?.en ?? phase}": no ${COMMAND_NAMES[command].en} possible.`,
      fr: `${name} est « ${PHASE_NAMES[phase]?.fr ?? phase} » : ${COMMAND_NAMES[command].fr} impossible.`,
    }),
    refused: (name, ack) => ({
      en: `${name} refused the command: ${ACKS[ack]?.en ?? `code ${ack}`}.`,
      fr: `${name} a refusé la commande : ${ACKS[ack]?.fr ?? `code ${ack}`}.`,
    }),
    noAnswer: (name) => ({
      en: `${name} did not confirm the command in time: check the printer, it may have been applied.`,
      fr: `${name} n'a pas confirmé la commande à temps : vérifiez l'imprimante, elle a pu être appliquée.`,
    }),
  },
};

/** An Error whose message is in the language of the configuration; `text` keeps both. */
export class LocalizedError extends Error {
  constructor(text, language = 'en') {
    super(word(text, language));
    this.text = text;
  }
}
