import type { IndustryKey } from './industries';

/**
 * Inert per-industry vocabulary tables (LLM-drafted, human-reviewed) backing
 * lib/brand-identity/industry-taxonomy.ts. Pure data — every lookup/validation
 * helper lives in industry-taxonomy.ts, which is the module consumers import.
 *
 * Authoring rules:
 * - Angle keys are snake_case machine values stored in `ad_labels.angle`; keep
 *   each list to the ~6-10 motivations that genuinely differentiate creative
 *   in that vertical (`UNIVERSAL_CORE_ANGLES` are appended by the helpers).
 * - Persona keys are stored in `ad_labels.persona`; keep each list to the ~4-8
 *   audiences a paid-social analyst would recognise in that vertical. Separate
 *   concept from the creative-engine genome's freeform `persona` field — do
 *   NOT couple to lib/creative-engine.
 * - The *_LABELS maps hold human-readable display labels; values absent here
 *   fall back to Title Case of the snake_case key.
 */

export const INDUSTRY_ANGLES: Record<IndustryKey, readonly string[]> = {
  accessories: [
    'everyday_versatility',
    'style_upgrade',
    'organization',
    'gifting',
    'durability',
    'self_expression',
  ],
  automotive: [
    'performance',
    'safety',
    'convenience',
    'protection',
    'tech_innovation',
    'value_retention',
    'lifestyle',
  ],
  beauty: [
    'transformation',
    'anti_aging',
    'natural_ingredients',
    'glow_radiance',
    'problem_skin',
    'self_care',
    'cruelty_free',
    'results_speed',
  ],
  jewelry: [
    'gifting',
    'milestone_occasion',
    'heirloom',
    'craftsmanship',
    'ethics_provenance',
    'self_reward',
    'everyday_luxury',
    'personalization',
  ],
  shoes: [
    'comfort',
    'performance',
    'style_statement',
    'durability',
    'versatility',
    'support_health',
  ],
  clothing: [
    'fit_flattering',
    'style_trend',
    'comfort',
    'versatility',
    'sustainability',
    'self_expression',
    'occasion_dressing',
  ],
  electronics: [
    'performance_power',
    'innovation',
    'convenience',
    'reliability',
    'ecosystem',
    'portability',
    'design',
  ],
  sport: [
    'performance',
    'motivation',
    'recovery',
    'durability',
    'community',
    'results_transformation',
  ],
  food: [
    'taste_indulgence',
    'health_nutrition',
    'convenience',
    'natural_clean',
    'craving',
    'dietary_fit',
  ],
  gaming: [
    'immersion',
    'competition',
    'social_play',
    'exclusivity',
    'nostalgia',
    'performance',
  ],
  health: [
    'symptom_relief',
    'prevention',
    'energy_vitality',
    'natural_ingredients',
    'clinically_backed',
    'convenience',
    'results_speed',
  ],
  home: [
    'comfort_coziness',
    'aesthetics_decor',
    'space_saving',
    'durability',
    'convenience',
    'sustainability',
  ],
  pets: [
    'pet_health',
    'pet_happiness',
    'convenience',
    'natural_ingredients',
    'bonding',
    'safety',
  ],
  software: [
    'time_saving',
    'productivity',
    'automation',
    'cost_saving',
    'ease_of_use',
    'scalability',
    'security',
    'integration',
  ],
  books: [
    'knowledge_growth',
    'escapism',
    'inspiration',
    'self_improvement',
    'entertainment',
    'expertise',
  ],
  services: [
    'convenience',
    'expertise',
    'time_saving',
    'results_outcome',
    'trust_credibility',
    'personalization',
  ],
};

