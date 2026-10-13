(function registerFolderAccess(root) {
  'use strict';
  const databaseName = 'applicantally-folder-v1';
  async function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transact(mode, action) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('handles', mode);
        const request = action(transaction.objectStore('handles'));
        let value;
        request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Folder access was not saved.'));
      });
    } finally { db.close(); }
  }
  const read = () => transact('readonly', store => store.get('workspace'));
  const save = handle => transact('readwrite', store => store.put(handle, 'workspace'));
  const clear = () => transact('readwrite', store => store.delete('workspace'));
  async function readJson(directory, name) { return JSON.parse(await (await directory.getFileHandle(name)).getFile().then(file => file.text())); }
  async function resolve(handle) {
    // Accept the extracted app folder, its data folder, or data/workspace itself.
    for (const parts of [[], ['workspace'], ['data', 'workspace']]) {
      try {
        let directory = handle;
        for (const part of parts) directory = await directory.getDirectoryHandle(part);
        const descriptor = await readJson(directory, 'applicantally-store.json');
        if (descriptor.version !== 1 || descriptor.format !== 'applicantally-job-files' ||
          !/^[a-f0-9-]{36}$/u.test(descriptor.storeId || '') ||
          descriptor.jobsDirectory !== 'job-primary/applicantally-1/jobs' ||
          descriptor.profilesRegistry !== 'profile-library/registry.json') throw new Error('Invalid ApplicantAlly workspace.');
        return { directory, descriptor };
      } catch (error) { if (!['NotFoundError', 'TypeMismatchError'].includes(error.name)) throw error; }
    }
    throw new Error('Choose the ApplicantAlly folder containing data/workspace. Open the updated app once to prepare its data.');
  }
  root.ApplicantAllyFolder = Object.freeze({ read, save, clear, resolve, readJson });
})(globalThis);
