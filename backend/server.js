require("dotenv").config();
const express = require("express");
const { MongoClient } = require("mongodb");
const { randomUUID, randomBytes, createHash, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createSwipeStore, categoryScores, rankEvents } = require("./recommendations");

const scrypt = promisify(scryptCallback);
const app = express();
const port = Number(process.env.PORT || 3001);
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "events.json");
const authFile = path.join(dataDir, "auth.json");
const interestsFile = path.join(dataDir, "interests.json");
const publicDir = path.resolve(__dirname, "../public");
const swipeStore = createSwipeStore({ dataDir });
const categories = new Set([
  'Academics',
  'Sports',
  'Running',
  'Cycling',
  'Art & Design',
  'Spiritual & Faith',
  'Computer Science',
  'Engineering',
  'Parties & Nightlife',
  'Books & Literature',
  'Free Food',
  'Music & Concerts',
  'Career & Networking',
  'Entrepreneurship',
  'Volunteering',
  'Outdoors & Hiking',
  'Health & Wellness',
  'Gaming & Esports',
  'Film & Theater',
  'Cultural & Diversity'
]);
const legacyCategories = new Set(["Music", "Food & Drink", "Sports", "Arts", "Tech", "Social", "Other"]);
const SESSION_MS = 7 * 86400000;
const COOKIE_NAME = "eventswipe.sid";
const production = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use(express.json({ limit: "3mb" }));
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "Cross-site request blocked." });
    if (origin) {
      try {
        const expectedHost = req.get("host");
        const actual = new URL(origin);
        if (actual.host !== expectedHost || (production && actual.protocol !== "https:"))
          return res.status(403).json({ error: "Request origin not allowed." });
      } catch { return res.status(403).json({ error: "Request origin not allowed." }); }
    }
  }
  next();
});

let db = null;
let eventsCollection = null;
let usersCollection = null;
let sessionsCollection = null;
let interestsCollection = null;
let client = null;
let eventWriting = Promise.resolve();
let authWriting = Promise.resolve();
let interestsWriting = Promise.resolve();
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { attempts: 0, resetAt: now + 15 * 60000 };
  if (now >= bucket.resetAt) { bucket.attempts = 0; bucket.resetAt = now + 15 * 60000; }
  bucket.attempts += 1;
  rateBuckets.set(key, bucket);
  if (bucket.attempts > 20) return res.status(429).json({ error: "Too many attempts. Try again later." });
  next();
}

const hash = value => createHash("sha256").update(value).digest("hex");
const safeEvent = ({ ownerHash, ownerUserId, _id, ...event }) => event;
const publicUser = ({ id, email }) => ({ id, email });

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
function mutateJson(file, fallback, job, queueName) {
  const queue = queueName === "events" ? eventWriting : queueName === "interests" ? interestsWriting : authWriting;
  const nextJob = queue.then(async () => {
    const data = await readJson(file, fallback);
    const result = await job(data);
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
    return result;
  });
  if (queueName === "events") eventWriting = nextJob.catch(() => {});
  else if (queueName === "interests") interestsWriting = nextJob.catch(() => {});
  else authWriting = nextJob.catch(() => {});
  return nextJob;
}
const readEvents = () => readJson(dataFile, []);
const changeEvents = fn => mutateJson(dataFile, [], fn, "events");
const readInterests = () => readJson(interestsFile, []);
const changeInterests = fn => mutateJson(interestsFile, [], fn, "interests");
const readAuth = () => readJson(authFile, { users: [], sessions: [] });
const changeAuth = fn => mutateJson(authFile, { users: [], sessions: [] }, fn, "auth");

