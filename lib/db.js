import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "autoreply";

// Why globalThis? On Vercel (serverless), your code can start many times.
// Opening a new database connection on every request would be slow and would
// quickly exhaust Atlas's free connection limit. Storing the connection promise
// on globalThis lets warm function instances reuse it.
const cache = (globalThis._mongoCache ??= { promise: null });

export async function getDb() {
  if (!uri) throw new Error("MONGODB_URI is not set");

  if (!cache.promise) {
    const client = new MongoClient(uri);
    cache.promise = client.connect().catch((err) => {
      cache.promise = null; // allow a retry on the next request
      throw err;
    });
  }

  const client = await cache.promise;
  return client.db(dbName);
}
