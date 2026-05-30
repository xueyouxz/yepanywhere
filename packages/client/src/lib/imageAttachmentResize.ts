const RESIZABLE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const SD_JPEG_QUALITY = 0.9;

function getBaseFileName(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return fileName;
  }
  return fileName.slice(0, lastDot);
}

function getOutputMimeType(mimeType: string): string {
  if (!RESIZABLE_IMAGE_MIME_TYPES.has(mimeType)) {
    return "image/jpeg";
  }
  switch (mimeType) {
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
      return "image/png";
    default:
      return mimeType;
  }
}

function getOutputExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

function getResizedFileName(fileName: string, outputMimeType: string): string {
  return `${getBaseFileName(fileName)}-sd.${getOutputExtension(outputMimeType)}`;
}

async function blobFromCanvas(
  canvas: HTMLCanvasElement,
  mimeType: string,
): Promise<Blob | null> {
  return await new Promise<Blob | null>((resolve) => {
    const quality = mimeType === "image/png" ? undefined : SD_JPEG_QUALITY;
    canvas.toBlob(
      (blob) => resolve(blob),
      mimeType,
      quality,
    );
  });
}

export interface PreparedImageUpload {
  file: File;
  width?: number;
  height?: number;
}

export async function prepareImageUpload(
  file: File,
  maxLongEdgePx: number,
): Promise<PreparedImageUpload> {
  if (typeof createImageBitmap !== "function") {
    return { file };
  }
  if (!file.type.startsWith("image/")) {
    return { file };
  }
  if (!RESIZABLE_IMAGE_MIME_TYPES.has(file.type)) {
    return { file };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const dimensions = {
      width: bitmap.width,
      height: bitmap.height,
    };
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (!Number.isFinite(longEdge) || longEdge <= maxLongEdgePx) {
      return { file, ...dimensions };
    }

    const scale = maxLongEdgePx / longEdge;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return { file };
    }
    // Use the browser's native canvas scaler for the downsample.
    ctx.drawImage(bitmap, 0, 0, width, height);

    const outputMimeType = getOutputMimeType(file.type);
    const blob = await blobFromCanvas(canvas, outputMimeType);
    if (!blob) {
      return { file, ...dimensions };
    }

    const finalMimeType = blob.type || outputMimeType;
    return {
      file: new File([blob], getResizedFileName(file.name, finalMimeType), {
        type: finalMimeType,
        lastModified: file.lastModified,
      }),
      width,
      height,
    };
  } catch {
    return { file };
  } finally {
    bitmap?.close();
  }
}

export async function resizeImageFile(
  file: File,
  maxLongEdgePx: number,
): Promise<File> {
  return (await prepareImageUpload(file, maxLongEdgePx)).file;
}
