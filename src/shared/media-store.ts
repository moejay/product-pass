const DB_NAME = "product-pass-assets";
const DB_VERSION = 2;
const SCREENSHOTS = "screenshots";
const MEDIA = "media";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SCREENSHOTS)) request.result.createObjectStore(SCREENSHOTS);
      if (!request.result.objectStoreNames.contains(MEDIA)) request.result.createObjectStore(MEDIA);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open media storage."));
  });
}
async function transaction<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode); const request = action(tx.objectStore(storeName)); let result!: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error("Media storage failed."));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("Media storage transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Media storage transaction failed."));
    });
  } finally { db.close(); }
}
export function putScreenshotBlob(id: string, blob: Blob): Promise<IDBValidKey> { return transaction(SCREENSHOTS, "readwrite", store => store.put(blob, id)); }
export function getScreenshotBlob(id: string): Promise<Blob | undefined> { return transaction(SCREENSHOTS, "readonly", store => store.get(id)); }
export function deleteScreenshotBlob(id: string): Promise<undefined> { return transaction(SCREENSHOTS, "readwrite", store => store.delete(id)); }
export function putMediaBlob(id: string, blob: Blob): Promise<IDBValidKey> { return transaction(MEDIA, "readwrite", store => store.put(blob, id)); }
export function getMediaBlob(id: string): Promise<Blob | undefined> { return transaction(MEDIA, "readonly", store => store.get(id)); }
export function deleteMediaBlob(id: string): Promise<undefined> { return transaction(MEDIA, "readwrite", store => store.delete(id)); }
export async function putImportedAssets(screenshots: Array<{ id: string; blob: Blob }>, media: Array<{ id: string; blob: Blob }>): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SCREENSHOTS, MEDIA], "readwrite");
      screenshots.forEach(asset => tx.objectStore(SCREENSHOTS).put(asset.blob, asset.id)); media.forEach(asset => tx.objectStore(MEDIA).put(asset.blob, asset.id));
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error("Media import failed.")); tx.onabort = () => reject(tx.error ?? new Error("Media import failed."));
    });
  } finally { db.close(); }
}
