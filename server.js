// server.js

const express = require("express");
const { initDb, run, get, all } = require("./db");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * Fake auth via headers:
 *  - x-user-id: number (required)
 *  - x-dept-id: number (optional)
 *  - x-org-id: number (optional)
 */
function requireActor(req, res, next) {
  const userId = Number(req.header("x-user-id"));
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Missing/invalid x-user-id header" });
  }
  const deptId = req.header("x-dept-id") ? Number(req.header("x-dept-id")) : null;
  const orgId = req.header("x-org-id") ? Number(req.header("x-org-id")) : null;

  req.actor = { userId, deptId: Number.isFinite(deptId) ? deptId : null, orgId: Number.isFinite(orgId) ? orgId : null };
  next();
}

/**
 * Permission rules (ALLOW-only):
 * - owner always allowed
 * - VIEW: ALLOW VIEW or EDIT on (USER/DEPT/ORG)
 * - EDIT: ALLOW EDIT on (USER/DEPT/ORG)
 * - If share_mode=ATTENDEES_ONLY: for VIEW, actor must be attendee (owner exception)
 */
async function canViewEvent(eventId, actor) {
  const ev = await get("SELECT * FROM events WHERE event_id = ?", [eventId]);
  if (!ev || ev.status === "DELETED") return { ok: false, reason: "NOT_FOUND" };
  if (ev.owner_user_id === actor.userId) return { ok: true, ev };

  if (ev.share_mode === "ATTENDEES_ONLY") {
    const attendee = await get(
      "SELECT 1 AS ok FROM event_attendees WHERE event_id = ? AND user_id = ?",
      [eventId, actor.userId]
    );
    if (!attendee) return { ok: false, reason: "ATTENDEES_ONLY" };
    // 참석자라면 VIEW 허용 (ACL이 없어도) -> 정책 선택
    // 오늘 밤 최소 구현이라 이렇게 단순화함
    return { ok: true, ev };
  }

  // share_mode=ALL: ACL 또는 기본 정책(오늘은 ACL 중심 + owner만 기본 허용)
  const principals = [
    { type: "USER", id: actor.userId },
    ...(actor.deptId ? [{ type: "DEPT", id: actor.deptId }] : []),
    ...(actor.orgId ? [{ type: "ORG", id: actor.orgId }] : []),
  ];

  // VIEW는 VIEW or EDIT 둘 다 허용(EDIT ⊇ VIEW)
  for (const p of principals) {
    const row = await get(
      `SELECT 1 AS ok FROM event_acl
       WHERE event_id = ? AND principal_type = ? AND principal_id = ?
         AND effect = 'ALLOW' AND action IN ('VIEW','EDIT')
       LIMIT 1`,
      [eventId, p.type, p.id]
    );
    if (row) return { ok: true, ev };
  }

  return { ok: false, reason: "NO_PERMISSION" };
}

async function canEditEvent(eventId, actor) {
  const ev = await get("SELECT * FROM events WHERE event_id = ?", [eventId]);
  if (!ev || ev.status === "DELETED") return { ok: false, reason: "NOT_FOUND" };
  if (ev.owner_user_id === actor.userId) return { ok: true, ev };

  const principals = [
    { type: "USER", id: actor.userId },
    ...(actor.deptId ? [{ type: "DEPT", id: actor.deptId }] : []),
    ...(actor.orgId ? [{ type: "ORG", id: actor.orgId }] : []),
  ];

  for (const p of principals) {
    const row = await get(
      `SELECT 1 AS ok FROM event_acl
       WHERE event_id = ? AND principal_type = ? AND principal_id = ?
         AND effect = 'ALLOW' AND action = 'EDIT'
       LIMIT 1`,
      [eventId, p.type, p.id]
    );
    if (row) return { ok: true, ev };
  }

  return { ok: false, reason: "NO_PERMISSION" };
}

/** Health */
app.get("/health", (req, res) => res.json({ ok: true }));

