// Campaign requirement specs - canonical source of truth.
// Docs: docs/campaign-requirements/

export interface AssetSpec {
  minCount: number;
  maxCount: number;
  minCharacters?: number;
  maxCharacters?: number;
  requiredShortMaxCharacters?: number;
  minWidth?: number;
  minHeight?: number;
  recommendedWidth?: number;
  recommendedHeight?: number;
  maxFileSizeBytes?: number;
  aspectRatio?: string;
}

export interface CampaignTypeRequirements {
  channelType: string;
  channelSubType?: string;
  validBiddingStrategies: string[];
  requiredAssets: Record<string, AssetSpec>;
  optionalAssets: Record<string, AssetSpec>;
  rules: string[];
}

const IMG_5MB = 5_242_880;
const LANDSCAPE = {
  minWidth: 600,
  minHeight: 314,
  recommendedWidth: 1200,
  recommendedHeight: 628,
  aspectRatio: "1.91:1",
  maxFileSizeBytes: IMG_5MB,
} as const;
const SQUARE = {
  minWidth: 300,
  minHeight: 300,
  recommendedWidth: 1200,
  recommendedHeight: 1200,
  aspectRatio: "1:1",
  maxFileSizeBytes: IMG_5MB,
} as const;
const LOGO = {
  minWidth: 128,
  minHeight: 128,
  recommendedWidth: 1200,
  recommendedHeight: 1200,
  aspectRatio: "1:1",
  maxFileSizeBytes: IMG_5MB,
} as const;

export const SEARCH_REQUIREMENTS: CampaignTypeRequirements = {
  channelType: "SEARCH",
  validBiddingStrategies: [
    "MANUAL_CPC",
    "MAXIMIZE_CLICKS",
    "MAXIMIZE_CONVERSIONS",
    "MAXIMIZE_CONVERSION_VALUE",
    "TARGET_IMPRESSION_SHARE",
  ],
  requiredAssets: {
    headlines: { minCount: 3, maxCount: 15, maxCharacters: 30 },
    descriptions: { minCount: 2, maxCount: 4, maxCharacters: 90 },
    finalUrl: { minCount: 1, maxCount: 1, maxCharacters: 2048 },
    keywords: { minCount: 1, maxCount: 20_000, maxCharacters: 80 },
  },
  optionalAssets: {
    displayPath1: { minCount: 0, maxCount: 1, maxCharacters: 15 },
    displayPath2: { minCount: 0, maxCount: 1, maxCharacters: 15 },
    sitelinks: { minCount: 0, maxCount: 20, maxCharacters: 25 },
    callouts: { minCount: 0, maxCount: 20, maxCharacters: 25 },
  },
  rules: [
    "Ad group type must be SEARCH_STANDARD",
    "RSA needs at least 3 headlines and 2 descriptions",
    "Each keyword needs a match type: EXACT, PHRASE, or BROAD",
    "Campaign won't serve without at least one keyword",
  ],
};

export const PMAX_REQUIREMENTS: CampaignTypeRequirements = {
  channelType: "PERFORMANCE_MAX",
  validBiddingStrategies: ["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"],
  requiredAssets: {
    headlines: { minCount: 3, maxCount: 15, minCharacters: 1, maxCharacters: 30 },
    longHeadlines: { minCount: 1, maxCount: 5, minCharacters: 1, maxCharacters: 90 },
    descriptions: {
      minCount: 2,
      maxCount: 5,
      minCharacters: 1,
      maxCharacters: 90,
      requiredShortMaxCharacters: 60,
    },
    businessName: { minCount: 1, maxCount: 1, minCharacters: 1, maxCharacters: 25 },
    landscapeImage: { minCount: 1, maxCount: 20, ...LANDSCAPE },
    squareImage: { minCount: 1, maxCount: 20, ...SQUARE },
    logo: { minCount: 1, maxCount: 5, ...LOGO },
  },
  optionalAssets: {
    portraitImage: {
      minCount: 0,
      maxCount: 20,
      minWidth: 480,
      minHeight: 600,
      recommendedWidth: 960,
      recommendedHeight: 1200,
      aspectRatio: "4:5",
      maxFileSizeBytes: IMG_5MB,
    },
    landscapeLogo: {
      minCount: 0,
      maxCount: 5,
      minWidth: 512,
      minHeight: 128,
      recommendedWidth: 1200,
      recommendedHeight: 300,
      aspectRatio: "4:1",
      maxFileSizeBytes: IMG_5MB,
    },
    youtubeVideos: { minCount: 0, maxCount: 5 },
    callToAction: { minCount: 0, maxCount: 1 },
  },
  rules: [
    "Asset Group + Assets MUST be created in the same request",
    "Text assets: HEADLINE 3-15 at 30 chars, LONG_HEADLINE 1-5 at 90 chars, DESCRIPTION 2-5 at 90 chars with at least one <=60 chars, BUSINESS_NAME 1 at 25 chars",
    "Brand Guidelines accounts require brandGuidelinesEnabled + logo CampaignAssets",
    "Only MAXIMIZE_CONVERSIONS or MAXIMIZE_CONVERSION_VALUE bidding",
    "Asset creation order matters: assets first, then asset group assets",
  ],
};

