import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type AttachmentUploadQuality = "sd" | "hd";

const DEFAULT_ATTACHMENT_UPLOAD_QUALITY: AttachmentUploadQuality = "sd";

const QUALITY_LONG_EDGE_PX: Record<AttachmentUploadQuality, number> = {
  sd: 1024,
  hd: 2048,
};

function readAttachmentUploadQuality(): AttachmentUploadQuality {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.getItem !== "function"
  ) {
    return DEFAULT_ATTACHMENT_UPLOAD_QUALITY;
  }
  const stored = localStorage.getItem(UI_KEYS.attachmentUploadQuality);
  return stored === "sd" || stored === "hd"
    ? stored
    : DEFAULT_ATTACHMENT_UPLOAD_QUALITY;
}

export function useAttachmentUploadQuality(): [
  AttachmentUploadQuality,
  (quality: AttachmentUploadQuality) => void,
] {
  const [quality, setQuality] = useState<AttachmentUploadQuality>(() =>
    readAttachmentUploadQuality(),
  );

  useEffect(() => {
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.setItem !== "function"
    ) {
      return;
    }
    localStorage.setItem(UI_KEYS.attachmentUploadQuality, quality);
  }, [quality]);

  const setAttachmentUploadQuality = useCallback(
    (nextQuality: AttachmentUploadQuality) => {
      setQuality(nextQuality);
      if (
        typeof localStorage !== "undefined" &&
        typeof localStorage.setItem === "function"
      ) {
        localStorage.setItem(UI_KEYS.attachmentUploadQuality, nextQuality);
      }
    },
    [],
  );

  return [quality, setAttachmentUploadQuality];
}

export function getAttachmentUploadLongEdgePx(
  quality: AttachmentUploadQuality,
): number {
  return QUALITY_LONG_EDGE_PX[quality];
}