/** Create event */
app.post("/events", requireActor, async (req, res) => {
  try {
    const { title, start_at, end_at, event_type, share_mode } = req.body;

    if (!title || !start_at || !end_at) {
      return res.status(400).json({ error: "title/start_at/end_at are required" });
    }
    if (!["PERSONAL", "DEPT", "ORG"].includes(event_type)) {
      return res.status(400).json({ error: "event_type must be PERSONAL|DEPT|ORG" });
    }
    if (!["ALL", "ATTENDEES_ONLY"].includes(share_mode)) {
      return res.status(400).json({ error: "share_mode must be ALL|ATTENDEES_ONLY" });
    }

    const r = await run(
      `INSERT INTO events (owner_user_id, title, start_at, end_at, event_type, share_mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.actor.userId, title, start_at, end_at, event_type, share_mode]
    );

    const ev = await get("SELECT * FROM events WHERE event_id = ?", [r.lastID]);
    res.status(201).json(ev);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** Add ACL rule (ALLOW only) */
app.post("/events/:id/acl", requireActor, async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId)) return res.status(400).json({ error: "invalid event id" });

    // Only editor/owner can add ACL
    const edit = await canEditEvent(eventId, req.actor);
    if (!edit.ok) return res.status(403).json({ error: "forbidden", reason: edit.reason });

    const { principal_type, principal_id, action } = req.body;
    if (!["USER", "DEPT", "ORG"].includes(principal_type)) {
      return res.status(400).json({ error: "principal_type must be USER|DEPT|ORG" });
    }
    const pid = Number(principal_id);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: "principal_id must be positive int" });
    if (!["VIEW", "EDIT"].includes(action)) return res.status(400).json({ error: "action must be VIEW|EDIT" });

    const r = await run(
      `INSERT INTO event_acl (event_id, principal_type, principal_id, action, effect)
       VALUES (?, ?, ?, ?, 'ALLOW')`,
      [eventId, principal_type, pid, action]
    );

    const row = await get("SELECT * FROM event_acl WHERE acl_id = ?", [r.lastID]);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** Add attendee */
app.post("/events/:id/attendees", requireActor, async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId)) return res.status(400).json({ error: "invalid event id" });

    // Only editor/owner can add attendees
    const edit = await canEditEvent(eventId, req.actor);
    if (!edit.ok) return res.status(403).json({ error: "forbidden", reason: edit.reason });

    const { user_id, role } = req.body;
    const uid = Number(user_id);
    if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: "user_id must be positive int" });

    const safeRole = role ? String(role) : "REQUIRED";

    await run(
      `INSERT OR REPLACE INTO event_attendees (event_id, user_id, role, response_status)
       VALUES (?, ?, ?, COALESCE((SELECT response_status FROM event_attendees WHERE event_id=? AND user_id=?),'PENDING'))`,
      [eventId, uid, safeRole, eventId, uid]
    );

    const row = await get(
      "SELECT * FROM event_attendees WHERE event_id = ? AND user_id = ?",
      [eventId, uid]
    );
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** View event (permission check) */
app.get("/events/:id", requireActor, async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId)) return res.status(400).json({ error: "invalid event id" });

    const v = await canViewEvent(eventId, req.actor);
    if (!v.ok) {
      const code = v.reason === "NOT_FOUND" ? 404 : 403;
      return res.status(code).json({ error: v.reason });
    }

    const ev = v.ev;
    const attendees = await all("SELECT * FROM event_attendees WHERE event_id = ?", [eventId]);
    const acl = await all("SELECT * FROM event_acl WHERE event_id = ?", [eventId]);

    res.json({ event: ev, attendees, acl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** Edit event (optional but good) */
app.patch("/events/:id", requireActor, async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId)) return res.status(400).json({ error: "invalid event id" });

    const edit = await canEditEvent(eventId, req.actor);
    if (!edit.ok) return res.status(403).json({ error: "forbidden", reason: edit.reason });

    const { title, start_at, end_at, share_mode } = req.body;
    const next = {
      title: title ?? edit.ev.title,
      start_at: start_at ?? edit.ev.start_at,
      end_at: end_at ?? edit.ev.end_at,
      share_mode: share_mode ?? edit.ev.share_mode,
    };

    if (!["ALL", "ATTENDEES_ONLY"].includes(next.share_mode)) {
      return res.status(400).json({ error: "share_mode must be ALL|ATTENDEES_ONLY" });
    }

    await run(
      `UPDATE events
       SET title = ?, start_at = ?, end_at = ?, share_mode = ?, updated_at = datetime('now')
       WHERE event_id = ?`,
      [next.title, next.start_at, next.end_at, next.share_mode, eventId]
    );

    const ev = await get("SELECT * FROM events WHERE event_id = ?", [eventId]);
    res.json(ev);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Try GET /health`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
