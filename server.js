require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const missingAuth = [];
if (!SUPABASE_URL) missingAuth.push("SUPABASE_URL");
if (!SUPABASE_ANON_KEY) missingAuth.push("SUPABASE_ANON_KEY");
if (missingAuth.length) {
  console.error(
    `Missing required env: ${missingAuth.join(", ")}. Add them to your .env file.`
  );
  process.exit(1);
}

const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

if (!supabaseAdmin) {
  console.warn(
    "SUPABASE_SERVICE_ROLE_KEY is not set. Private reaction totals will not persist. Add it to .env for Supabase storage."
  );
}

/** Validates access_token with Supabase Auth (avoids local JWT secret mismatches). */
async function getUserFromAccessToken(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!res.ok) return null;
  return res.json();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(cors());
app.use(express.json());

app.get("/api/auth-config", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

app.get("/api/profile/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    const user = await getUserFromAccessToken(token);
    if (!user?.id) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!supabaseAdmin) {
      res.json({ totalReactions: 0, byEmoji: {} });
      return;
    }
    const { data, error } = await supabaseAdmin
      .from("reaction_stats")
      .select("emoji, count")
      .eq("user_id", user.id);
    if (error) {
      console.error("reaction_stats select:", error.message);
      res.status(500).json({ error: "Could not load stats." });
      return;
    }
    const byEmoji = {};
    let totalReactions = 0;
    for (const row of data || []) {
      byEmoji[row.emoji] = row.count;
      totalReactions += row.count;
    }
    res.json({ totalReactions, byEmoji });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load stats." });
  }
});

app.use(express.static("public"));

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || typeof token !== "string") {
    return next(new Error("Unauthorized"));
  }
  try {
    const user = await getUserFromAccessToken(token);
    if (!user?.id) {
      return next(new Error("Unauthorized"));
    }
    socket.data.userId = user.id;
    socket.data.email =
      typeof user.email === "string" ? user.email : null;
    return next();
  } catch (err) {
    console.error("Socket auth verify failed:", err?.message || err);
    return next(new Error("Unauthorized"));
  }
});

const PORT = process.env.PORT || 3000;
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MEDIATOR_NAME = "Mediator";
const REACTION_EMOJIS = ["👍", "👎", "❤️", "💀", "😂", "🔥"];
const AUTO_MESSAGE_INTERVAL = 5;

const rooms = new Map();

const DISPLAY_NAME_MAX = 40;

function sanitizeDisplayName(raw) {
  const s = String(raw ?? "")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
  return s || null;
}

async function adjustReactionCount(userId, emoji, delta) {
  if (!supabaseAdmin || !userId || !emoji || delta === 0) return;
  const { data: row, error: selErr } = await supabaseAdmin
    .from("reaction_stats")
    .select("count")
    .eq("user_id", userId)
    .eq("emoji", emoji)
    .maybeSingle();
  if (selErr) throw selErr;
  const cur = row?.count ?? 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) {
    const { error: delErr } = await supabaseAdmin
      .from("reaction_stats")
      .delete()
      .eq("user_id", userId)
      .eq("emoji", emoji);
    if (delErr) throw delErr;
  } else {
    const { error: upErr } = await supabaseAdmin.from("reaction_stats").upsert(
      { user_id: userId, emoji, count: next },
      { onConflict: "user_id,emoji" }
    );
    if (upErr) throw upErr;
  }
}

async function persistReactionChange(authorUserId, oldEmoji, newEmoji) {
  if (!supabaseAdmin || !authorUserId) return;
  if (oldEmoji && (!newEmoji || newEmoji !== oldEmoji)) {
    await adjustReactionCount(authorUserId, oldEmoji, -1);
  }
  if (newEmoji && newEmoji !== oldEmoji) {
    await adjustReactionCount(authorUserId, newEmoji, 1);
  }
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      context: null,
      messages: [],
      mediationMode: "conciliatory",
      messagesSinceAutoCheck: 0
    });
  }
  return rooms.get(roomCode);
}

function formatConversationForPrompt(messages) {
  return messages
    .map((m) => {
      let line = `${m.username}: ${m.text}`;
      const r =
        m.reactions && typeof m.reactions === "object" ? m.reactions : {};
      const entries = Object.entries(r).filter(([, e]) =>
        REACTION_EMOJIS.includes(e)
      );
      if (entries.length) {
        const summary = entries.map(([u, e]) => `${u} ${e}`).join(", ");
        line += ` [reactions: ${summary}]`;
      }
      return line;
    })
    .join("\n");
}