function getSessionToken(req) {
  const cookie = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + "="));
  const value = cookie?.slice(COOKIE_NAME.length + 1) || "";
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}
function setSessionCookie(res, token, maxAge = SESSION_MS) {
  const parts = [COOKIE_NAME + "=" + token, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=" + Math.floor(maxAge / 1000)];
  if (production) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
async function userFromRequest(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const tokenHash = hash(token);
  const now = Date.now();
  if (db) {
    const session = await sessionsCollection.findOne({ tokenHash, expiresAt: { $gt: new Date(now) } });
    if (!session) return null;
    return usersCollection.findOne({ id: session.userId });
  }
  const auth = await readAuth();
  const session = auth.sessions.find(s => s.tokenHash === tokenHash && s.expiresAt > now);
  if (!session) return null;
  return auth.users.find(u => u.id === session.userId) || null;
}
async function requireUser(req, res, next) {
  try {
    req.user = await userFromRequest(req);
    if (!req.user) return res.status(401).json({ error: "Please log in." });
    next();
  } catch (error) { next(error); }
}
async function openSession(res, user) {
  const token = randomBytes(32).toString("hex");
  const record = { tokenHash: hash(token), userId: user.id, expiresAt: Date.now() + SESSION_MS };
  if (db) await sessionsCollection.insertOne({ ...record, expiresAt: new Date(record.expiresAt) });
  else await changeAuth(data => {
    data.sessions = data.sessions.filter(s => s.expiresAt > Date.now());
    data.sessions.push(record);
  });
  setSessionCookie(res, token);
}
async function closeSession(req, res) {
  const token = getSessionToken(req);
  if (token) {
    if (db) await sessionsCollection.deleteOne({ tokenHash: hash(token) });
    else await changeAuth(data => { data.sessions = data.sessions.filter(s => s.tokenHash !== hash(token)); });
  }
  setSessionCookie(res, "", 0);
}
const emailValid = email => typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const passValid = pw => typeof pw === "string" && pw.length >= 8 && pw.length <= 128;
async function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(pw, salt, 64);
  return { passwordHash: derived.toString("hex"), passwordSalt: salt };
}
async function comparePassword(pw, user) {
  const salt = user?.passwordSalt || "00000000000000000000000000000000";
  const expected = Buffer.from(user?.passwordHash || "00".repeat(64), "hex");
  const actual = await scrypt(pw, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual) && !!user;
}

app.post("/api/auth/register", rateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = req.body?.password;
    if (!emailValid(email) || !passValid(password)) return res.status(400).json({ error: "Enter a valid email and password (at least 8 characters)." });
    const pwFields = await hashPassword(password);
    const user = { id: randomUUID(), email, ...pwFields, createdAt: Date.now() };
    if (db) {
      try { await usersCollection.insertOne(user); }
      catch (error) { if (error.code === 11000) return res.status(409).json({ error: "This email is already registered." }); throw error; }
    } else {
      const inserted = await changeAuth(data => {
        if (data.users.some(u => u.email === email)) return false;
        data.users.push(user);
        return true;
      });
      if (!inserted) return res.status(409).json({ error: "This email is already registered." });
    }
    await openSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", rateLimit, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const pw = req.body?.password;
    if (!emailValid(email) || typeof pw !== "string" || pw.length > 128) return res.status(401).json({ error: "Invalid email or password." });
    const user = db ? await usersCollection.findOne({ email }) : (await readAuth()).users.find(u => u.email === email);
    if (!await comparePassword(pw, user)) return res.status(401).json({ error: "Invalid email or password." });
    await openSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: publicUser(req.user) }));
app.post("/api/auth/logout", requireUser, async (req, res, next) => {
  try { await closeSession(req, res); res.json({ ok: true }); }
  catch (error) { next(error); }
});

function validateEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid event.");
  const text = (name, max, required = true) => {
    const value = body[name];
    if (typeof value !== "string") { if (!required && value == null) return ""; throw new Error("Invalid " + name); }
    const trimmed = value.trim();
    if ((required && !trimmed) || trimmed.length > max) throw new Error("Invalid " + name);
    return trimmed;
  };
  const title = text("title", 80);
  const location = text("location", 100);
  const details = text("details", 500, false);
  let selectedCategories;
  if (Array.isArray(body.categories)) {
    if (!body.categories.length || body.categories.length > categories.size ||
        body.categories.some(c => typeof c !== "string" || !categories.has(c)) ||
        new Set(body.categories).size !== body.categories.length) throw new Error("Select valid categories.");
    selectedCategories = [...body.categories];
  } else {
    // Older events used one category. Keep backward compatibility for those posts.
    const legacyCategory = text("category", 50);
    if (!categories.has(legacyCategory) && !legacyCategories.has(legacyCategory)) throw new Error("Unknown category.");
    selectedCategories = [legacyCategory];
  }
  const category = selectedCategories[0];
  const date = Number(body.date);
  if (!Number.isFinite(date) || date <= Date.now() || date > Date.now() + 5 * 365 * 86400000) throw new Error("Choose a valid future date.");
  const link = text("link", 2000);
  let url;
  try { url = new URL(link); } catch { throw new Error("Invalid event website."); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname.includes(".")) throw new Error("Invalid event website.");
  let price = null;
  if (body.price !== "" && body.price !== null && body.price !== undefined) {
    price = Number(body.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new Error("Invalid ticket price.");
  }
  let image;
  if (body.image !== undefined && body.image !== null && body.image !== "") {
    if (typeof body.image !== "string" || body.image.length > 2000000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.image))
      throw new Error("Image is too large or unsupported (2 MB maximum).");
    image = body.image;
  }
  let lat, lng;
  if (body.lat != null || body.lng != null) {
    lat = Number(body.lat); lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Invalid coordinates.");
  }
  return { id: randomUUID(), title, location, details, category, categories: selectedCategories, date, link: url.href, price, ...(image ? { image } : {}), ...(lat !== undefined ? { lat, lng } : {}), createdAt: Date.now() };
}

