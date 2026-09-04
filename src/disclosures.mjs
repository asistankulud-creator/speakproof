/**
 * Disclosure tracking — pure logic, no network.
 *
 * A scenario declares the disclosures a regulated conversation must contain.
 * As finalized turns arrive we mark each one satisfied. Kept dependency-free
 * and side-effect-free so the compliance behaviour can be tested without an
 * API key, audio, or credits.
 */

/** Normalize for comparison: lowercase, strip punctuation, collapse whitespace. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A disclosure is satisfied when ANY of its `anyOf` cue groups is satisfied.
 * A cue group is satisfied when EVERY term in it appears in the text, so a
 * group like ["not", "guaranteed"] requires both words and won't fire on
 * "returns are guaranteed" — the exact inversion we must not miss.
 */
export function matchesDisclosure(disclosure, normalizedText) {
  return disclosure.anyOf.some((group) =>
    group.every((term) => normalizedText.includes(normalize(term)))
  );
}

export class DisclosureTracker {
  /** @param {{id:string,label:string,critical?:boolean,anyOf:string[][]}[]} disclosures */
  constructor(disclosures) {
    this.disclosures = disclosures;
    /** @type {Map<string, {at:number, evidence:string}>} */
    this.satisfied = new Map();
    this.transcriptChars = 0;
  }

  /**
   * Feed a finalized turn.
   * `speaker` is honoured when present: only the representative's own speech
   * can satisfy a disclosure. A customer saying "so it's not guaranteed?" must
   * not tick the box for the rep.
   * @returns {string[]} ids newly satisfied by this turn
   */
  ingest(transcript, { speaker = 'rep', at = Date.now() } = {}) {
    if (speaker !== 'rep') return [];
    const text = normalize(transcript);
    if (!text) return [];
    this.transcriptChars += text.length;

    const newly = [];
    for (const d of this.disclosures) {
      if (this.satisfied.has(d.id)) continue;
      if (matchesDisclosure(d, text)) {
        this.satisfied.set(d.id, { at, evidence: transcript });
        newly.push(d.id);
      }
    }
    return newly;
  }

  get missing() {
    return this.disclosures.filter((d) => !this.satisfied.has(d.id));
  }

  get complete() {
    return this.missing.length === 0;
  }

  /** Serializable view for the UI and for the post-call audit record. */
  status() {
    return {
      complete: this.complete,
      items: this.disclosures.map((d) => {
        const hit = this.satisfied.get(d.id);
        return {
          id: d.id,
          label: d.label,
          critical: d.critical ?? false,
          satisfied: Boolean(hit),
          at: hit?.at ?? null,
          evidence: hit?.evidence ?? null,
        };
      }),
    };
  }
}

/**
 * Demo scenario. Wording is illustrative, not legal advice — the point is the
 * mechanism, and real deployments would load their own compliance-approved set.
 */
export const SCENARIOS = {
  investment_suitability: {
    id: 'investment_suitability',
    label: 'Investment product — suitability call',
    keyterms: [
      'past performance',
      'principal',
      'not FDIC insured',
      'suitability',
      'prospectus',
      'advisory fee',
    ],
    disclosures: [
      {
        id: 'no_guarantee',
        label: 'State that past performance does not guarantee future results',
        critical: true,
        anyOf: [
          ['past performance', 'not', 'guarantee'],
          ['past performance', 'no guarantee'],
          ['does not guarantee future'],
        ],
      },
      {
        id: 'risk_of_loss',
        label: 'Disclose that the client may lose principal',
        critical: true,
        anyOf: [['lose', 'principal'], ['loss of principal'], ['can lose money']],
      },
      {
        id: 'not_insured',
        label: 'State the product is not FDIC insured',
        critical: true,
        anyOf: [['not', 'fdic'], ['no', 'fdic'], ['not federally insured']],
      },
      {
        id: 'fees',
        label: 'Disclose the advisory fee',
        critical: false,
        anyOf: [['advisory fee'], ['management fee'], ['expense ratio']],
      },
      {
        id: 'recording_notice',
        label: 'Notify the client the call is recorded',
        critical: false,
        anyOf: [['call', 'recorded'], ['recording this call'], ['monitored', 'recorded']],
      },
    ],
  },
};