function getFeedbackSystemPrompt(mode) {
  const base =
    "You are an impartial conflict mediator. Analyze disagreements with empathy, fairness, and structure.";
  if (mode === "debate") {
    return `${base} When analyzing, pay special attention to logical fallacies, weak reasoning, and unsupported claims in the arguments.`;
  }
  return `${base} When analyzing, emphasize shared interests, possible common ground, and ways parties might align despite disagreement.`;
}

function getParticipantSystemPrompt(mode) {
  if (mode === "debate") {
    return [
      `You are "${MEDIATOR_NAME}", a participant in this group chat.`,
      "Respond in plain text only. When you have something useful to add, write a short message (one or a few sentences).",
      "Focus on identifying logical fallacies, flawed reasoning, or unfair rhetoric when that would help the discussion.",
      "If you have nothing useful to contribute right now, output nothing: no text, no punctuation, no placeholder."
    ].join(" ");
  }
  return [
    `You are "${MEDIATOR_NAME}", a participant in this group chat.`,
    "Respond in plain text only. When you have something useful to add, write a short message (one or a few sentences).",
    "Focus on finding common ground, shared goals, and constructive bridges between positions.",
    "If you have nothing useful to contribute right now, output nothing: no text, no punctuation, no placeholder."
  ].join(" ");
}

async function generateParticipantReply({ problem, context, messages, mode }) {
  if (!client) return "";
  const conversation = formatConversationForPrompt(messages);
  const userPrompt = [
    `Problem: ${problem}`,
    `Context (optional): ${context || "N/A"}`,
    "Conversation (including reaction notes where present):",
    conversation
  ].join("\n");

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: getParticipantSystemPrompt(mode) },
      { role: "user", content: userPrompt }
    ]
  });

  return completion.choices?.[0]?.message?.content ?? "";
}

async function runAutoParticipantMediation(roomCode) {
  if (!client) return;
  const room = rooms.get(roomCode);
  if (!room || !room.context) return;

  const problem = room.context.problem || "";
  if (!problem) return;

  const mode = room.mediationMode === "debate" ? "debate" : "conciliatory";
  const raw = await generateParticipantReply({
    problem,
    context: room.context.context || "",
    messages: room.messages,
    mode
  });
  const trimmed = (raw || "").trim();
  if (!trimmed) return;

  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    username: MEDIATOR_NAME,
    text: trimmed,
    ts: new Date().toISOString(),
    reactions: {},
    authorUserId: null
  };
  room.messages.push(msg);
  io.to(roomCode).emit("newMessage", msg);
}

