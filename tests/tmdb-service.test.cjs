const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "tmdbService.js"),
  "utf8",
);

function response(status, body, retryAfter = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name === "Retry-After" ? retryAfter : null) },
    json: async () => body,
  };
}

function loadService(
  fetch,
  session = async () => ({ access_token: "test-token" }),
  apiKey = "",
) {
  const storage = new Map();
  const window = {
    CINEMAVAULT_TMDB_API_KEY: apiKey,
    CinemaVaultSupabase: { session },
  };
  const context = {
    window,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    fetch,
    URLSearchParams,
    setTimeout,
    Date,
    Map,
    Promise,
    encodeURIComponent,
  };
  vm.runInNewContext(source, context, { filename: "tmdbService.js" });
  return window.CinemaVaultMetadata;
}

test("shares the auth session lookup and caps concurrent TMDB requests", async () => {
  let active = 0;
  let peak = 0;
  let sessions = 0;
  const service = loadService(
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response(200, { results: [] });
    },
    async () => {
      sessions += 1;
      return { access_token: "test-token" };
    },
  );

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      service.fetchCinemaMetadata(`Title ${index}`, 2020),
    ),
  );

  assert.equal(sessions, 1);
  assert.equal(peak, 4);
});

test("retries transient server responses and returns metadata after recovery", async () => {
  let searches = 0;
  const service = loadService(async (url) => {
    if (url.includes("videos")) return response(200, { results: [] });
    searches += 1;
    if (searches < 3) return response(503, {}, "0.001");
    return response(200, {
      results: [
        {
          id: 123,
          media_type: "movie",
          title: "Example",
          poster_path: "/poster.jpg",
          release_date: "2020-01-01",
        },
      ],
    });
  });

  const result = await service.fetchCinemaMetadata("Example", 2020);

  assert.equal(searches, 3);
  assert.equal(result.id, 123);
  assert.equal(result.poster, "https://image.tmdb.org/t/p/w500/poster.jpg");
});

test("does not retry permanent authorization failures", async () => {
  let calls = 0;
  const service = loadService(async () => {
    calls += 1;
    return response(401, {});
  });

  const result = await service.fetchCinemaMetadata("Example", 2020);

  assert.equal(calls, 1);
  assert.equal(result.transient, false);
});

test("does not mark a successful search with no match as transient", async () => {
  let calls = 0;
  const service = loadService(async () => {
    calls += 1;
    return response(200, { results: [] });
  });

  const result = await service.fetchCinemaMetadata("No Match", 2020);

  assert.equal(calls, 1);
  assert.equal(result.transient, undefined);
});

test("marks network failures as transient so card loading can retry later", async () => {
  const service = loadService(async () => {
    throw new TypeError("Network unavailable");
  });

  const result = await service.fetchCinemaMetadata("Example", 2020);

  assert.equal(result.transient, true);
});
