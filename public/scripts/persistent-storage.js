class PersistentStorage {
    constructor() {
        if (!('indexedDB' in window)) {
            PersistentStorage.logBrowserNotCapable();
            return;
        }

        // The connection is opened once and shared by all operations.
        // Opening a new connection per operation leaks connections and makes
        // concurrent writes fail with `TransactionInactiveError`.
        PersistentStorage._dbPromise = PersistentStorage._openDb(5);
        PersistentStorage._dbPromise
            .then(_ => {
                console.log('Database initialised.');
            })
            .catch(e => {
                PersistentStorage.logBrowserNotCapable();
                console.log('Error initializing database: ');
                console.log(e)
                // allow a later call to retry instead of caching a rejected promise
                PersistentStorage._dbPromise = null;
            });
    }

    static logBrowserNotCapable() {
        console.log("This browser does not support IndexedDB. Paired devices will be gone after the browser is closed.");
    }

    static _openDb(version) {
        return new Promise((resolve, reject) => {
            const DBOpenRequest = version
                ? window.indexedDB.open('pairdrop_store', version)
                : window.indexedDB.open('pairdrop_store');

            DBOpenRequest.onupgradeneeded = e => {
                const db = e.target.result;
                const txn = e.target.transaction;

                db.onerror = e => console.log('Error loading database: ' + e);

                console.log(`Upgrading IndexedDB database from version ${e.oldVersion} to version ${e.newVersion}`);

                if (e.oldVersion === 0) {
                    // initiate v1
                    db.createObjectStore('keyval');
                    let roomSecretsObjectStore1 = db.createObjectStore('room_secrets', {autoIncrement: true});
                    roomSecretsObjectStore1.createIndex('secret', 'secret', { unique: true });
                }
                if (e.oldVersion <= 1) {
                    // migrate to v2
                    db.createObjectStore('share_target_files');
                }
                if (e.oldVersion <= 2) {
                    // migrate to v3
                    db.deleteObjectStore('share_target_files');
                    db.createObjectStore('share_target_files', {autoIncrement: true});
                }
                if (e.oldVersion <= 3) {
                    // migrate to v4
                    let roomSecretsObjectStore4 = txn.objectStore('room_secrets');
                    roomSecretsObjectStore4.createIndex('display_name', 'display_name');
                    roomSecretsObjectStore4.createIndex('auto_accept', 'auto_accept');
                }
                if (e.oldVersion <= 4) {
                    // migrate to v5
                    // use the upgrade transaction directly: opening a separate
                    // connection here would block until this transaction finished
                    const keyvalObjectStore = txn.objectStore('keyval');
                    const request = keyvalObjectStore.get('editedDisplayName');
                    request.onsuccess = _ => {
                        const editedDisplayNameOld = request.result;
                        if (!editedDisplayNameOld) return;
                        keyvalObjectStore.put(editedDisplayNameOld, 'edited_display_name');
                        keyvalObjectStore.delete('editedDisplayName');
                    };
                }
            };

            DBOpenRequest.onsuccess = e => {
                const db = e.target.result;
                // allow another tab to upgrade the database instead of blocking it
                db.onversionchange = _ => {
                    db.close();
                    PersistentStorage._dbPromise = null;
                };
                resolve(db);
            };
            DBOpenRequest.onerror = e => reject(e);
            DBOpenRequest.onblocked = e => reject(e);
        });
    }

    static _getDb() {
        if (!PersistentStorage._dbPromise) {
            // fallback if a static method is called before the constructor ran
            const dbPromise = PersistentStorage._dbPromise = PersistentStorage._openDb();
            dbPromise.catch(() => {
                if (PersistentStorage._dbPromise === dbPromise) PersistentStorage._dbPromise = null;
            });
        }
        return PersistentStorage._dbPromise;
    }

    // Runs `callback(objectStore)` in a transaction and rejects on transaction errors
    static _withObjectStore(storeName, mode, callback) {
        return PersistentStorage._getDb()
            .then(db => new Promise((resolve, reject) => {
                const transaction = db.transaction(storeName, mode);
                const objectStore = transaction.objectStore(storeName);

                transaction.onabort = e => reject(e.target.error ?? e);
                transaction.onerror = e => reject(e.target.error ?? e);

                callback(objectStore, resolve, reject, transaction);
            }));
    }

    static set(key, value) {
        return this._withObjectStore('keyval', 'readwrite', (objectStore, resolve, reject) => {
            const objectStoreRequest = objectStore.put(value, key);
            objectStoreRequest.onsuccess = _ => {
                resolve(value);
            };
            objectStoreRequest.onerror = e => reject(e);
        });
    }

    static get(key) {
        return this._withObjectStore('keyval', 'readonly', (objectStore, resolve, reject) => {
            const objectStoreRequest = objectStore.get(key);
            objectStoreRequest.onsuccess = _ => {
                resolve(objectStoreRequest.result);
            }
            objectStoreRequest.onerror = e => reject(e);
        });
    }

    static delete(key) {
        return this._withObjectStore('keyval', 'readwrite', (objectStore, resolve, reject) => {
            const objectStoreRequest = objectStore.delete(key);
            objectStoreRequest.onsuccess = _ => {
                resolve();
            };
            objectStoreRequest.onerror = e => reject(e);
        });
    }

    static addRoomSecret(roomSecret, displayName, deviceName) {
        return this._withObjectStore('room_secrets', 'readwrite', (objectStore, resolve, reject) => {
            const objectStoreRequest = objectStore.add({
                'secret': roomSecret,
                'display_name': displayName,
                'device_name': deviceName,
                'auto_accept': false
            });
            objectStoreRequest.onsuccess = e => {
                resolve();
            }
            objectStoreRequest.onerror = e => reject(e);
        });
    }

    static async getAllRoomSecrets() {
        try {
            const roomSecrets = await this.getAllRoomSecretEntries();
            let secrets = [];
            for (let i = 0; i < roomSecrets.length; i++) {
                secrets.push(roomSecrets[i].secret);
            }
            return(secrets);
        } catch (e) {
            console.error("Could not retrieve room secrets", e);
            this.logBrowserNotCapable();
            return [];
        }
    }

    static getAllRoomSecretEntries() {
        return this._withObjectStore('room_secrets', 'readonly', (objectStore, resolve, reject) => {
            const objectStoreRequest = objectStore.getAll();
            objectStoreRequest.onsuccess = e => {
                resolve(e.target.result);
            }
            objectStoreRequest.onerror = e => reject(e);
        });
    }

    static getRoomSecretEntry(roomSecret) {
        return this._withObjectStore('room_secrets', 'readonly', (objectStore, resolve, reject) => {
            const objectStoreRequestKey = objectStore.index("secret").getKey(roomSecret);
            objectStoreRequestKey.onsuccess = e => {
                const key = e.target.result;
                if (!key) {
                    resolve();
                    return;
                }
                const objectStoreRequestRetrieval = objectStore.get(key);
                objectStoreRequestRetrieval.onsuccess = e => {
                    resolve({
                        "entry": e.target.result,
                        "key": key
                    });
                }
                objectStoreRequestRetrieval.onerror = e => reject(e);
            };
            objectStoreRequestKey.onerror = e => reject(e);
        });
    }

    static deleteRoomSecret(roomSecret) {
        return this._withObjectStore('room_secrets', 'readwrite', (objectStore, resolve, reject) => {
            const objectStoreRequestKey = objectStore.index("secret").getKey(roomSecret);
            objectStoreRequestKey.onsuccess = e => {
                if (!e.target.result) {
                    resolve();
                    return;
                }
                const key = e.target.result;
                const objectStoreRequestDeletion = objectStore.delete(key);
                objectStoreRequestDeletion.onsuccess = _ => {
                    resolve(roomSecret);
                }
                objectStoreRequestDeletion.onerror = e => reject(e);
            };
            objectStoreRequestKey.onerror = e => reject(e);
        });
    }

    static clearRoomSecrets() {
        return this._withObjectStore('room_secrets', 'readwrite', (objectStore, resolve, reject) => {
            const objectStoreRequest = objectStore.clear();
            objectStoreRequest.onsuccess = _ => {
                resolve();
            };
            objectStoreRequest.onerror = e => reject(e);
        });
    }

    static updateRoomSecretNames(roomSecret, displayName, deviceName) {
        return this.updateRoomSecret(roomSecret, undefined, displayName, deviceName);
    }

    static updateRoomSecretAutoAccept(roomSecret, autoAccept) {
        return this.updateRoomSecret(roomSecret, undefined, undefined, undefined, autoAccept);
    }

    static updateRoomSecret(roomSecret, updatedRoomSecret = undefined, updatedDisplayName = undefined, updatedDeviceName = undefined, updatedAutoAccept = undefined) {
        return this.getRoomSecretEntry(roomSecret)
            .then(roomSecretEntry => {
                if (!roomSecretEntry) return false;

                // Do not use `updatedRoomSecret ?? roomSecretEntry.entry.secret` to ensure compatibility with older browsers
                const updatedRoomSecretEntry = {
                    'secret': updatedRoomSecret !== undefined ? updatedRoomSecret : roomSecretEntry.entry.secret,
                    'display_name': updatedDisplayName !== undefined ? updatedDisplayName : roomSecretEntry.entry.display_name,
                    'device_name': updatedDeviceName !== undefined ? updatedDeviceName : roomSecretEntry.entry.device_name,
                    'auto_accept': updatedAutoAccept !== undefined ? updatedAutoAccept : roomSecretEntry.entry.auto_accept
                };

                return this._withObjectStore('room_secrets', 'readwrite', (objectStore, resolve, reject) => {
                    const objectStoreRequestUpdate = objectStore.put(updatedRoomSecretEntry, roomSecretEntry.key);

                    objectStoreRequestUpdate.onsuccess = _ => {
                        resolve({
                            "entry": updatedRoomSecretEntry,
                            "key": roomSecretEntry.key
                        });
                    }

                    objectStoreRequestUpdate.onerror = e => reject(e);
                });
            });
    }
}