async function listEvents(query = {}) {
  return db
    ? eventsCollection.find(query, { projection: { _id: 0, ownerHash: 0 } }).sort({ date: 1 }).limit(1000).toArray()
    : (await readEvents()).filter(e => Object.entries(query).every(([k, v]) => e[k] === v)).sort((a, b) => a.date - b.date);
}
// One interest per user per event. This is *not* an official attendance / RSVP count.
async function countInterest(eventId) {
  if (db) return interestsCollection.countDocuments({ eventId });
  return (await readInterests()).filter(item => item.eventId === eventId).length;
}
async function withInterestCounts(events) {
  if (!events.length) return [];
  const ids = [...new Set(events.map(event => event.id))];
  const counts = new Map();
  if (db) {
    const rows = await interestsCollection.aggregate([
      { $match: { eventId: { $in: ids } } },
      { $group: { _id: "$eventId", total: { $sum: 1 } } }
    ]).toArray();
    for (const row of rows) counts.set(row._id, row.total);
  } else {
    const wanted = new Set(ids);
    for (const item of await readInterests()) {
      if (wanted.has(item.eventId)) counts.set(item.eventId, (counts.get(item.eventId) || 0) + 1);
    }
  }
  return events.map(event => ({ ...safeEvent(event), interestCount: counts.get(event.id) || 0 }));
}
async function findEventById(id) {
  return db ? eventsCollection.findOne({ id }) : (await readEvents()).find(event => event.id === id);
}

app.get("/api/interests/mine", requireUser, async (req, res, next) => {
  try {
    const records = db
      ? await interestsCollection.find({ userId: req.user.id }, { projection: { _id: 0, eventId: 1 } }).toArray()
      : (await readInterests()).filter(item => item.userId === req.user.id);
    res.json({ eventIds: records.map(item => item.eventId) });
  } catch (error) { next(error); }
});
// Sync any Likes saved before the recommendation feature was installed.
// A conditional insert avoids replacing a newer swipe or double counting.
async function swipesForUser(userId) {
  let swipes = await swipeStore.list(userId);
  const known = new Set(swipes.map(swipe => swipe.eventId));
  const likedRecords = db
    ? await interestsCollection.find({ userId }, { projection: { eventId: 1, _id: 0 } }).toArray()
    : (await readInterests()).filter(item => item.userId === userId);
  const missing = likedRecords.map(record => record.eventId).filter(id => !known.has(id));
  if (missing.length) {
    const events = new Map((await listEvents()).map(event => [event.id, event]));
    for (const id of new Set(missing)) {
      const event = events.get(id);
      if (event && event.ownerUserId !== userId) await swipeStore.put(userId, event, "right", true);
    }
    swipes = await swipeStore.list(userId);
  }
  return swipes;
}

app.get("/api/recommendations/me", requireUser, async (req, res, next) => {
  try {
    const swipes = await swipesForUser(req.user.id);
    res.json({ scores: categoryScores(swipes), swipes });
  } catch (error) { next(error); }
});

// Passing an event records one negative vote in every selected category.
app.post("/api/events/:id/pass", requireUser, async (req, res, next) => {
  try {
    const event = await findEventById(req.params.id);
    if (!event) return res.status(404).json({ error: "Event not found." });
    if (event.ownerUserId === req.user.id) return res.status(403).json({ error: "You cannot swipe on your own post." });
    const alreadyInterested = db
      ? await interestsCollection.findOne({ eventId: event.id, userId: req.user.id })
      : (await readInterests()).some(item => item.eventId === event.id && item.userId === req.user.id);
    if (alreadyInterested) return res.status(409).json({ error: "This event is already interested." });
    const saved = await swipeStore.put(req.user.id, event, "left");
    if (!saved) return res.status(409).json({ error: "This event was already swiped. Refresh Discover." });
    res.json({ choice: "left", eventId: event.id });
  } catch (error) { next(error); }
});

