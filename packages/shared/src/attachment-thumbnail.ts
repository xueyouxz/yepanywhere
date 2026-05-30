export const THUMBNAIL_HEIGHT_PX = 32;
export const THUMBNAIL_MAX_ASPECT_RATIO = 2;
export const THUMBNAIL_MIME_TYPE = "image/png";

export interface ThumbnailPlan {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  croppedWide: boolean;
}

export function planThumbnail(
  sourceWidth: number,
  sourceHeight: number,
): ThumbnailPlan {
  const sourceAspectRatio = sourceWidth / sourceHeight;
  const croppedWide = sourceAspectRatio > THUMBNAIL_MAX_ASPECT_RATIO;
  const sourceHeightCrop = sourceHeight;
  const sourceWidthCrop = croppedWide
    ? sourceHeightCrop * THUMBNAIL_MAX_ASPECT_RATIO
    : sourceWidth;
  const sourceX = croppedWide
    ? Math.max(0, Math.floor((sourceWidth - sourceWidthCrop) / 2))
    : 0;
  const sourceY = 0;
  const width = Math.max(
    1,
    Math.round((sourceWidthCrop / sourceHeightCrop) * THUMBNAIL_HEIGHT_PX),
  );
  const height = THUMBNAIL_HEIGHT_PX;

  return {
    sourceX,
    sourceY,
    sourceWidth: sourceWidthCrop,
    sourceHeight: sourceHeightCrop,
    width,
    height,
    croppedWide,
  };
}
