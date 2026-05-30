import type { RenderItem } from "../types/renderItems";

function getRenderItemKey(item: RenderItem): string {
  return `${item.type}:${item.id}`;
}

function sameArrayItems<T>(
  previous: readonly T[],
  next: readonly T[],
): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function sameSourceMessages(previous: RenderItem, next: RenderItem): boolean {
  return sameArrayItems(previous.sourceMessages, next.sourceMessages);
}

export function canReuseRenderItem(
  previous: RenderItem,
  next: RenderItem,
): boolean {
  if (
    previous.type !== next.type ||
    previous.id !== next.id ||
    previous.isSubagent !== next.isSubagent ||
    !sameSourceMessages(previous, next)
  ) {
    return false;
  }

  switch (previous.type) {
    case "text":
      return (
        next.type === "text" &&
        previous.text === next.text &&
        previous.isStreaming === next.isStreaming &&
        previous.augmentHtml === next.augmentHtml
      );

    case "thinking":
      return (
        next.type === "thinking" &&
        previous.thinking === next.thinking &&
        previous.signature === next.signature &&
        previous.status === next.status
      );

    case "tool_call":
      return (
        next.type === "tool_call" &&
        previous.toolName === next.toolName &&
        previous.toolInput === next.toolInput &&
        previous.toolResult === next.toolResult &&
        previous.status === next.status
      );

    case "user_prompt":
      return next.type === "user_prompt" && previous.content === next.content;

    case "session_setup":
      return (
        next.type === "session_setup" &&
        previous.title === next.title &&
        sameArrayItems(previous.prompts, next.prompts)
      );

    case "system":
      return (
        next.type === "system" &&
        previous.subtype === next.subtype &&
        previous.content === next.content &&
        previous.status === next.status &&
        previous.configChanged === next.configChanged
      );
  }
}

export function stabilizeRenderItems(
  previousItems: readonly RenderItem[],
  nextItems: readonly RenderItem[],
): RenderItem[] {
  if (previousItems.length === 0 || nextItems.length === 0) {
    return [...nextItems];
  }

  const previousByKey = new Map<string, RenderItem[]>();
  for (const item of previousItems) {
    const key = getRenderItemKey(item);
    const bucket = previousByKey.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      previousByKey.set(key, [item]);
    }
  }

  return nextItems.map((nextItem) => {
    const candidates = previousByKey.get(getRenderItemKey(nextItem));
    if (!candidates) {
      return nextItem;
    }

    const index = candidates.findIndex((candidate) =>
      canReuseRenderItem(candidate, nextItem),
    );
    if (index === -1) {
      return nextItem;
    }

    const [reused] = candidates.splice(index, 1);
    return reused ?? nextItem;
  });
}
