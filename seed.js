// Creates indexes and two sample businesses. Safe to run many times.
// Run with:  npm run seed
import { getDb } from "../lib/db.js";

const realPhoneNumberId = process.env.PHONE_NUMBER_ID;
if (!realPhoneNumberId) {
  console.error("Set PHONE_NUMBER_ID in .env (from Meta: WhatsApp > API Setup).");
  process.exit(1);
}

const db = await getDb();

// Indexes: fast lookups, and protection against duplicate processing.
await db.collection("businesses").createIndex({ phoneNumberId: 1 }, { unique: true });
await db.collection("conversations").createIndex({ businessId: 1, customerNumber: 1 }, { unique: true });
await db.collection("messages").createIndex({ conversationId: 1, createdAt: 1 });
// Meta may deliver the same message twice; a unique id lets us ignore repeats.
await db.collection("messages").createIndex({ waMessageId: 1 }, { unique: true, sparse: true });

const businesses = [
  {
    name: "Sunrise Clinic",
    phoneNumberId: realPhoneNumberId, // your real Meta test number
    tone: "calm, caring and professional",
    instructions:
      "You are the virtual receptionist for Sunrise Clinic. Help with appointments, timings (Mon-Sat, 9am-6pm) and general questions. Never give medical diagnoses; suggest booking an appointment instead.",
  },
  {
    name: "Urban Threads",
    phoneNumberId: "fake-clothing-123", // fake id so we can simulate a 2nd business
    tone: "friendly, upbeat and casual",
    instructions:
      "You are the assistant for Urban Threads, a clothing store. Help with sizes, delivery (3-5 days) and returns (7 days). Do not promise discounts.",
  },
];

for (const b of businesses) {
  await db.collection("businesses").updateOne(
    { phoneNumberId: b.phoneNumberId },
    { $set: b, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  console.log("Saved business:", b.name);
}

console.log("Done. Check Atlas > Browse Collections.");
process.exit(0);