export const ANGLE_LABELS: Record<string, string> = {
  // Universal (global ANGLES)
  pain_relief: 'Pain relief',
  convenience: 'Convenience',
  price_value: 'Price / value',
  status: 'Status',
  health: 'Health',
  time_saving: 'Time saving',
  trust_safety: 'Trust / safety',
  other: 'Other',
  // Accessories
  everyday_versatility: 'Everyday versatility',
  style_upgrade: 'Style upgrade',
  organization: 'Organization',
  gifting: 'Gifting',
  durability: 'Durability',
  self_expression: 'Self-expression',
  // Automotive
  performance: 'Performance',
  safety: 'Safety',
  protection: 'Protection',
  tech_innovation: 'Tech innovation',
  value_retention: 'Value retention',
  lifestyle: 'Lifestyle',
  // Beauty
  transformation: 'Transformation',
  anti_aging: 'Anti-aging',
  natural_ingredients: 'Natural ingredients',
  glow_radiance: 'Glow / radiance',
  problem_skin: 'Problem skin',
  self_care: 'Self-care',
  cruelty_free: 'Cruelty-free',
  results_speed: 'Fast results',
  // Jewelry
  milestone_occasion: 'Milestone / occasion',
  heirloom: 'Heirloom',
  craftsmanship: 'Craftsmanship',
  ethics_provenance: 'Ethics / provenance',
  self_reward: 'Self-reward',
  everyday_luxury: 'Everyday luxury',
  personalization: 'Personalization',
  // Shoes
  comfort: 'Comfort',
  style_statement: 'Style statement',
  versatility: 'Versatility',
  support_health: 'Support / foot health',
  // Clothing
  fit_flattering: 'Flattering fit',
  style_trend: 'On-trend style',
  sustainability: 'Sustainability',
  occasion_dressing: 'Occasion dressing',
  // Electronics
  performance_power: 'Performance / power',
  innovation: 'Innovation',
  reliability: 'Reliability',
  ecosystem: 'Ecosystem',
  portability: 'Portability',
  design: 'Design',
  // Sport
  motivation: 'Motivation',
  recovery: 'Recovery',
  community: 'Community',
  results_transformation: 'Body transformation',
  // Food
  taste_indulgence: 'Taste / indulgence',
  health_nutrition: 'Health / nutrition',
  natural_clean: 'Natural / clean',
  craving: 'Craving',
  dietary_fit: 'Dietary fit',
  // Gaming
  immersion: 'Immersion',
  competition: 'Competition',
  social_play: 'Social play',
  exclusivity: 'Exclusivity',
  nostalgia: 'Nostalgia',
  // Health
  symptom_relief: 'Symptom relief',
  prevention: 'Prevention',
  energy_vitality: 'Energy / vitality',
  clinically_backed: 'Clinically backed',
  // Home
  comfort_coziness: 'Comfort / coziness',
  aesthetics_decor: 'Aesthetics / decor',
  space_saving: 'Space saving',
  // Pets
  pet_health: 'Pet health',
  pet_happiness: 'Pet happiness',
  bonding: 'Bonding',
  // Software
  productivity: 'Productivity',
  automation: 'Automation',
  cost_saving: 'Cost saving',
  ease_of_use: 'Ease of use',
  scalability: 'Scalability',
  security: 'Security',
  integration: 'Integration',
  // Books
  knowledge_growth: 'Knowledge / growth',
  escapism: 'Escapism',
  inspiration: 'Inspiration',
  self_improvement: 'Self-improvement',
  entertainment: 'Entertainment',
  expertise: 'Expertise',
  // Services
  results_outcome: 'Results / outcome',
  trust_credibility: 'Trust / credibility',
};