// Undo only undoes the most recent pass in the UI. Server validates the left vote.
app.delete("/api/events/:id/pass", requireUser, async (req, res, next) => {
  try {
    const undone = await swipeStore.undo(req.user.id, req.params.id);
    res.json({ undone });
  } catch (error) { next(error); }
});

app.put("/api/events/:id/interest", requireUser, async (req, res, next) => {
  try {
    const eventId = req.params.id;
    const event = await findEventById(eventId);
    if (!event) return res.status(404).json({ error: "Event not found." });
    if (event.ownerUserId === req.user.id) return res.status(403).json({ error: "You cannot like your own post." });
    let created = false;
    if (db) {
      const result = await interestsCollection.updateOne(
        { eventId, userId: req.user.id },
        { $setOnInsert: { eventId, userId: req.user.id, createdAt: Date.now() } },
        { upsert: true }
      );
      created = !!result.upsertedCount;
    } else {
      created = await changeInterests(records => {
        if (records.some(record => record.eventId === eventId && record.userId === req.user.id)) return false;
        records.push({ eventId, userId: req.user.id, createdAt: Date.now() });
        return true;
      });
    }
    try {
      // One stored vote per user/event; retries cannot add duplicate score points.
      await swipeStore.put(req.user.id, event, "right");
    } catch (error) {
      // Avoid counting a new Like if its preference vote could not be persisted.
      if (created) {
        try {
          if (db) await interestsCollection.deleteOne({ eventId, userId: req.user.id });
          else await changeInterests(records => {
            const i = records.findIndex(r => r.eventId === eventId && r.userId === req.user.id);
            if (i >= 0) records.splice(i, 1);
          });
        } catch (rollbackError) { console.error("Could not roll back interest:", rollbackError); }
      }
      throw error;
    }
    res.json({ interested: true, interestCount: await countInterest(eventId) });
  } catch (error) { next(error); }
});
app.delete("/api/events/:id/interest", requireUser, async (req, res, next) => {
  try {
    const eventId = req.params.id;
    const record = db
      ? await interestsCollection.findOne({ eventId, userId: req.user.id })
      : (await readInterests()).find(item => item.eventId === eventId && item.userId === req.user.id);
    if (record) {
      // Cancel removes the +1, but keeps the event hidden across devices.
      const event = await findEventById(eventId);
      if (event) await swipeStore.put(req.user.id, event, "cancelled");
      if (db) await interestsCollection.deleteOne({ eventId, userId: req.user.id });
      else await changeInterests(records => {
        for (let i = records.length - 1; i >= 0; i--)
          if (records[i].eventId === eventId && records[i].userId === req.user.id) records.splice(i, 1);
      });
    }
    res.json({ interested: false, interestCount: await countInterest(eventId) });
  } catch (error) { next(error); }
});

app.get("/api/health", (req, res) => res.json({ ok: true, storage: db ? "mongodb" : "local-file", recommendations: swipeStore.mode, auth: true }));
app.get("/api/events", requireUser, async (req, res, next) => {
  try {
    const swipes = await swipesForUser(req.user.id);
    const scores = categoryScores(swipes);
    const events = (await listEvents()).filter(e => e.ownerUserId !== req.user.id);
    res.json(await withInterestCounts(rankEvents(events, scores)));
  }
  catch (error) { next(error); }
});
app.get("/api/events/mine", requireUser, async (req, res, next) => {
  try { res.json(await withInterestCounts(await listEvents({ ownerUserId: req.user.id }))); }
  catch (error) { next(error); }
});
app.get("/api/events/map", requireUser, async (req, res, next) => {
  try { res.json(await withInterestCounts((await listEvents()).filter(e => e.date > Date.now()))); }
  catch (error) { next(error); }
});
app.post("/api/events", requireUser, async (req, res, next) => {
  try {
    const doc = { ...validateEvent(req.body), ownerUserId: req.user.id };
    if (db) await eventsCollection.insertOne(doc);
    else await changeEvents(events => { events.push(doc); });
    res.status(201).json({ ...safeEvent(doc), interestCount: 0 });
  } catch (error) { next(error); }
});
// Editing is only allowed for the owner; id, owner and interest records are unchanged.
app.patch("/api/events/:id", requireUser, async (req, res, next) => {
  try {
    const existing = await findEventById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Event not found." });
    if (existing.ownerUserId !== req.user.id) return res.status(403).json({ error: "You can only edit your own posts." });
    const validated = validateEvent(req.body);
    const { id, createdAt, lat, lng, ...fields } = validated;
    const locationChanged = existing.location !== validated.location;
    const patch = { ...fields, updatedAt: Date.now() };
    if (db) {
      const changes = { $set: patch };
      if (locationChanged) changes.$unset = { lat: "", lng: "" };
      const result = await eventsCollection.updateOne({ id: req.params.id, ownerUserId: req.user.id }, changes);
      if (!result.matchedCount) return res.status(403).json({ error: "You can only edit your own posts." });
    } else {
      const updated = await changeEvents(events => {
        const record = events.find(e => e.id === req.params.id && e.ownerUserId === req.user.id);
        if (!record) return false;
        Object.assign(record, patch);
        if (locationChanged) { delete record.lat; delete record.lng; }
        return true;
      });
      if (!updated) return res.status(403).json({ error: "You can only edit your own posts." });
    }
    const saved = await findEventById(req.params.id);
    res.json({ ...safeEvent(saved), interestCount: await countInterest(req.params.id) });
  } catch (error) { next(error); }
});

