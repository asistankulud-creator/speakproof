/**
 * Maps AssemblyAI streaming diarization labels ("A", "B", …) onto the roles
 * this app cares about: `rep` and `customer`.
 *
 * Only the representative's speech can satisfy a disclosure, so getting this
 * mapping right is a compliance concern, not a cosmetic one.
 *
 * Default heuristic: the first speaker heard is the representative — in a
 * regulated outbound call the rep opens. The heuristic is explicit and
 * overridable (`assignRep`) because it will sometimes be wrong, and silently
 * guessing wrong would mis-credit disclosures.
 */
export class SpeakerRoles {
  /** @param {{repLabel?: string|null}} [opts] */
  constructor({ repLabel = null } = {}) {
    this.repLabel = repLabel;
    /** @type {string[]} order of first appearance */
    this.seen = [];
  }

  /**
   * @param {string|null|undefined} label diarization label, or null when
   *   diarization is unavailable.
   * @returns {'rep'|'customer'}
   */
  roleFor(label) {
    // No diarization signal: fall back to treating audio as the rep's own mic.
    if (label == null || label === '') return 'rep';
    if (!this.seen.includes(label)) this.seen.push(label);
    this.repLabel ??= label;
    return label === this.repLabel ? 'rep' : 'customer';
  }

  /** Explicitly declare which diarization label is the representative. */
  assignRep(label) {
    this.repLabel = label;
    if (label && !this.seen.includes(label)) this.seen.push(label);
  }

  /** Swap the assignment — for when the heuristic guessed wrong. */
  swap() {
    const other = this.seen.find((l) => l !== this.repLabel);
    if (other) this.repLabel = other;
    return this.repLabel;
  }

  state() {
    return { repLabel: this.repLabel, seen: [...this.seen] };
  }
}
