/**
 * A2 COPUMP — canonical incident-classification module (W-07 wiring).
 *
 * The declarative classifier (`classifyIncident`) and its types live in
 * reputation-memory; this module re-exports them so consumers have one stable
 * import path for incident classification instead of reaching into the memory
 * store. Kept thin to avoid duplicating the classification logic.
 */
export { classifyIncident } from '../services/reputation-memory.js';
export type { IncidentCode, TokenSnapshot } from '../services/reputation-memory.js';
