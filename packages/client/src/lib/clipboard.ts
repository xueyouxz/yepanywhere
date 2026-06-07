export async function writeClipboardText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text that is not available yet (it arrives from a server round-trip).
 * Passing the pending value as a Promise lets us invoke navigator.clipboard
 * .write() synchronously inside the click handler, so the browser captures the
 * current user-activation immediately and completes the write once the value
 * resolves. writeClipboardText() cannot do this: it has to be awaited after the
 * value is known, by which point a slow round-trip (relay hop, large frozen
 * snapshot) can outlive the ~5s activation window and the write is rejected as a
 * permission error. Falls back to the writeText path where ClipboardItem write
 * is unavailable (older browsers, jsdom tests).
 */
export async function writeClipboardTextLater(
  text: Promise<string>,
): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      "text/plain": text.then(
        (value) => new Blob([value], { type: "text/plain" }),
      ),
    });
    try {
      // write() is invoked synchronously here, before the await suspends, so the
      // current user-activation is captured even though the value resolves later.
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      return writeResolvedClipboardText(text);
    }
  }
  return writeResolvedClipboardText(text);
}

async function writeResolvedClipboardText(
  text: Promise<string>,
): Promise<boolean> {
  try {
    return await writeClipboardText(await text);
  } catch {
    return false;
  }
}