export const INDUSTRY_PERSONAS: Record<IndustryKey, readonly string[]> = {
  accessories: [
    'gift_buyers',
    'fashion_forward',
    'commuters_travelers',
    'minimalist_organizers',
    'trend_teens',
  ],
  automotive: [
    'new_car_owners',
    'diy_mechanics',
    'road_trippers',
    'off_road_enthusiasts',
    'safety_conscious_parents',
    'car_detailers',
  ],
  beauty: [
    'skincare_beginners',
    'anti_aging_shoppers',
    'acne_sufferers',
    'makeup_enthusiasts',
    'clean_beauty_seekers',
    'mature_skin',
  ],
  jewelry: [
    'gift_buyers',
    'engaged_couples',
    'self_purchase_women',
    'anniversary_shoppers',
    'milestone_celebrants',
    'everyday_stackers',
  ],
  shoes: [
    'runners_athletes',
    'comfort_seekers',
    'sneakerheads',
    'on_feet_all_day_workers',
    'fashion_shoppers',
    'foot_health_sufferers',
  ],
  clothing: [
    'fashion_forward_women',
    'value_family_shoppers',
    'activewear_buyers',
    'plus_size_shoppers',
    'sustainable_shoppers',
    'workwear_professionals',
  ],
  electronics: [
    'early_adopters',
    'gamers',
    'remote_workers',
    'audiophiles',
    'budget_upgraders',
    'content_creators',
  ],
  sport: [
    'gym_goers',
    'home_workout_parents',
    'endurance_athletes',
    'weight_loss_starters',
    'team_sport_players',
    'yoga_pilates_practitioners',
  ],
  food: [
    'busy_parents',
    'health_conscious_eaters',
    'snackers_cravers',
    'diet_specific_shoppers',
    'foodies',
    'meal_preppers',
  ],
  gaming: [
    'competitive_gamers',
    'casual_mobile_players',
    'pc_console_enthusiasts',
    'nostalgic_retro_gamers',
    'streamers_creators',
    'parents_buying_for_kids',
  ],
  health: [
    'chronic_symptom_sufferers',
    'preventive_wellness_seekers',
    'low_energy_adults',
    'fitness_supplement_users',
    'aging_adults',
    'sleep_stress_strugglers',
  ],
  home: [
    'new_homeowners',
    'renters_decorators',
    'small_space_dwellers',
    'diy_organizers',
    'comfort_seekers',
    'sustainable_householders',
  ],
  pets: [
    'new_pet_owners',
    'senior_pet_caregivers',
    'health_focused_pet_parents',
    'multi_pet_households',
    'anxious_pet_owners',
    'puppy_kitten_raisers',
  ],
  software: [
    'small_business_owners',
    'marketing_teams',
    'developers',
    'enterprise_it_buyers',
    'freelancers_solopreneurs',
    'operations_managers',
  ],
  books: [
    'lifelong_learners',
    'fiction_readers',
    'self_improvement_seekers',
    'parents_buying_for_kids',
    'professionals_upskilling',
    'hobbyists',
  ],
  services: [
    'time_strapped_professionals',
    'small_business_owners',
    'homeowners',
    'career_changers',
    'life_event_planners',
    'wellness_seekers',
  ],
};

export const PERSONA_LABELS: Record<string, string> = {
  // Universal (PERSONAS)
  parents_family: 'Parents / family',
  young_adults: 'Young adults',
  professionals: 'Professionals',
  midlife_adults: 'Midlife adults',
  seniors: 'Seniors',
  general_broad: 'General / broad',
  other: 'Other',
  // Curated industry personas with non-obvious casing
  diy_mechanics: 'DIY mechanics',
  off_road_enthusiasts: 'Off-road enthusiasts',
  self_purchase_women: 'Self-purchase women',
  on_feet_all_day_workers: 'On-feet-all-day workers',
  plus_size_shoppers: 'Plus-size shoppers',
  pc_console_enthusiasts: 'PC / console enthusiasts',
  small_business_owners: 'Small-business owners',
  enterprise_it_buyers: 'Enterprise IT buyers',
  freelancers_solopreneurs: 'Freelancers / solopreneurs',
  parents_buying_for_kids: 'Parents buying for kids',
  yoga_pilates_practitioners: 'Yoga / Pilates practitioners',
};

/**
 * Industry angle token → the stable global `ANGLES` member it rolls up to.
 *
 * The two-layer design (industry-taxonomy.ts) exists because the 8-value global
 * list is too coarse to differentiate creative inside a vertical. This map is
 * the deliberate lossy inverse: it lets a high-resolution token be COUNTED in
 * the cross-industry vocabulary the creative-engine genome and
 * `performance_memory` share, without pretending the resolution survives.
 *
 * `other` is a legal, honest answer. A motivation the global list has no bucket
 * for (`performance`, `immersion`, `taste_indulgence`, `nostalgia`, …) maps to
 * `other` rather than being forced into an adjacent bucket — a wrong universal
 * pools two unrelated arms and is strictly worse than an unpooled one. Expect a
 * meaningful `other` share on this dimension; the industry `angle` dimension is
 * where that resolution is preserved.
 *
 * Every value MUST be a member of `ANGLES` (pinned by test).
 */
