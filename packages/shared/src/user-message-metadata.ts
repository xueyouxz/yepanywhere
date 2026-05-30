export type UserMessageDeliveryIntent =
  | "direct"
  | "steer"
  | "deferred"
  | "patient";

export interface UserMessageCompositionMetadata {
  typingStartedAt?: string;
  typingEndedAt?: string;
  lastEditedAt?: string;
  submittedAt?: string;
}

export interface UserMessageMetadata {
  deliveryIntent?: UserMessageDeliveryIntent;
  composition?: UserMessageCompositionMetadata;
  /** Browser-side request timestamp in server-clock epoch ms, when supplied. */
  clientTimestamp?: number;
  /** Server receive time for the REST request that accepted this user turn. */
  serverReceivedAt?: string;
}
