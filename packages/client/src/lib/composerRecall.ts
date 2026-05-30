import type { DeferredMessage } from "../hooks/useSession";

export type SentComposerSubmission = { kind: "sent"; text: string; id: string };
export type QueuedComposerSubmission = {
  kind: "queued";
  text: string;
  tempId: string;
};
export type LastComposerSubmission =
  | SentComposerSubmission
  | QueuedComposerSubmission;

export function getRecallSubmissionAfterQueuedCancel(
  current: LastComposerSubmission | null,
  lastSent: SentComposerSubmission | null,
  deferredMessages: DeferredMessage[],
  cancelledTempId: string,
): LastComposerSubmission | null {
  if (current?.kind !== "queued" || current.tempId !== cancelledTempId) {
    return current;
  }

  const latestRemainingQueued = [...deferredMessages]
    .reverse()
    .find(
      (message) =>
        message.tempId &&
        message.tempId !== cancelledTempId &&
        message.deliveryState !== "sending" &&
        message.content.trim(),
    );

  if (latestRemainingQueued?.tempId) {
    return {
      kind: "queued",
      text: latestRemainingQueued.content,
      tempId: latestRemainingQueued.tempId,
    };
  }

  return lastSent;
}