export const ANGLE_UNIVERSAL_BY_TOKEN: Record<string, string> = {
  // Universal members map to themselves — keeps the lookup idempotent.
  pain_relief: 'pain_relief',
  convenience: 'convenience',
  price_value: 'price_value',
  status: 'status',
  health: 'health',
  time_saving: 'time_saving',
  trust_safety: 'trust_safety',
  other: 'other',
  // Accessories
  everyday_versatility: 'convenience',
  style_upgrade: 'status',
  organization: 'convenience',
  gifting: 'status',
  durability: 'trust_safety',
  self_expression: 'status',
  // Automotive
  performance: 'other',
  safety: 'trust_safety',
  protection: 'trust_safety',
  tech_innovation: 'other',
  value_retention: 'price_value',
  lifestyle: 'status',
  // Beauty
  transformation: 'pain_relief',
  anti_aging: 'health',
  natural_ingredients: 'health',
  glow_radiance: 'health',
  problem_skin: 'pain_relief',
  self_care: 'health',
  cruelty_free: 'trust_safety',
  results_speed: 'time_saving',
  // Jewelry
  milestone_occasion: 'status',
  heirloom: 'status',
  craftsmanship: 'status',
  ethics_provenance: 'trust_safety',
  self_reward: 'status',
  everyday_luxury: 'status',
  personalization: 'other',
  // Shoes
  comfort: 'pain_relief',
  style_statement: 'status',
  versatility: 'convenience',
  support_health: 'health',
  // Clothing
  fit_flattering: 'status',
  style_trend: 'status',
  sustainability: 'trust_safety',
  occasion_dressing: 'status',
  // Electronics
  performance_power: 'other',
  innovation: 'other',
  reliability: 'trust_safety',
  ecosystem: 'convenience',
  portability: 'convenience',
  design: 'status',
  // Sport
  motivation: 'other',
  recovery: 'health',
  community: 'other',
  results_transformation: 'health',
  // Food
  taste_indulgence: 'other',
  health_nutrition: 'health',
  natural_clean: 'health',
  craving: 'other',
  dietary_fit: 'health',
  // Gaming
  immersion: 'other',
  competition: 'other',
  social_play: 'other',
  exclusivity: 'status',
  nostalgia: 'other',
  // Health
  symptom_relief: 'pain_relief',
  prevention: 'health',
  energy_vitality: 'health',
  clinically_backed: 'trust_safety',
  // Home
  comfort_coziness: 'other',
  aesthetics_decor: 'status',
  space_saving: 'convenience',
  // Pets
  pet_health: 'health',
  pet_happiness: 'other',
  bonding: 'other',
  // Software
  productivity: 'time_saving',
  automation: 'time_saving',
  cost_saving: 'price_value',
  ease_of_use: 'convenience',
  scalability: 'other',
  security: 'trust_safety',
  integration: 'convenience',
  // Books
  knowledge_growth: 'other',
  escapism: 'other',
  inspiration: 'other',
  self_improvement: 'other',
  entertainment: 'other',
  expertise: 'trust_safety',
  // Services
  results_outcome: 'other',
  trust_credibility: 'trust_safety',
};

/**
 * Industry persona token → the stable global `PERSONAS` member it rolls up to.
 * Same posture as `ANGLE_UNIVERSAL_BY_TOKEN`.
 *
 * The global persona list is DEMOGRAPHIC (age/life-stage) while most industry
 * personas are behavioural (`meal_preppers`, `sneakerheads`, `diy_organizers`).
 * A behavioural persona with no age signal maps to `general_broad` — it really
 * does span ages — rather than being assigned a band the token never claimed.
 * Note `senior_pet_caregivers`: the SENIOR is the pet, so the owner is
 * `general_broad`, not `seniors`.
 *
 * Every value MUST be a member of `PERSONAS` (pinned by test).
 */
