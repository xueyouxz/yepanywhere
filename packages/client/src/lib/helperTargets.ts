import {
  HELPER_SIDE_MODEL_TARGET_PREFIX,
  type HelperTargetConfig,
  type ModelInfo,
} from "@yep-anywhere/shared";

export function helperTargetValue(
  target: Pick<HelperTargetConfig, "id">,
): string {
  return `${HELPER_SIDE_MODEL_TARGET_PREFIX}${target.id}`;
}

export function helperTargetDescription(target: HelperTargetConfig): string {
  const model = target.model?.trim() || "endpoint default";
  return `OpenAI-compatible - ${model} - ${target.baseUrl}`;
}

export function helperTargetsToModelOptions(
  targets: readonly HelperTargetConfig[] | undefined,
): ModelInfo[] {
  return (targets ?? []).map((target) => ({
    id: helperTargetValue(target),
    name: target.name,
    description: helperTargetDescription(target),
  }));
}
