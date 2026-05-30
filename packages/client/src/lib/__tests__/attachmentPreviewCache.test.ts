import "fake-indexeddb/auto";

import type { UploadedFile } from "@yep-anywhere/shared";
import { planThumbnail } from "@yep-anywhere/shared";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getEntry,
  openDatabase,
  putEntryWithKey,
} from "../diagnostics/idb";
import {
  loadCachedAttachmentPreview,
  storeUploadedAttachmentPreview,
} from "../attachmentPreviewCache";
import { resizeImageFile } from "../imageAttachmentResize";

const DB_NAME = "yep-anywhere-attachment-previews";
const STORE_NAME = "images";

function openPreviewDatabase(): Promise<IDBDatabase> {
  return openDatabase(DB_NAME, 2, (db: IDBDatabase, tx: IDBTransaction) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME);
      store.createIndex("byLastAccessedAt", "lastAccessedAt");
      return;
    }

    const store = tx.objectStore(STORE_NAME);
    if (!store.indexNames.contains("byLastAccessedAt")) {
      store.createIndex("byLastAccessedAt", "lastAccessedAt");
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image attachment resizing", () => {
  it("renames resized images to match the encoded output", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 3000,
        close,
      })),
    );

    const originalCreateElement = document.createElement.bind(document);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(["thumb"], { type: "image/png" }));
      }),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName === "canvas") {
        return canvas;
      }
      return originalCreateElement(tagName);
    });

    const file = new File(["payload"], "disconnect-pull-plate-condition.jpeg", {
      type: "image/jpeg",
    });

    const resized = await resizeImageFile(file, 2048);

    expect(resized).not.toBe(file);
    expect(resized.name).toBe("disconnect-pull-plate-condition-sd.png");
    expect(resized.type).toBe("image/png");
  });
});

describe("attachment thumbnail generation", () => {
  it("center-crops wide images to a 2:1 thumbnail box", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 1000,
        close,
      })),
    );

    const drawImage = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(["thumb"], { type: "image/png" }));
      }),
    } as unknown as HTMLCanvasElement;

    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName === "canvas") {
        return canvas;
      }
      return originalCreateElement(tagName);
    });

    const sourceFile = new File(["wide"], "wide.png", { type: "image/png" });
    const uploadedFile: UploadedFile = {
      id: "attachment-id-wide",
      originalName: "wide.png",
      name: "attachment-id-wide_wide.png",
      path: "/project/.attachments/session/attachment-id-wide_wide.png",
      size: sourceFile.size,
      mimeType: "image/png",
    };

    await storeUploadedAttachmentPreview(uploadedFile, sourceFile);

    const planned = planThumbnail(4000, 1000);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(
      expect.objectContaining({
        close,
      }),
      1000,
      0,
      2000,
      1000,
      0,
      0,
      planned.width,
      planned.height,
    );
  });
});

describe("attachment preview cache", () => {
  it("stores previews under attachment ids", async () => {
    const sourceFile = new File(["preview"], "pump-bottom.jpeg", {
      type: "image/jpeg",
    });
    const uploadedFile: UploadedFile = {
      id: "attachment-id-1",
      originalName: "pump-bottom.jpeg",
      name: "attachment-id-1_pump-bottom.jpeg",
      path: "/project/.attachments/session/attachment-id-1_pump-bottom.jpeg",
      size: sourceFile.size,
      mimeType: "image/jpeg",
    };

    await storeUploadedAttachmentPreview(uploadedFile, sourceFile);

    const db = await openPreviewDatabase();
    expect(await getEntry(db, STORE_NAME, uploadedFile.id)).toMatchObject({
      attachmentId: uploadedFile.id,
      path: uploadedFile.path,
    });
    expect(await getEntry(db, STORE_NAME, uploadedFile.path)).toBeNull();
    db.close();
  });

  it("migrates legacy path-keyed previews onto attachment ids", async () => {
    const legacyPath = "/project/.attachments/session/legacy-path.jpg";
    const attachmentId = "attachment-id-2";
    const db = await openPreviewDatabase();
    await putEntryWithKey(
      db,
      STORE_NAME,
      legacyPath,
      {
        attachmentId: "legacy-path-key",
        path: legacyPath,
        originalName: "legacy-path.jpg",
        mimeType: "image/png",
        size: 4,
        thumbnailVariant: "thumb:v1:96:image/png",
        thumbnailWidth: 1,
        thumbnailHeight: 1,
        thumbnailBlob: new Blob(["thumb"], { type: "image/png" }),
        fullBlob: new Blob(["full"], { type: "image/png" }),
        totalBytes: 8,
        createdAt: Date.now() - 1000,
        lastAccessedAt: Date.now() - 1000,
      },
    );

    const loaded = await loadCachedAttachmentPreview(attachmentId, legacyPath);

    expect(loaded?.attachmentId).toBe(attachmentId);
    expect(await getEntry(db, STORE_NAME, attachmentId)).toMatchObject({
      attachmentId,
      path: legacyPath,
    });
    expect(await getEntry(db, STORE_NAME, legacyPath)).toBeNull();
    db.close();
  });
});
