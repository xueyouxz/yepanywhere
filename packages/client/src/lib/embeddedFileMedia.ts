import type { FileContentResponse } from "@yep-anywhere/shared";

export function getEmbeddedFileMediaBlob(
  fileData: FileContentResponse,
  filePath: string,
): Blob | null {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const embedded =
    fileData.embeddedMedia?.[filePath] ??
    fileData.embeddedMedia?.[normalizedPath];
  if (!embedded) {
    return null;
  }

  const binary = atob(embedded.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: embedded.mimeType });
}