app.delete("/api/events/:id", requireUser, async (req, res, next) => {
  try {
    let removed;
    if (db) removed = (await eventsCollection.deleteOne({ id: req.params.id, ownerUserId: req.user.id })).deletedCount > 0;
    else removed = await changeEvents(events => {
      const i = events.findIndex(e => e.id === req.params.id && e.ownerUserId === req.user.id);
      if (i < 0) return false;
      events.splice(i, 1); return true;
    });
    if (!removed) return res.status(403).json({ error: "You can only delete your own posts." });
    if (db) await interestsCollection.deleteMany({ eventId: req.params.id });
    else await changeInterests(records => {
      for (let i = records.length - 1; i >= 0; i--)
        if (records[i].eventId === req.params.id) records.splice(i, 1);
    });
    res.json({ deleted: true });
  } catch (error) { next(error); }
});

app.post("/api/events/claim-legacy", requireUser, async (req, res, next) => {
  try {
    const owner = req.get("X-Owner-Key") || "";
    if (owner.length < 32 || owner.length > 200) return res.status(400).json({ error: "No old posts to import." });
    const ownerHash = hash(owner);
    let claimed;
    if (db) {
      const result = await eventsCollection.updateMany({ ownerHash, ownerUserId: { $exists: false } }, { $set: { ownerUserId: req.user.id }, $unset: { ownerHash: "" } });
      claimed = result.modifiedCount;
    } else {
      claimed = await changeEvents(events => {
        let count = 0;
        for (const e of events) {
          if (!e.ownerUserId && e.ownerHash === ownerHash) { e.ownerUserId = req.user.id; delete e.ownerHash; count++; }
        }
        return count;
      });
    }
    res.json({ claimed });
  } catch (error) { next(error); }
});

app.use(express.static(publicDir, { index: false }));
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "EventSwipe.html")));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) return res.status(400).json({ error: "Invalid JSON." });
  if (error.type === "entity.too.large") return res.status(413).json({ error: "Photo or request is too large." });
  if (/^(Invalid|Unknown|Choose|Image is)/.test(error.message)) return res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: "Server error. See backend terminal." });
});

async function main() {
  if (process.env.MONGODB_URI) {
    client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 7000 });
    await client.connect();
    db = client.db(process.env.MONGODB_DB || "eventswipe");
    eventsCollection = db.collection("events");
    usersCollection = db.collection("users");
    sessionsCollection = db.collection("sessions");
    interestsCollection = db.collection("interests");
    await eventsCollection.createIndex({ id: 1 }, { unique: true });
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await sessionsCollection.createIndex({ tokenHash: 1 }, { unique: true });
    await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await interestsCollection.createIndex({ eventId: 1, userId: 1 }, { unique: true });
    await interestsCollection.createIndex({ userId: 1 });
    console.log("Connected to MongoDB Atlas");
  } else {
    console.log("Using local files (backend/data/events.json and auth.json). MongoDB not connected.");
  }
  console.log("Recommendation storage:", swipeStore.mode);
  app.listen(port, "0.0.0.0", () => {
    console.log("EventSwipe: http://localhost:" + port);
    console.log("Health check: http://localhost:" + port + "/api/health");
  });
}
main().catch(error => { console.error("Failed to start:", error.message); process.exit(1); });
