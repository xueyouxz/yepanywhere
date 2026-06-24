interface VoiceShortcutEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function isVoiceInputShortcut(event: VoiceShortcutEvent): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === "Space" || event.key === " " || event.key === "Spacebar")
  );
}