io.on("connection", (socket) => {
  socket.on("createRoom", (payload, cb) => {
    if (!socket.data.userId) {
      cb({ ok: false, error: "Not authenticated." });
      return;
    }
    const problem = (payload?.problem || "").trim();
    const context = (payload?.context || "").trim();
    const username = sanitizeDisplayName(payload?.username);
    if (!username || !problem) {
      cb({ ok: false, error: "Display name and problem are required." });
      return;
    }

    const roomCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = getRoom(roomCode);
    room.context = { problem, context };
    room.mediationMode = "conciliatory";
    room.messagesSinceAutoCheck = 0;

    socket.join(roomCode);
    socket.data.username = username;
    socket.data.roomCode = roomCode;

    cb({
      ok: true,
      roomCode,
      context: room.context,
      messages: room.messages,
      mediationMode: room.mediationMode
    });
  });

  socket.on("leaveRoom", (cb) => {
    if (!socket.data.userId) {
      cb?.({ ok: false, error: "Not authenticated." });
      return;
    }
    const roomCode = socket.data.roomCode;
    if (roomCode) {
      socket.leave(roomCode);
    }
    socket.data.roomCode = undefined;
    socket.data.username = undefined;
    cb?.({ ok: true });
  });

  socket.on("joinRoom", (payload, cb) => {
    if (!socket.data.userId) {
      cb({ ok: false, error: "Not authenticated." });
      return;
    }
    const roomCodeRaw = (payload?.roomCode || "").trim();
    const username = sanitizeDisplayName(payload?.username);
    if (!username || !roomCodeRaw) {
      cb({ ok: false, error: "Display name and room code are required." });
      return;
    }

    const normalized = roomCodeRaw.toUpperCase();
    if (!rooms.has(normalized)) {
      cb({ ok: false, error: "Room not found. Check the room code." });
      return;
    }

    socket.join(normalized);
    socket.data.username = username;
    socket.data.roomCode = normalized;
    const room = getRoom(normalized);

    cb({
      ok: true,
      roomCode: normalized,
      context: room.context,
      messages: room.messages,
      mediationMode: room.mediationMode
    });
  });

  socket.on("setMediationMode", (payload, cb) => {
    if (!socket.data.userId) {
      cb?.({ ok: false, error: "Not authenticated." });
      return;
    }
    const roomCode = socket.data.roomCode;
    const mode = payload?.mode;
    if (!roomCode || (mode !== "debate" && mode !== "conciliatory")) {
      cb?.({ ok: false, error: "Invalid mode." });
      return;
    }
    const room = rooms.get(roomCode);
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }
    room.mediationMode = mode;
    io.to(roomCode).emit("mediationModeChanged", { mode });
    cb?.({ ok: true });
  });

  socket.on("setReaction", async (payload, cb) => {
    if (!socket.data.userId) {
      cb?.({ ok: false, error: "Not authenticated." });
      return;
    }
    const roomCode = socket.data.roomCode;
    const username = socket.data.username;
    const reactorId = socket.data.userId;
    const messageId = payload?.messageId;
    const emoji = payload?.emoji;

    if (!roomCode || !username || !messageId) {
      cb?.({ ok: false, error: "Could not set reaction." });
      return;
    }
    if (emoji === undefined) {
      cb?.({ ok: false, error: "Missing emoji (send null to remove)." });
      return;
    }
    if (emoji !== null && (typeof emoji !== "string" || !REACTION_EMOJIS.includes(emoji))) {
      cb?.({ ok: false, error: "Invalid emoji." });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      cb?.({ ok: false, error: "Room not found." });
      return;
    }

    const msg = room.messages.find((m) => m.id === messageId);
    if (!msg) {
      cb?.({ ok: false, error: "Message not found." });
      return;
    }

    if (!msg.reactions || typeof msg.reactions !== "object") {
      msg.reactions = {};
    }

    const oldEmoji = msg.reactions[username];
    const snapshot = { ...msg.reactions };

    if (emoji === null) {
      delete msg.reactions[username];
    } else {
      msg.reactions[username] = emoji;
    }

    const authorId = msg.authorUserId;
    if (authorId && reactorId !== authorId) {
      try {
        await persistReactionChange(authorId, oldEmoji, emoji);
      } catch (err) {
        console.error("persistReactionChange:", err);
        msg.reactions = snapshot;
        cb?.({ ok: false, error: "Could not save reaction stats." });
        return;
      }
    }

    io.to(roomCode).emit("reactionUpdated", {
      messageId,
      reactions: { ...msg.reactions }
    });
    cb?.({ ok: true });
  });

  socket.on("chatMessage", (payload, cb) => {
    if (!socket.data.userId) {
      cb?.({ ok: false, error: "Not authenticated." });
      return;
    }
    const roomCode = socket.data.roomCode;
    const username = socket.data.username;
    const text = (payload?.text || "").trim();

    if (!roomCode || !username || !text) {
      cb?.({ ok: false, error: "Could not send message." });
      return;
    }

    const room = getRoom(roomCode);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      username,
      text,
      ts: new Date().toISOString(),
      reactions: {},
      authorUserId: socket.data.userId
    };
    room.messages.push(msg);

    room.messagesSinceAutoCheck += 1;
    if (room.messagesSinceAutoCheck >= AUTO_MESSAGE_INTERVAL) {
      room.messagesSinceAutoCheck = 0;
      runAutoParticipantMediation(roomCode).catch((err) =>
        console.error("Auto mediation failed:", err)
      );
    }

    io.to(roomCode).emit("newMessage", msg);
    cb?.({ ok: true });
  });
});

app.post("/api/mediate", async (req, res) => {
  try {
    if (!client) {
      res.status(500).json({
        error: "Missing OPENAI_API_KEY. Add it to your .env file."
      });
      return;
    }

    const { problem, context, messages, mode } = req.body || {};
    const mediationMode =
      mode === "debate" || mode === "conciliatory" ? mode : "conciliatory";

    if (!problem || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Problem and messages are required." });
      return;
    }

    const conversation = formatConversationForPrompt(messages);

    const systemPrompt = getFeedbackSystemPrompt(mediationMode);
    const userPrompt = [
      `Problem: ${problem}`,
      `Context (optional): ${context || "N/A"}`,
      "Conversation:",
      conversation,
      "",
      "Return your answer in this exact format:",
      "1) Argument Summary",
      "2) Fact Check (label each claim as Supported, Unclear, or Possibly Incorrect based ONLY on given conversation; do not hallucinate external facts)",
      "3) Recommended Guidance (actionable next steps for each person and a shared plan)"
    ].join("\n");

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const feedback =
      completion.choices?.[0]?.message?.content || "No feedback generated.";
    res.json({ feedback });
  } catch (error) {
    res.status(500).json({
      error: "Failed to generate mediation feedback.",
      details: error?.message || "Unknown error"
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
