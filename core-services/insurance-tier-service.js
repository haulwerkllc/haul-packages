/**
 * Insurance coverage tier thresholds and the tier-compute function shared by
 * haul-svc-core (AI document review rollups) and haul-svc-admin (admin COI
 * edits). Keeping this here — rather than duplicated in each service —
 * avoids the two drifting apart.
 *
 * See haul-shared-types/enums/insuranceTier.ts for the canonical tier enum
 * and rank map used downstream (haul-svc-jobs, haul-svc-notifications).
 */

const INSURANCE_TIERS = {
  GL_300K: {
    minimum_per_occurrence_cents: 30000000,
    minimum_aggregate_cents: 30000000
  },
  GL_1M: {
    minimum_per_occurrence_cents: 100000000,
    minimum_aggregate_cents: 100000000
  },
  GL_1M_2M: {
    minimum_per_occurrence_cents: 100000000,
    minimum_aggregate_cents: 200000000
  }
};

const VALID_INSURANCE_TIERS = new Set(Object.keys(INSURANCE_TIERS));

// Ordered highest to lowest so the first satisfied tier wins.
const INSURANCE_TIER_ORDER = ['GL_1M_2M', 'GL_1M', 'GL_300K'];

/**
 * Compute a company's insurance coverage tier from parsed GL limits. This is
 * always computed in code from the parsed per-occurrence/aggregate cents —
 * never returned directly by the LLM — so tier assignment stays
 * deterministic and auditable regardless of prompt wording. An admin can
 * still override the stored tier directly (see company-service.js).
 *
 * Returns an InsuranceTier string value, or null if either limit is not
 * confidently parsed, or coverage falls below the lowest tier (GL_300K).
 */
function computeCompanyInsuranceTier(occCents, aggCents) {
  if (occCents == null || aggCents == null) return null;

  for (const tier of INSURANCE_TIER_ORDER) {
    const thresholds = INSURANCE_TIERS[tier];
    if (occCents >= thresholds.minimum_per_occurrence_cents && aggCents >= thresholds.minimum_aggregate_cents) {
      return tier;
    }
  }

  return null;
}

module.exports = {
  INSURANCE_TIERS,
  VALID_INSURANCE_TIERS,
  computeCompanyInsuranceTier
};
