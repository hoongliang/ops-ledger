// Vercel serverless function — same contract as the Netlify one:
//   GET  /api/tasks  -> { rev, updatedAt, data }
//   PUT  /api/tasks  <- { rev, data }   409 + current record if rev is stale
//
// Storage is Redis (Upstash, added through the Vercel Marketplace). Vercel's own
// KV product was retired, and Vercel Blob is object storage sitting behind a CDN,
// which is awkward for a document that changes all day. Redis gives an atomic
// compare-and-set, so two people saving at once can't lose each other's work.
//
// No npm dependencies: Upstash speaks plain HTTP.

const DATA_KEY = "ops-ledger:data";
const REV_KEY = "ops-ledger:rev";
const BACKUP_KEY = "ops-ledger:backups";
const BACKUPS_TO_KEEP = 20;
const MAX_BYTES = 1_000_000;

const BRAND_KEYS = ["hallawaykl", "hallawaypj", "nongfu", "oho", "general"];

// Vercel's Upstash integration injects KV_REST_API_*; a plain Upstash account
// gives UPSTASH_REDIS_REST_*. Accept either.
function credentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "No Redis credentials. Add the Upstash integration to this project in the Vercel dashboard, then redeploy."
    );
  }
  return { url, token };
}

async function upstash(...command) {
  const { url, token } = credentials();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command.map(String)),
  });
  const payload = await res.json();
  if (!res.ok || payload.error) {
    throw new Error(`Redis error: ${payload.error || res.status}`);
  }
  return payload.result;
}

// Swapped out in tests.
export const runtime = { command: upstash };

// Bumps the version and writes the record only if nobody else got there first.
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[2])
if not current then current = '0' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('LPUSH', KEYS[3], ARGV[2])
redis.call('LTRIM', KEYS[3], 0, ARGV[4])
return 1
`;

function emptyData() {
  const base = { names: [] };
  BRAND_KEYS.forEach((k) => (base[k] = []));
  return base;
}

function str(value, max = 2000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function cleanTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = str(raw.text, 500).trim();
  if (!text) return null;
  return {
    id: str(raw.id, 60) || Math.random().toString(36).slice(2, 12),
    text,
    priority: ["high", "medium", "low"].includes(raw.priority) ? raw.priority : "medium",
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate || "") ? raw.dueDate : null,
    assignee: raw.assignee ? str(raw.assignee, 80) : null,
    notes: str(raw.notes, 2000),
    done: raw.done === true,
    completedAt: raw.completedAt ? str(raw.completedAt, 40) : null,
    createdAt: raw.createdAt ? str(raw.createdAt, 40) : new Date().toISOString(),
  };
}

// Nothing from the browser is trusted: shape, types and sizes are re-checked here.
function cleanData(raw) {
  if (!raw || typeof raw !== "object") return emptyData();
  const out = emptyData();
  BRAND_KEYS.forEach((key) => {
    if (Array.isArray(raw[key])) out[key] = raw[key].slice(0, 2000).map(cleanTask).filter(Boolean);
  });
  if (Array.isArray(raw.names)) {
    out.names = [...new Set(raw.names.map((n) => str(n, 80).trim()).filter(Boolean))].slice(0, 200);
  }
  return out;
}

async function readRecord() {
  const stored = await runtime.command("GET", DATA_KEY);
  if (!stored) return { rev: 0, updatedAt: null, data: emptyData() };
  let parsed;
  try {
    parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
  } catch {
    return { rev: 0, updatedAt: null, data: emptyData() };
  }
  return {
    rev: typeof parsed.rev === "number" ? parsed.rev : 0,
    updatedAt: parsed.updatedAt || null,
    data: cleanData(parsed.data),
  };
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  try {
    if (req.method === "GET") {
      return res.status(200).json(await readRecord());
    }

    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "bad_request", message: "Body must be JSON." });
      }
      if (typeof body.rev !== "number" || body.rev < 0) {
        return res.status(400).json({ error: "bad_request", message: "Body needs the rev you loaded." });
      }

      const next = {
        rev: body.rev + 1,
        updatedAt: new Date().toISOString(),
        data: cleanData(body.data),
      };

      const serialized = JSON.stringify(next);
      if (serialized.length > MAX_BYTES) {
        return res.status(413).json({ error: "too_large", message: "That save is over the 1 MB limit." });
      }

      const applied = await runtime.command(
        "EVAL", CAS_SCRIPT, 3,
        DATA_KEY, REV_KEY, BACKUP_KEY,
        body.rev, serialized, next.rev, BACKUPS_TO_KEEP - 1
      );

      if (Number(applied) !== 1) {
        // Someone else saved first. Hand back their version so the browser
        // can replay this edit on top of it.
        return res.status(409).json({ error: "conflict", ...(await readRecord()) });
      }

      return res.status(200).json(next);
    }

    res.setHeader("allow", "GET, PUT");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server_error", message: err.message });
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
