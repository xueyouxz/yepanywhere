import { memo, useEffect, useMemo, useState } from "react";
import { getFunPhrasesEnabled } from "../hooks/useFunPhrases";
import { ThinkingIndicator } from "./ThinkingIndicator";

const PROCESSING_PHRASES = [
  "Thinking...",
  "Processing...",
  "Cooking...",
  "Analyzing...",
  "Working on it...",
  "Pondering...",
  "Computing...",
  "Crafting...",
  "Mulling it over...",
  "On it...",
  "Crunching...",
  "Brewing...",
  "Conjuring...",
  "Synthesizing...",
  "Deliberating...",
  "Ruminating...",
  "Contemplating...",
  "Percolating...",
  "Cogitating...",
  "Noodling...",
];

const ROTATION_INTERVAL_MS = 2000;
const TYPEWRITER_SPEED_MS = 25; // ~40 chars/second = ~240 WPM

/** Fisher-Yates shuffle */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j] as T;
    result[j] = temp as T;
  }
  return result;
}

interface Props {
  isProcessing: boolean;
  thinkingItemsVisible?: boolean;
  hasThinkingItems?: boolean;
  onToggleThinkingItemsVisible?: () => void;
}

function ThoughtTranscriptIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      className="processing-thinking-toggle-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11.5c0 4-3.8 7.25-8.5 7.25-1.1 0-2.2-.18-3.15-.52L4 20l1.2-3.25C3.85 15.42 3 13.58 3 11.5 3 7.5 6.8 4.25 11.5 4.25S20 7.5 20 11.5Z" />
      <path d="M8.5 11.5h.01" />
      <path d="M11.5 11.5h.01" />
      <path d="M14.5 11.5h.01" />
      {muted && (
        <path className="processing-thinking-toggle-slash" d="M4 20 20 4" />
      )}
    </svg>
  );
}

export const ProcessingIndicator = memo(function ProcessingIndicator({
  isProcessing,
  thinkingItemsVisible = true,
  hasThinkingItems = false,
  onToggleThinkingItemsVisible,
}: Props) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const showThinkingToggle = Boolean(
    onToggleThinkingItemsVisible && (isProcessing || hasThinkingItems),
  );

  // Check setting and shuffle phrases when processing starts
  const phrases = useMemo(() => {
    if (!isProcessing) return ["Thinking..."];
    const funEnabled = getFunPhrasesEnabled();
    if (!funEnabled) return ["Thinking..."];
    return shuffle(PROCESSING_PHRASES);
  }, [isProcessing]);

  // Rotate phrases
  useEffect(() => {
    if (!isProcessing) {
      setPhraseIndex(0);
      setDisplayedText("");
      setIsTyping(true);
      return;
    }

    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % phrases.length);
      setIsTyping(true);
      setDisplayedText("");
    }, ROTATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isProcessing, phrases.length]);

  // Typewriter effect
  useEffect(() => {
    if (!isProcessing || !isTyping) return;

    const phrase = phrases[phraseIndex] ?? "";
    if (displayedText.length >= phrase.length) {
      setIsTyping(false);
      return;
    }

    const timeout = setTimeout(() => {
      setDisplayedText(phrase.slice(0, displayedText.length + 1));
    }, TYPEWRITER_SPEED_MS);

    return () => clearTimeout(timeout);
  }, [isProcessing, isTyping, phraseIndex, displayedText, phrases]);

  if (!isProcessing && !showThinkingToggle) {
    return null;
  }

  const thinkingToggleTitle = thinkingItemsVisible
    ? "Hide thinking transcript"
    : hasThinkingItems
      ? "Show hidden thinking transcript"
      : "Show thinking transcript";

  return (
    <div
      className={`processing-indicator ${
        !isProcessing ? "processing-indicator--control-only" : ""
      } ${!thinkingItemsVisible && hasThinkingItems ? "processing-indicator--thinking-hidden" : ""}`}
    >
      {showThinkingToggle && (
        <button
          type="button"
          className={`processing-thinking-toggle ${
            thinkingItemsVisible ? "is-visible" : "is-muted"
          }`}
          onClick={onToggleThinkingItemsVisible}
          aria-pressed={thinkingItemsVisible}
          aria-label={thinkingToggleTitle}
          title={thinkingToggleTitle}
        >
          <ThoughtTranscriptIcon muted={!thinkingItemsVisible} />
        </button>
      )}
      {isProcessing && (
        <>
          <div className="processing-dot-container">
            <ThinkingIndicator />
          </div>
          <span className="processing-text">
            {displayedText}
            <span className="processing-cursor">|</span>
          </span>
        </>
      )}
    </div>
  );
});
