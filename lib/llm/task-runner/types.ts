import type { LlmRetryProfile } from "../clients";
import {
  LLM_TASK_TYPES,
  type LlmTaskPayload,
} from "../task-types";

export type JsonRecord = Record<string, unknown>;

export type RunLlmTaskOptions = {
  retryProfile?: LlmRetryProfile;
};

export type AnalyticsGenerateDescriptionsTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.analyticsGenerateDescriptions }
>;

export type AdCopyGenerateTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.adCopyGenerate }
>;

export type AdCopyVideoGenerateTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.adCopyVideoGenerate }
>;

export type AskAdceroTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.askAdcero }
>;

export type GoogleAssetsGenerateTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.googleAssetsGenerate }
>;

export type GoogleDescriptionSuggestTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.googleDescriptionSuggest }
>;

export type PolicyCheckTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.policyCheck }
>;

export type PolicyCheckVideoTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.policyCheckVideo }
>;

export type WidgetChatTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.widgetChat }
>;

export type ReportBuilderNarrativeTask = Extract<
  LlmTaskPayload,
  { taskType: typeof LLM_TASK_TYPES.reportBuilderNarrative }
>;
