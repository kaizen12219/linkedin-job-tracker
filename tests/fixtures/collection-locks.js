// Shared by document fixtures representing the same browser origin.
module.exports = function collectionLocks() {
  const held = new Set(), requests = [];
  let acquired = 0, released = 0;
  return {
    requests,
    get held() { return held.size > 0; },
    get heldNames() { return [...held]; },
    get acquired() { return acquired; },
    get released() { return released; },
    async request(name, options, callback) {
      requests.push({ name, ...options });
      if (held.has(name)) return callback(null);
      held.add(name); acquired++;
      try { return await callback({ name }); }
      finally { held.delete(name); released++; }
    }
  };
};