export const SHOPPING_REQUIREMENTS: CampaignTypeRequirements = {
  channelType: "SHOPPING",
  validBiddingStrategies: [
    "MANUAL_CPC",
    "MAXIMIZE_CLICKS",
    "MAXIMIZE_CONVERSIONS",
    "MAXIMIZE_CONVERSION_VALUE",
    "TARGET_ROAS",
  ],
  requiredAssets: {
    merchantCenterId: { minCount: 1, maxCount: 1 },
    adGroups: { minCount: 1, maxCount: 1 },
  },
  optionalAssets: {
    feedLabel: { minCount: 0, maxCount: 1, maxCharacters: 20 },
  },
  rules: [
    "shopping_setting.merchant_id is required (linked Merchant Center)",
    "Listing group UNIT nodes require cpc_bid_micros (default 1_000_000)",
    "Language targeting is NOT supported (causes OPERATION_NOT_PERMITTED_FOR_CONTEXT)",
    "Ad is just { type: SHOPPING_PRODUCT_AD } - no creative assets needed",
    "TARGET_ROAS requires targetRoas field to be provided",
  ],
};

export const DISPLAY_REQUIREMENTS: CampaignTypeRequirements = {
  channelType: "DISPLAY",
  validBiddingStrategies: [
    "MAXIMIZE_CONVERSIONS",
    "MAXIMIZE_CLICKS",
    "TARGET_CPA",
    "MANUAL_CPC",
    "TARGET_ROAS",
    "MAXIMIZE_CONVERSION_VALUE",
  ],
  requiredAssets: {
    headlines: { minCount: 1, maxCount: 5, minCharacters: 1, maxCharacters: 30 },
    longHeadline: { minCount: 1, maxCount: 1, minCharacters: 1, maxCharacters: 90 },
    descriptions: { minCount: 1, maxCount: 5, minCharacters: 1, maxCharacters: 90 },
    businessName: { minCount: 1, maxCount: 1, minCharacters: 1, maxCharacters: 25 },
    landscapeImage: { minCount: 1, maxCount: 15, ...LANDSCAPE },
    squareImage: { minCount: 1, maxCount: 15, ...SQUARE },
    finalUrl: { minCount: 1, maxCount: 1, minCharacters: 1, maxCharacters: 2048 },
  },
  optionalAssets: {
    logo: { minCount: 0, maxCount: 5, ...LOGO },
    callToAction: { minCount: 0, maxCount: 1, maxCharacters: 15 },
    pricePrefix: { minCount: 0, maxCount: 1, maxCharacters: 10 },
  },
  rules: [
    "Ad group type is DISPLAY_STANDARD",
    "Both marketing_images (landscape) and square_marketing_images are required",
    "Logo images are optional for responsive display ads",
    "negativeGeoTargetType: PRESENCE_OR_INTEREST is invalid for Display",
    "Images must be pre-existing account assets referenced by resource name",
    "long_headline is a single text string (not an array)",
  ],
};

export const DEMANDGEN_REQUIREMENTS: CampaignTypeRequirements = {
  channelType: "DEMAND_GEN",
  validBiddingStrategies: [
    "MAXIMIZE_CLICKS",
    "TARGET_CPC",
    "MAXIMIZE_CONVERSIONS",
    "TARGET_CPA",
    "MAXIMIZE_CONVERSION_VALUE",
    "TARGET_ROAS",
  ],
  requiredAssets: {
    headlines: { minCount: 1, maxCount: 5, maxCharacters: 30 },
    descriptions: { minCount: 1, maxCount: 5, maxCharacters: 90 },
    businessName: { minCount: 1, maxCount: 1, maxCharacters: 25 },
    finalUrl: { minCount: 1, maxCount: 1, maxCharacters: 2048 },
    logo: { minCount: 1, maxCount: 5, ...LOGO },
  },
  optionalAssets: {
    landscapeImage: { minCount: 0, maxCount: 20, ...LANDSCAPE },
    squareImage: { minCount: 0, maxCount: 20, ...SQUARE },
  },
  rules: [
    "adFormat must be MULTI_ASSET, CAROUSEL, VIDEO, or PRODUCT (not IMAGE)",
    "Clicks goal maps to MAXIMIZE_CLICKS, or TARGET_CPC when a target cost is set",
    "Do NOT set ad group type (causes INVALID_ARGUMENT in v22)",
    "Locations and languages MUST be at ad group level, not campaign level",
    "useAudienceGrouped is NOT a valid field on the ad group",
  ],
};

export const APP_REQUIREMENTS: CampaignTypeRequirements = {
  channelType: "MULTI_CHANNEL",
  channelSubType: "APP_CAMPAIGN",
  validBiddingStrategies: [
    "MAXIMIZE_CONVERSIONS",
    "TARGET_CPA",
    "MAXIMIZE_CONVERSION_VALUE",
    "TARGET_ROAS",
  ],
  requiredAssets: {
    headlines: { minCount: 1, maxCount: 20, maxCharacters: 30 },
    descriptions: { minCount: 1, maxCount: 20, maxCharacters: 90 },
    appId: { minCount: 1, maxCount: 1 },
  },
  optionalAssets: {
    imageAssets: { minCount: 0, maxCount: 20 },
    videoAssets: { minCount: 0, maxCount: 20 },
  },
  rules: [
    "App ID must be real (validated against Google Play / App Store at mutate time)",
    "Do NOT set ad_group.type (inferred from campaign subtype)",
    "Subtypes: APP_CAMPAIGN, APP_CAMPAIGN_FOR_ENGAGEMENT, APP_CAMPAIGN_FOR_PRE_REGISTRATION",
    "finalUrlSuffix is NOT supported for App campaigns",
    "Google auto-generates creatives from app store listing + provided text",
  ],
};

export const CAMPAIGN_REQUIREMENTS: Record<string, CampaignTypeRequirements> = {
  SEARCH: SEARCH_REQUIREMENTS,
  PERFORMANCE_MAX: PMAX_REQUIREMENTS,
  SHOPPING: SHOPPING_REQUIREMENTS,
  DISPLAY: DISPLAY_REQUIREMENTS,
  DEMAND_GEN: DEMANDGEN_REQUIREMENTS,
  APP: APP_REQUIREMENTS,
};
