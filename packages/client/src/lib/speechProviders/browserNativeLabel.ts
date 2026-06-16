/**
 * UA-based support metadata for the browser-native speech recognizer.
 *
 * The Web Speech API doesn't tell us which backend the browser uses, so the UI
 * renders the recognizer simply as "Browser" and keeps backend guesses out of
 * the STT method label.
 */

export interface BrowserNativeLabel {
  /** "Browser" — always present, never styled as uncertain. */
  prefix: string;
  /** Detected browser name, e.g. "Chrome", "Safari". Empty if unknown. */
  browser: string;
  /** Best-guess underlying recognizer, e.g. "Google STT". Empty if unknown. */
  recognizerGuess: string;
  /** True if this browser likely supports Web Speech recognition. */
  likelySupported: boolean;
}

export function detectBrowserNativeLabel(
  userAgent: string = typeof navigator !== "undefined"
    ? navigator.userAgent
    : "",
): BrowserNativeLabel {
  const ua = userAgent;

  if (!ua) {
    return {
      prefix: "Browser",
      browser: "",
      recognizerGuess: "",
      likelySupported: false,
    };
  }

  // Order matters: Edg before Chrome, OPR before Chrome, etc.
  if (/Edg\//.test(ua)) {
    return {
      prefix: "Browser",
      browser: "Edge",
      recognizerGuess: "Microsoft / Bing",
      likelySupported: true,
    };
  }
  if (/OPR\/|Opera/.test(ua)) {
    return {
      prefix: "Browser",
      browser: "Opera",
      recognizerGuess: "Google STT",
      likelySupported: true,
    };
  }
  if (/SamsungBrowser/.test(ua)) {
    return {
      prefix: "Browser",
      browser: "Samsung Internet",
      recognizerGuess: "Samsung",
      likelySupported: true,
    };
  }
  if (/Chrome\//.test(ua)) {
    return {
      prefix: "Browser",
      browser: "Chrome",
      recognizerGuess: "Google STT",
      likelySupported: true,
    };
  }
  // Safari check must follow Chrome (Chrome UA also contains "Safari").
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) {
    return {
      prefix: "Browser",
      browser: "Safari",
      recognizerGuess: "Apple",
      likelySupported: true,
    };
  }
  if (/Firefox\//.test(ua)) {
    return {
      prefix: "Browser",
      browser: "Firefox",
      recognizerGuess: "",
      likelySupported: false,
    };
  }

  return {
    prefix: "Browser",
    browser: "",
    recognizerGuess: "",
    likelySupported: false,
  };
}

export function formatBrowserNativeLabel(label: BrowserNativeLabel): string {
  return label.prefix;
}
