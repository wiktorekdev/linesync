function createFixedWindowLimiter(limit, windowMs) {
  const buckets = new Map();

  const hit = (key) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count > limit;
  };

  const cleanup = () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (!bucket || now > bucket.resetAt) buckets.delete(key);
    }
  };

  return {
    hit,
    cleanup,
  };
}

module.exports = {
  createFixedWindowLimiter,
};
