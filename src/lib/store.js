// Hands a capture from the service worker to the editor tab.
// Both run on the extension's origin, so they share this IndexedDB.
// Captures can be tens of MB, too big for chrome.storage.session.

const DB_NAME = 'capture-and-annotate';
const STORE = 'captures';
// Recent captures are kept so reloading an editor tab still works.
const KEEP = 10;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req?.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

// Keys start with a zero-padded timestamp, so they sort oldest first.
export async function putCapture(capture) {
  const id = `${String(Date.now()).padStart(15, '0')}-${crypto.randomUUID()}`;
  await run('readwrite', (s) => s.put(capture, id));
  const keys = await run('readonly', (s) => s.getAllKeys());
  const stale = keys.slice(0, Math.max(0, keys.length - KEEP));
  if (stale.length) await run('readwrite', (s) => stale.forEach((k) => s.delete(k)));
  return id;
}

export function getCapture(id) {
  return run('readonly', (s) => s.get(id));
}