export const PERSONA_UNIVERSAL_BY_TOKEN: Record<string, string> = {
  // Universal members map to themselves.
  parents_family: 'parents_family',
  young_adults: 'young_adults',
  professionals: 'professionals',
  midlife_adults: 'midlife_adults',
  seniors: 'seniors',
  general_broad: 'general_broad',
  other: 'other',
  // Accessories
  gift_buyers: 'general_broad',
  fashion_forward: 'young_adults',
  commuters_travelers: 'professionals',
  minimalist_organizers: 'general_broad',
  trend_teens: 'young_adults',
  // Automotive
  new_car_owners: 'general_broad',
  diy_mechanics: 'general_broad',
  road_trippers: 'general_broad',
  off_road_enthusiasts: 'general_broad',
  safety_conscious_parents: 'parents_family',
  car_detailers: 'general_broad',
  // Beauty
  skincare_beginners: 'young_adults',
  anti_aging_shoppers: 'midlife_adults',
  acne_sufferers: 'young_adults',
  makeup_enthusiasts: 'young_adults',
  clean_beauty_seekers: 'general_broad',
  mature_skin: 'midlife_adults',
  // Jewelry
  engaged_couples: 'young_adults',
  self_purchase_women: 'general_broad',
  anniversary_shoppers: 'midlife_adults',
  milestone_celebrants: 'general_broad',
  everyday_stackers: 'young_adults',
  // Shoes
  runners_athletes: 'general_broad',
  comfort_seekers: 'general_broad',
  sneakerheads: 'young_adults',
  on_feet_all_day_workers: 'professionals',
  fashion_shoppers: 'young_adults',
  foot_health_sufferers: 'midlife_adults',
  // Clothing
  fashion_forward_women: 'young_adults',
  value_family_shoppers: 'parents_family',
  activewear_buyers: 'young_adults',
  plus_size_shoppers: 'general_broad',
  sustainable_shoppers: 'general_broad',
  workwear_professionals: 'professionals',
  // Electronics
  early_adopters: 'young_adults',
  gamers: 'young_adults',
  remote_workers: 'professionals',
  audiophiles: 'general_broad',
  budget_upgraders: 'general_broad',
  content_creators: 'young_adults',
  // Sport
  gym_goers: 'young_adults',
  home_workout_parents: 'parents_family',
  endurance_athletes: 'general_broad',
  weight_loss_starters: 'midlife_adults',
  team_sport_players: 'young_adults',
  yoga_pilates_practitioners: 'general_broad',
  // Food
  busy_parents: 'parents_family',
  health_conscious_eaters: 'general_broad',
  snackers_cravers: 'young_adults',
  diet_specific_shoppers: 'general_broad',
  foodies: 'general_broad',
  meal_preppers: 'professionals',
  // Gaming
  competitive_gamers: 'young_adults',
  casual_mobile_players: 'general_broad',
  pc_console_enthusiasts: 'young_adults',
  nostalgic_retro_gamers: 'midlife_adults',
  streamers_creators: 'young_adults',
  parents_buying_for_kids: 'parents_family',
  // Health
  chronic_symptom_sufferers: 'midlife_adults',
  preventive_wellness_seekers: 'general_broad',
  low_energy_adults: 'midlife_adults',
  fitness_supplement_users: 'young_adults',
  aging_adults: 'seniors',
  sleep_stress_strugglers: 'professionals',
  // Home
  new_homeowners: 'general_broad',
  renters_decorators: 'young_adults',
  small_space_dwellers: 'young_adults',
  diy_organizers: 'general_broad',
  sustainable_householders: 'general_broad',
  // Pets — the qualifier describes the PET, not the buyer.
  new_pet_owners: 'general_broad',
  senior_pet_caregivers: 'general_broad',
  health_focused_pet_parents: 'general_broad',
  multi_pet_households: 'general_broad',
  anxious_pet_owners: 'general_broad',
  puppy_kitten_raisers: 'general_broad',
  // Software
  small_business_owners: 'professionals',
  marketing_teams: 'professionals',
  developers: 'professionals',
  enterprise_it_buyers: 'professionals',
  freelancers_solopreneurs: 'professionals',
  operations_managers: 'professionals',
  // Books
  lifelong_learners: 'general_broad',
  fiction_readers: 'general_broad',
  self_improvement_seekers: 'general_broad',
  professionals_upskilling: 'professionals',
  hobbyists: 'general_broad',
  // Services
  time_strapped_professionals: 'professionals',
  homeowners: 'general_broad',
  career_changers: 'professionals',
  life_event_planners: 'general_broad',
  wellness_seekers: 'general_broad',
};
