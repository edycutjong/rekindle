/**
 * Tag constants. Every ID here was seen in live Qloo responses (specs probes P5/P6/P9/P10/P19, D1 spike).
 */

export const TAG_QUIET = "urn:tag:noise_level:qloo:quiet";
export const TAG_WHEELCHAIR = "urn:tag:accessibility:place:wheelchair_accessible_entrance";

/** The 4 obvious bar tags (P9). Used only by the B−4 bench ablation arm. */
export const ALCOHOL_EXCLUDE_4 = [
  "urn:tag:category:place:bar",
  "urn:tag:genre:place:restaurant:bar",
  "urn:tag:category:place:night_club",
  "urn:tag:amenity:place:bar",
] as const;

/** The production 14-tag `filter.exclude.tags` set sent to Qloo when the case is in recovery (P10/P19). */
export const ALCOHOL_EXCLUDE_14 = [
  ...ALCOHOL_EXCLUDE_4,
  "urn:tag:amenity:qloo:bar",
  "urn:tag:amenities:place:bar_onsite",
  "urn:tag:category:place:cocktail_bar",
  "urn:tag:beverage_offering:qloo:full_bar",
  "urn:tag:beverage_offering:qloo:cocktails",
  "urn:tag:beverage_offering:qloo:beer",
  "urn:tag:beverage_offering:qloo:wine",
  "urn:tag:category:place:distillery",
  "urn:tag:category:place:brewery",
  "urn:tag:category:place:wine_bar",
] as const;
