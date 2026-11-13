/** A single recoverable capture per account, stored as actual audio bytes. */
export interface AudioDraft {
  owner_id: string;
  id: string;
  blob: Blob;
  duration_seconds: number;
  recorded_at: string;
  transcript: string;
}
const databaseName = "nota-audio-drafts-v1";
const storeName = "captures";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("浏览器无法保存本机录音，请下载原音后再离开页面。"));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "owner_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("本机录音存储被占用，请关闭其他 Nota 页面后重试。"));
  });
}
async function operation<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("本机录音未保存。"));
      run(transaction.objectStore(storeName), (value) => {
        result = value;
      });
    });
  } finally {
    db.close();
  }
}
export function loadAudioDraft(ownerId: string): Promise<AudioDraft | null> {
  return operation("readonly", (store, resolve) => {
    const request = store.get(ownerId);
    request.onsuccess = () => {
      const value = request.result as AudioDraft | undefined;
      resolve(value?.owner_id === ownerId ? value : null);
    };
  });
}
export function saveAudioDraft(draft: AudioDraft): Promise<void> {
  if (
    !draft.owner_id ||
    !draft.id ||
    !draft.blob.size ||
    draft.blob.size > 4 * 1024 * 1024
  )
    return Promise.reject(new Error("本机录音无效或超过4MB，请先下载原音。"));
  return operation("readwrite", (store, resolve) => {
    store.put(draft);
    resolve();
  });
}
/** Conditional removal cannot erase a newer capture after a delayed upload. */
export function removeAudioDraft(
  ownerId: string,
  captureId: string,
): Promise<void> {
  return operation("readwrite", (store, resolve) => {
    const request = store.get(ownerId);
    request.onsuccess = () => {
      if ((request.result as AudioDraft | undefined)?.id === captureId)
        store.delete(ownerId);
      resolve();
    };
  });
}
