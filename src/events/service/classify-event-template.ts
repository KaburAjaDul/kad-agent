import { SEEDED_EVENT_TEMPLATE_POLICIES } from "../config/seeded-event-template-policies.js";
import type { EventPolicyDecision } from "../types/event-policy.js";

export function classifyEventTemplate(templateKey: string): EventPolicyDecision {
  const matchedTemplate = SEEDED_EVENT_TEMPLATE_POLICIES.find((template) => template.templateKey === templateKey);

  if (!matchedTemplate) {
    return {
      templateKey,
      approvalClass: "hard_stop",
      reason: "Unsupported template key. Milestone 0 only allows seeded event templates."
    };
  }

  return {
    templateKey,
    eventType: matchedTemplate.eventType,
    approvalClass: matchedTemplate.approvalClass,
    classification: matchedTemplate.classification
  };
}
