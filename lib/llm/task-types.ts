export const LLM_TASK_JOB_TYPE = "llm_task";

export const LLM_TASK_TYPES = {
  analyticsGenerateDescriptions: "analytics_generate_descriptions",
  adCopyGenerate: "adcopy_generate",
  adCopyVideoGenerate: "adcopy_video_generate",
  askAdcero: "ask_adcero",
  googleAssetsGenerate: "google_assets_generate",
  googleDescriptionSuggest: "google_description_suggest",
  policyCheck: "policy_check",
  policyCheckVideo: "policy_check_video",
  widgetChat: "widget_chat",
  reportBuilderNarrative: "report_builder_narrative",
} as const;

export type LlmTaskType =
  (typeof LLM_TASK_TYPES)[keyof typeof LLM_TASK_TYPES];

type AnalyticsChartGroup = {
  chartId: string;
  title: string;
  metrics: Array<{ label: string; value: string }>;
};

type AdCopyFrameworkPayload = {
  framework: string;
  productName?: string;
  websiteUrl?: string;
  campaignObjective?: string;
  targetAudience?: string;
  additionalContext?: string;
  brandSummary?: object | null;
  creativeUrl?: string;
  isVideo?: boolean;
  callToAction?: string;
};

type VideoAdCopyPayload = {
  framework: string;
  videoUrl: string;
  productName?: string;
  campaignObjective?: string;
  additionalContext?: string;
  brandSummary?: object | null;
  callToAction?: string;
};

type PolicyContentPayload = {
  primaryText?: string;
  headline?: string;
  description?: string;
  websiteUrl?: string;
  callToAction?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
};

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessagePayload = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[];
  tool_call_id?: string;
  tool_calls?: unknown[];
};

type WidgetMessagePayload = {
  role: "user" | "assistant";
  content: string;
};

/** Real-data context the report-builder narrative generator writes from. */
type ReportNarrativeContext = {
  reportTitle?: string;
  dateRange?: string;
  platform?: string;
  currencyCode?: string;
  /** Headline KPIs for the report's scope. */
  kpis?: Array<{ label: string; value: string; change?: string; up?: boolean }>;
  /** Top campaigns by spend for the period, each with the metric columns the
   * report's campaign table displays (e.g. Spend/Leads, or Spend/ROAS). */
  topCampaigns?: Array<{
    name: string;
    metrics?: Array<{ label: string; value: string }>;
  }>;
  /** Section headings / block labels in scope (what this narrative should cover). */
  outline?: string[];
  /** The block's current text, when the user is refining rather than starting fresh. */
  existingText?: string;
  /** What slice of the report to focus on (a section heading, or "the section above"). */
  focus?: string;
  /** Extra instructions the user entered in the prompt modal before generating. */
  additionalPrompt?: string;
};

interface LlmTaskBase {
  taskType: LlmTaskType;
  dedupeKey: string;
  source?: string;
}

export type LlmTaskPayload =
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.analyticsGenerateDescriptions;
      organizationId: string;
      metrics: Array<{ id: string; label: string; value?: string }>;
      chartGroups?: AnalyticsChartGroup[];
      mode?: "definitions" | "analysis";
      context?: string;
      provider?: string;
      dateRange?: string;
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.adCopyGenerate;
      input: AdCopyFrameworkPayload;
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.adCopyVideoGenerate;
      input: VideoAdCopyPayload;
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.askAdcero;
      messages: ChatMessagePayload[];
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.googleAssetsGenerate;
      input: {
        type: "headlines" | "longHeadlines" | "descriptions";
        count: number;
        businessName?: string;
        finalUrl?: string;
        existing?: string[];
        examples?: string[];
      };
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.googleDescriptionSuggest;
      input: {
        url: string;
        pageText: string;
      };
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.policyCheck;
      input: {
        platform: "meta" | "tiktok" | "google";
        content: PolicyContentPayload;
        industry?: string;
        checkType?: "quick" | "comprehensive";
      };
      /** Non-English answer language (i18n D10), resolved by the route; absent for English. */
      locale?: string;
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.policyCheckVideo;
      input: {
        videoUrl: string;
        platform: "meta" | "tiktok" | "google";
        industry?: string;
        adContent?: {
          primaryText?: string;
          headline?: string;
        };
      };
      /** Non-English answer language (i18n D10), resolved by the route; absent for English. */
      locale?: string;
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.widgetChat;
      messages: WidgetMessagePayload[];
      pageContext?: string;
      /** Non-English answer language (i18n D10); absent for English. */
      locale?: string;
    })
  | (LlmTaskBase & {
      taskType: typeof LLM_TASK_TYPES.reportBuilderNarrative;
      organizationId: string;
      /** Which narrative block is being written. */
      section: "summary-paragraph" | "callout";
      /** Callout emotional tone (drives whether it celebrates, flags, or informs). */
      tone?: "info" | "success" | "warning";
      context: ReportNarrativeContext;
    });
