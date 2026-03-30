require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const rooms = new Map();

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      context: null,
      messages: []
    });
  }
  return rooms.get(roomCode);
}

io.on("connection", (socket) => {
  socket.on("createRoom", (payload, cb) => {
    const { username, problem, context } = payload || {};
    if (!username || !problem) {
      cb({ ok: false, error: "Username and problem are required." });
      return;
    }

    const roomCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = getRoom(roomCode);
    room.context = { problem, context: context || "" };

    socket.join(roomCode);
    socket.data.username = username;
    socket.data.roomCode = roomCode;

    cb({ ok: true, roomCode, context: room.context, messages: room.messages });
  });

  socket.on("joinRoom", (payload, cb) => {
    const { username, roomCode } = payload || {};
    if (!username || !roomCode) {
      cb({ ok: false, error: "Username and room code are required." });
      return;
    }

    const normalized = roomCode.toUpperCase();
    if (!rooms.has(normalized)) {
      cb({ ok: false, error: "Room not found. Check the room code." });
      return;
    }

    socket.join(normalized);
    socket.data.username = username;
    socket.data.roomCode = normalized;
    const room = getRoom(normalized);

    cb({ ok: true, roomCode: normalized, context: room.context, messages: room.messages });
  });

  socket.on("chatMessage", (payload, cb) => {
    const roomCode = socket.data.roomCode;
    const username = socket.data.username;
    const text = (payload?.text || "").trim();

    if (!roomCode || !username || !text) {
      cb?.({ ok: false, error: "Could not send message." });
      return;
    }

    const room = getRoom(roomCode);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username,
      text,
      ts: new Date().toISOString()
    };
    room.messages.push(msg);

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

    const { problem, context, messages } = req.body || {};
    if (!problem || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Problem and messages are required." });
      return;
    }

    const conversation = messages
      .map((m) => `${m.username}: ${m.text}`)
      .join("\n");

    const systemPrompt =
      "You are an impartial conflict mediator. Analyze two-party disagreements with empathy, fairness, and structure.";
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

    const feedback = completion.choices?.[0]?.message?.content || "No feedback generated.";
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
