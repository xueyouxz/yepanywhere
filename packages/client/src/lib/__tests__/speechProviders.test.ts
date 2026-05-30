import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_METHOD,
  getOrderedServerSpeechBackends,
  getPreferredSpeechMethod,
  getSpeechMethods,
  resolveSpeechMethod,
} from "../speechProviders/methods";

describe("speech provider method selection", () => {
  it("uses advertised server backends directly and orders preferred cloud STT first", () => {
    expect(
      getOrderedServerSpeechBackends([
        "ya-deepgram",
        "ya-whisper",
        "ya-grok",
        "ya-grok",
      ]),
    ).toEqual(["ya-grok", "ya-deepgram", "ya-whisper"]);
  });

  it("does not require client-side backend hardcodes to build selector options", () => {
    expect(getSpeechMethods(["ya-custom-stt"]).map((method) => method.id)).toEqual(
      ["ya-custom-stt", DEFAULT_SPEECH_METHOD],
    );
  });

  it("prefers Grok over Deepgram when no explicit user method is stored", () => {
    expect(getPreferredSpeechMethod(["ya-deepgram", "ya-grok"])).toBe("ya-grok");
    expect(
      resolveSpeechMethod(
        DEFAULT_SPEECH_METHOD,
        ["ya-deepgram", "ya-grok"],
        false,
      ),
    ).toBe("ya-grok");
  });

  it("keeps explicit choices only while they are still available", () => {
    expect(resolveSpeechMethod("ya-deepgram", ["ya-grok", "ya-deepgram"], true)).toBe(
      "ya-deepgram",
    );
    expect(resolveSpeechMethod(DEFAULT_SPEECH_METHOD, ["ya-grok"], true)).toBe(
      DEFAULT_SPEECH_METHOD,
    );
    expect(resolveSpeechMethod("ya-deepgram", ["ya-grok"], true)).toBe(
      DEFAULT_SPEECH_METHOD,
    );
  });
});
