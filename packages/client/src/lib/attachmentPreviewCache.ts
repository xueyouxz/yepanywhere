import type { UploadedFile } from "@yep-anywhere/shared";
import {
  THUMBNAIL_HEIGHT_PX,
  THUMBNAIL_MIME_TYPE,
  THUMBNAIL_MAX_ASPECT_RATIO,
  planThumbnail,
} from "@yep-anywhere/shared";
import {
  deleteEntry,
  getEntry,
  openDatabase,
  putEntryWithKey,
} from "./diagnostics/idb";

const DB_NAME = "yep-anywhere-attachment-previews";
const DB_VERSION = 2;
const STORE_NAME = "images";
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const THUMBNAIL_CACHE_VARIANT = `thumb:v3:${THUMBNAIL_HEIGHT_PX}:${THUMBNAIL_MAX_ASPECT_RATIO}:${THUMBNAIL_MIME_TYPE}`;

interface CachedAttachmentPreview {
  attachmentId: string;
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
  thumbnailVariant: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  thumbnailBlob?: Blob;
  fullBlob: Blob;
  totalBytes: number;
  createdAt: number;
  lastAccessedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function getDatabase(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase(DB_NAME, DB_VERSION, (db, tx) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME);
        store.createIndex("byLastAccessedAt", "lastAccessedAt");
      } else {
        const store = tx.objectStore(
          STORE_NAME,
        );
        if (!store.indexNames.contains("byLastAccessedAt")) {
          store.createIndex("byLastAccessedAt", "lastAccessedAt");
        }
      }
    });
  }
  return dbPromise;
}

async function createThumbnailBlob(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number } | undefined> {
  if (typeof createImageBitmap !== "function") {
    return undefined;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const thumb = planThumbnail(bitmap.width, bitmap.height);

    const canvas = document.createElement("canvas");
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return undefined;
    }
    ctx.drawImage(
      bitmap,
      thumb.sourceX,
      thumb.sourceY,
      thumb.sourceWidth,
      thumb.sourceHeight,
      0,
      0,
      thumb.width,
      thumb.height,
    );
    bitmap.close();

    const blob = await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((value) => resolve(value ?? undefined), THUMBNAIL_MIME_TYPE);
    });
    if (!blob) {
      return undefined;
    }

    return { blob, width: thumb.width, height: thumb.height };
  } catch {
    return undefined;
  }
}

function needsThumbnailRefresh(entry: CachedAttachmentPreview): boolean {
  return entry.thumbnailVariant !== THUMBNAIL_CACHE_VARIANT;
}

async function calculateCacheSize(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();
  const entries = (await new Promise<CachedAttachmentPreview[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as CachedAttachmentPreview[]);
    request.onerror = () => reject(request.error);
  })) ?? [];
  return entries.reduce((sum, entry) => sum + (entry.totalBytes ?? 0), 0);
}

async function evictOldestEntries(
  db: IDBDatabase,
  bytesToFree: number,
): Promise<void> {
  if (bytesToFree <= 0) return;

  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("byLastAccessedAt");
  let freed = 0;

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || freed >= bytesToFree) {
        resolve();
        return;
      }

      const value = cursor.value as CachedAttachmentPreview;
      freed += value.totalBytes ?? 0;
      cursor.delete();
      cursor.continue();
    };
  });

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

export async function storeUploadedAttachmentPreview(
  uploadedFile: UploadedFile,
  sourceFile: File,
): Promise<void> {
  if (!isImageMimeType(uploadedFile.mimeType)) {
    return;
  }

  const uploadDimensions =
    uploadedFile.width !== undefined && uploadedFile.height !== undefined
      ? planThumbnail(uploadedFile.width, uploadedFile.height)
      : undefined;
  const fullBlob = sourceFile.slice(0, sourceFile.size, sourceFile.type);
  const thumbnail = await createThumbnailBlob(sourceFile);
  const totalBytes = fullBlob.size + (thumbnail?.blob.size ?? 0);

  const db = await getDatabase();
  const cachedPreview: CachedAttachmentPreview = {
    attachmentId: uploadedFile.id,
    path: uploadedFile.path,
    originalName: uploadedFile.originalName,
    mimeType: uploadedFile.mimeType,
    size: uploadedFile.size,
    thumbnailVariant: THUMBNAIL_CACHE_VARIANT,
    thumbnailWidth: thumbnail?.width ?? uploadDimensions?.width ?? THUMBNAIL_HEIGHT_PX,
    thumbnailHeight:
      thumbnail?.height ?? uploadDimensions?.height ?? THUMBNAIL_HEIGHT_PX,
    thumbnailBlob: thumbnail?.blob,
    fullBlob,
    totalBytes,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
  await putEntryWithKey<CachedAttachmentPreview>(
    db,
    STORE_NAME,
    uploadedFile.id,
    cachedPreview,
  );
  if (uploadedFile.path !== uploadedFile.id) {
    await deleteEntry(db, STORE_NAME, uploadedFile.path).catch(() => {});
  }

  const cacheSize = await calculateCacheSize(db);
  if (cacheSize > MAX_CACHE_BYTES) {
    await evictOldestEntries(db, cacheSize - MAX_CACHE_BYTES);
  }
}

export async function loadCachedAttachmentPreview(
  attachmentId: string,
  legacyPath?: string,
): Promise<CachedAttachmentPreview | null> {
  const db = await getDatabase();
  let entry = await getEntry<CachedAttachmentPreview>(db, STORE_NAME, attachmentId);
  if (!entry && legacyPath && legacyPath !== attachmentId) {
    const legacyEntry = await getEntry<CachedAttachmentPreview>(
      db,
      STORE_NAME,
      legacyPath,
    );
    if (legacyEntry) {
      entry = {
        ...legacyEntry,
        attachmentId,
      };
      await putEntryWithKey<CachedAttachmentPreview>(
        db,
        STORE_NAME,
        attachmentId,
        entry,
      );
      await deleteEntry(db, STORE_NAME, legacyPath).catch(() => {});
    }
  }
  if (!entry) return null;

  if (needsThumbnailRefresh(entry)) {
    const refreshedThumbnail = await createThumbnailBlob(entry.fullBlob);
    if (refreshedThumbnail) {
      entry = {
        ...entry,
        thumbnailWidth: refreshedThumbnail.width,
        thumbnailHeight: refreshedThumbnail.height,
        thumbnailBlob: refreshedThumbnail.blob,
        thumbnailVariant: THUMBNAIL_CACHE_VARIANT,
      };
      await putEntryWithKey<CachedAttachmentPreview>(
        db,
        STORE_NAME,
        attachmentId,
        entry,
      );
    }
  }

  const updated = {
    ...entry,
    lastAccessedAt: Date.now(),
  };
  await putEntryWithKey<CachedAttachmentPreview>(
    db,
    STORE_NAME,
    attachmentId,
    updated,
  );
  return updated;
}

export async function deleteCachedAttachmentPreview(path: string): Promise<void> {
  const db = await getDatabase();
  await deleteEntry(db, STORE_NAME, path);
}

export function isCacheableAttachmentMimeType(mimeType: string): boolean {
  return isImageMimeType(mimeType);
}
