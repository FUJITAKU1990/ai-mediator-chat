import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const REACTION_EMOJIS = ["👍", "👎", "❤️", "💀", "😂", "🔥"];

const ioConnect = globalThis.io;
if (typeof ioConnect !== "function") {
  throw new Error("Socket.IO client not loaded.");
}

const authCard = document.getElementById("authCard");
const setupCard = document.getElementById("setupCard");
const chatCard = document.getElementById("chatCard");
const authError = document.getElementById("authError");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const signInBtn = document.getElementById("signInBtn");
const signUpBtn = document.getElementById("signUpBtn");
const sessionEmail = document.getElementById("sessionEmail");
const sessionEmailChat = document.getElementById("sessionEmailChat");
const statsModal = document.getElementById("statsModal");
const statsModalBody = document.getElementById("statsModalBody");
const statsModalClose = document.getElementById("statsModalClose");
const statsModalBackdrop = document.getElementById("statsModalBackdrop");
const statsModalHint = document.getElementById("statsModalHint");
const statsModalTitle = document.getElementById("statsModalTitle");
const statsTabChat = document.getElementById("statsTabChat");
const statsTabAlltime = document.getElementById("statsTabAlltime");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");

const usernameInput = document.getElementById("usernameInput");
const problemInput = document.getElementById("problemInput");
const contextInput = document.getElementById("contextInput");
const roomCodeInput = document.getElementById("roomCodeInput");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const roomLabel = document.getElementById("roomLabel");
const problemLabel = document.getElementById("problemLabel");
const contextLabel = document.getElementById("contextLabel");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const mediateBtn = document.getElementById("mediateBtn");
const feedbackBox = document.getElementById("feedbackBox");
const modeConciliatoryBtn = document.getElementById("modeConciliatory");
const modeDebateBtn = document.getElementById("modeDebate");

let supabase = null;
let socket = null;
let accessToken = null;
let pendingLeaveOnClose = false;

/**
 * Reactions received on the current user's messages in this room (client-side).
 * Skips self-reactions (same display name as the current user).
 */
function aggregateMyReactionsInRoom(messages, userId, myDisplayName) {
  const byEmoji = {};
  let totalReactions = 0;
  if (!userId || !Array.isArray(messages)) {
    return { totalReactions: 0, byEmoji: {} };
  }
  for (const msg of messages) {
    if (msg.authorUserId !== userId) continue;
    const r =
      msg.reactions && typeof msg.reactions === "object" ? msg.reactions : {};
    for (const [reactorName, emoji] of Object.entries(r)) {
      if (reactorName === myDisplayName) continue;
      if (!REACTION_EMOJIS.includes(emoji)) continue;
      byEmoji[emoji] = (byEmoji[emoji] || 0) + 1;
      totalReactions += 1;
    }
  }
  return { totalReactions, byEmoji };
}

function renderStatsIntoBody(totalReactions, byEmoji, emptyMessage) {
  statsModalBody.innerHTML = "";
  const totalEl = document.createElement("div");
  totalEl.className = "statsTotal";
  totalEl.textContent = `Total reactions received: ${totalReactions}`;
  statsModalBody.appendChild(totalEl);
  const lines = REACTION_EMOJIS.filter((e) => (byEmoji[e] || 0) > 0).map(
    (e) => `${e} ${byEmoji[e]}`
  );
  if (lines.length === 0) {
    const p = document.createElement("p");
    p.className = "small";
    p.textContent = emptyMessage;
    statsModalBody.appendChild(p);
  } else {
    const row = document.createElement("div");
    row.className = "statsEmojiRow";
    lines.forEach((line) => {
      const span = document.createElement("span");
      span.textContent = line;
      row.appendChild(span);
    });
    statsModalBody.appendChild(row);
  }
}

function setSessionEmailLabel(text) {
  const t = text || "";
  sessionEmail.textContent = t;
  if (sessionEmailChat) sessionEmailChat.textContent = t;
}

let roomState = {
  roomCode: "",
  username: "",
  problem: "",
  context: "",
  mediationMode: "conciliatory",
  messages: []
};

function showAuthError(message) {
  if (!message) {
    authError.textContent = "";
    authError.classList.add("hidden");
    return;
  }
  authError.textContent = message;
  authError.classList.remove("hidden");
}

function setAuthUiVisible(signedIn) {
  authCard.classList.toggle("hidden", signedIn);
  setupCard.classList.toggle("hidden", !signedIn);
  if (!signedIn) {
    chatCard.classList.add("hidden");
  }
}

function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  accessToken = null;
}

function rejoinRoomIfNeeded() {
  if (!socket?.connected) return;
  const code = roomState.roomCode?.trim();
  const name = roomState.username?.trim();
  if (!code || !name) return;
  socket.emit(
    "joinRoom",
    { username: name, roomCode: code },
    (resp) => {
      if (!resp?.ok) {
        console.warn("Re-join room failed:", resp?.error);
      }
    }
  );
}

function connectSocket(token) {
  disconnectSocket();
  accessToken = token;
  socket = ioConnect({
    auth: { token: accessToken },
    reconnection: true
  });

  socket.on("connect", () => {
    rejoinRoomIfNeeded();
  });

  socket.on("connect_error", (err) => {
    console.error(err);
    showAuthError(
      err?.message === "Unauthorized"
        ? "Session expired or invalid. Please sign in again."
        : "Could not connect to chat. Try signing in again."
    );
    authCard.classList.remove("hidden");
    setupCard.classList.add("hidden");
    chatCard.classList.add("hidden");
  });

  socket.on("newMessage", (msg) => {
    roomState.messages.push(msg);
    renderMessage(msg);
  });

  socket.on("reactionUpdated", ({ messageId, reactions }) => {
    const m = roomState.messages.find((x) => x.id === messageId);
    if (m) {
      m.reactions = reactions;
    }
    updateMessageReactions(messageId, reactions);
  });

  socket.on("mediationModeChanged", ({ mode }) => {
    if (mode === "debate" || mode === "conciliatory") {
      roomState.mediationMode = mode;
      updateModeButtons();
    }
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function summarizeReactions(reactions) {
  if (!reactions || typeof reactions !== "object") return "";
  const counts = {};
  for (const e of Object.values(reactions)) {
    if (!REACTION_EMOJIS.includes(e)) continue;
    counts[e] = (counts[e] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([emoji, n]) =>
    n > 1 ? `${emoji}×${n}` : emoji
  );
  return parts.join(" ");
}

function updateModeButtons() {
  const m = roomState.mediationMode;
  modeConciliatoryBtn.classList.toggle("modeBtn-active", m === "conciliatory");
  modeDebateBtn.classList.toggle("modeBtn-active", m === "debate");
}

function setMediationMode(mode) {
  if (mode !== "debate" && mode !== "conciliatory") return;
  if (!socket?.connected) return;
  socket.emit("setMediationMode", { mode }, (resp) => {
    if (!resp?.ok) {
      alert(resp?.error || "Could not change mode.");
      return;
    }
    roomState.mediationMode = mode;
    updateModeButtons();
  });
}

modeConciliatoryBtn.addEventListener("click", () =>
  setMediationMode("conciliatory")
);
modeDebateBtn.addEventListener("click", () => setMediationMode("debate"));

function updateMessageReactions(messageId, reactions) {
  const wrap = messagesEl.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
  if (!wrap) return;
  const summaryEl = wrap.querySelector(".reactions-summary");
  if (summaryEl) {
    const s = summarizeReactions(reactions);
    summaryEl.textContent = s || "";
  }
  const picker = wrap.querySelector(".reaction-picker");
  if (!picker) return;
  const buttons = picker.querySelectorAll(".reaction-btn");
  const mine = reactions?.[roomState.username];
  buttons.forEach((btn) => {
    const emoji = btn.dataset.emoji;
    btn.classList.toggle("reaction-btn-active", mine === emoji);
  });
}

function renderMessage(msg) {
  const wrap = document.createElement("div");
  wrap.className =
    "msg" + (msg.username === "Mediator" ? " msg-mediator" : "");
  wrap.dataset.msgId = msg.id;

  const t = new Date(msg.ts).toLocaleTimeString();
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<strong>${escapeHtml(msg.username)}</strong> • ${t}`;

  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = msg.text;

  const summary = document.createElement("div");
  summary.className = "reactions-summary";
  summary.textContent = summarizeReactions(msg.reactions) || "";

  const picker = document.createElement("div");
  picker.className = "reaction-picker";

  const reactions = msg.reactions || {};
  REACTION_EMOJIS.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reaction-btn";
    btn.dataset.emoji = emoji;
    btn.textContent = emoji;
    if (reactions[roomState.username] === emoji) {
      btn.classList.add("reaction-btn-active");
    }
    btn.addEventListener("click", () => {
      const current = roomState.messages.find((m) => m.id === msg.id)
        ?.reactions?.[roomState.username];
      const next = current === emoji ? null : emoji;
      socket.emit(
        "setReaction",
        { messageId: msg.id, emoji: next },
        (resp) => {
          if (!resp?.ok) {
            alert(resp?.error || "Could not update reaction.");
          }
        }
      );
    });
    picker.appendChild(btn);
  });

  wrap.appendChild(meta);
  wrap.appendChild(body);
  wrap.appendChild(summary);
  wrap.appendChild(picker);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showRoom(data, username) {
  roomState.roomCode = data.roomCode;
  roomState.username = username;
  roomState.problem = data.context?.problem || "";
  roomState.context = data.context?.context || "";
  roomState.messages = data.messages || [];
  roomState.mediationMode =
    data.mediationMode === "debate" ? "debate" : "conciliatory";

  roomLabel.textContent = `Room code: ${roomState.roomCode}`;
  problemLabel.textContent = `Problem: ${roomState.problem}`;
  contextLabel.textContent = roomState.context
    ? `Context: ${roomState.context}`
    : "";

  messagesEl.innerHTML = "";
  roomState.messages.forEach(renderMessage);
  updateModeButtons();

  setupCard.classList.add("hidden");
  chatCard.classList.remove("hidden");
}

createBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const problem = problemInput.value.trim();
  const context = contextInput.value.trim();
  if (!username || !problem) {
    alert("Display name and problem are required to create a room.");
    return;
  }
  if (!socket?.connected) {
    alert("Not connected. Please wait or sign in again.");
    return;
  }

  socket.emit("createRoom", { username, problem, context }, (resp) => {
    if (!resp.ok) {
      alert(resp.error || "Failed to create room.");
      return;
    }
    showRoom(resp, username);
    alert(`Share this room code with the other person: ${resp.roomCode}`);
  });
});

joinBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const roomCode = roomCodeInput.value.trim();
  if (!username || !roomCode) {
    alert("Display name and room code are required to join.");
    return;
  }
  if (!socket?.connected) {
    alert("Not connected. Please wait or sign in again.");
    return;
  }

  socket.emit("joinRoom", { username, roomCode }, (resp) => {
    if (!resp.ok) {
      alert(resp.error || "Failed to join room.");
      return;
    }
    showRoom(resp, username);
  });
});

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  if (!socket?.connected) {
    alert("Not connected. Please sign in again.");
    return;
  }

  socket.emit("chatMessage", { text }, (resp) => {
    if (!resp?.ok) {
      alert(resp?.error || "Failed to send message.");
      return;
    }
    messageInput.value = "";
  });
});

mediateBtn.addEventListener("click", async () => {
  if (roomState.messages.length === 0) {
    alert("No messages yet. Start chatting first.");
    return;
  }

  mediateBtn.disabled = true;
  mediateBtn.textContent = "Generating feedback...";
  feedbackBox.classList.add("hidden");

  try {
    const resp = await fetch("/api/mediate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem: roomState.problem,
        context: roomState.context,
        messages: roomState.messages,
        mode: roomState.mediationMode
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "Failed to get mediation feedback.");
    }

    feedbackBox.textContent = data.feedback;
    feedbackBox.classList.remove("hidden");
  } catch (err) {
    alert(err.message || "Error while generating feedback.");
  } finally {
    mediateBtn.disabled = false;
    mediateBtn.textContent = "Get AI Mediation Feedback";
  }
});

async function signIn() {
  showAuthError("");
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    showAuthError("Enter email and password.");
    return;
  }
  signInBtn.disabled = true;
  signUpBtn.disabled = true;
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  signInBtn.disabled = false;
  signUpBtn.disabled = false;
  if (error) {
    showAuthError(error.message);
    return;
  }
  if (data.session?.access_token) {
    setSessionEmailLabel(data.session.user.email || "");
    connectSocket(data.session.access_token);
    setAuthUiVisible(true);
  }
}

async function signUp() {
  showAuthError("");
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    showAuthError("Enter email and password.");
    return;
  }
  if (password.length < 6) {
    showAuthError("Password must be at least 6 characters.");
    return;
  }
  signInBtn.disabled = true;
  signUpBtn.disabled = true;
  const { data, error } = await supabase.auth.signUp({ email, password });
  signInBtn.disabled = false;
  signUpBtn.disabled = false;
  if (error) {
    showAuthError(error.message);
    return;
  }
  if (data.session?.access_token) {
    setSessionEmailLabel(data.session.user.email || "");
    connectSocket(data.session.access_token);
    setAuthUiVisible(true);
  } else {
    showAuthError(
      "Account created. If email confirmation is required, check your inbox."
    );
  }
}

async function signOut() {
  showAuthError("");
  disconnectSocket();
  await supabase.auth.signOut();
  roomState = {
    roomCode: "",
    username: "",
    problem: "",
    context: "",
    mediationMode: "conciliatory",
    messages: []
  };
  messagesEl.innerHTML = "";
  pendingLeaveOnClose = false;
  setAuthUiVisible(false);
  chatCard.classList.add("hidden");
  setupCard.classList.remove("hidden");
  authPassword.value = "";
}

signInBtn.addEventListener("click", signIn);
signUpBtn.addEventListener("click", signUp);

document.querySelectorAll("[data-action='logout']").forEach((btn) => {
  btn.addEventListener("click", () => {
    signOut().catch(console.error);
  });
});

function setStatsTabUi(tab) {
  const isChat = tab === "chat";
  statsTabChat.setAttribute("aria-selected", isChat ? "true" : "false");
  statsTabAlltime.setAttribute("aria-selected", !isChat ? "true" : "false");
}

async function loadStatsModalContent(tab) {
  setStatsTabUi(tab);
  if (tab === "chat") {
    statsModalTitle.textContent = "This chat";
    if (pendingLeaveOnClose) {
      statsModalHint.textContent =
        "Close to return home and leave this room. Totals are for this conversation only.";
    } else {
      statsModalHint.textContent =
        "Emoji reactions others added to your messages in this room (not saved when you leave).";
    }
    const {
      data: { session }
    } = await supabase.auth.getSession();
    if (!session?.user?.id) {
      statsModalBody.textContent = "Sign in to see stats.";
      return;
    }
    if (!roomState.roomCode) {
      statsModalBody.innerHTML = "";
      const p = document.createElement("p");
      p.className = "small";
      p.textContent =
        "You are not in a room. Create or join a chat to see per-room totals.";
      statsModalBody.appendChild(p);
      return;
    }
    const { totalReactions, byEmoji } = aggregateMyReactionsInRoom(
      roomState.messages,
      session.user.id,
      roomState.username
    );
    renderStatsIntoBody(
      totalReactions,
      byEmoji,
      "No reactions on your messages in this chat yet."
    );
    return;
  }

  statsModalTitle.textContent = "All time";
  statsModalHint.textContent =
    "Total emoji reactions others have added to your messages across chats (saved to your account when the server is configured).";
  statsModalBody.textContent = "Loading…";
  const {
    data: { session }
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    statsModalBody.textContent = "Sign in to see your stats.";
    return;
  }
  try {
    const resp = await fetch("/api/profile/me", {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "Could not load stats.");
    }
    const totalReactions = data.totalReactions ?? 0;
    const byEmoji = data.byEmoji || {};
    renderStatsIntoBody(
      totalReactions,
      byEmoji,
      "No reactions recorded yet. When others react to your messages, counts appear here."
    );
  } catch (e) {
    statsModalBody.textContent = e.message || "Error loading stats.";
  }
}

async function openReactionStatsModal(tab) {
  statsModalBody.textContent = "Loading…";
  statsModal.classList.remove("hidden");
  await loadStatsModalContent(tab);
}

function performLeaveRoom() {
  if (socket?.connected) {
    socket.emit("leaveRoom", () => {});
  }
  roomState = {
    roomCode: "",
    username: "",
    problem: "",
    context: "",
    mediationMode: "conciliatory",
    messages: []
  };
  messagesEl.innerHTML = "";
  chatCard.classList.add("hidden");
  setupCard.classList.remove("hidden");
  feedbackBox.classList.add("hidden");
  feedbackBox.textContent = "";
}

function closeStatsModal() {
  statsModal.classList.add("hidden");
  if (pendingLeaveOnClose) {
    pendingLeaveOnClose = false;
    performLeaveRoom();
  }
}

document.querySelectorAll(".myStatsBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    pendingLeaveOnClose = false;
    openReactionStatsModal("alltime").catch(console.error);
  });
});

document.querySelectorAll(".chatStatsBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    pendingLeaveOnClose = false;
    openReactionStatsModal("chat").catch(console.error);
  });
});

if (leaveRoomBtn) {
  leaveRoomBtn.addEventListener("click", () => {
    pendingLeaveOnClose = true;
    openReactionStatsModal("chat").catch(console.error);
  });
}

statsTabChat.addEventListener("click", () => {
  loadStatsModalContent("chat").catch(console.error);
});
statsTabAlltime.addEventListener("click", () => {
  loadStatsModalContent("alltime").catch(console.error);
});

statsModalClose.addEventListener("click", closeStatsModal);
statsModalBackdrop.addEventListener("click", closeStatsModal);

async function bootstrap() {
  const cfgRes = await fetch("/api/auth-config");
  if (!cfgRes.ok) {
    showAuthError("Server auth is not configured.");
    authCard.classList.remove("hidden");
    return;
  }
  const { url, anonKey } = await cfgRes.json();
  supabase = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  const {
    data: { session }
  } = await supabase.auth.getSession();

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      disconnectSocket();
      setAuthUiVisible(false);
      chatCard.classList.add("hidden");
      setSessionEmailLabel("");
      return;
    }
    if (event === "TOKEN_REFRESHED" && session?.access_token) {
      accessToken = session.access_token;
      return;
    }
    if (event === "SIGNED_IN" && session?.access_token) {
      setSessionEmailLabel(session.user?.email || "");
      connectSocket(session.access_token);
      setAuthUiVisible(true);
    }
  });

  if (session?.access_token) {
    setSessionEmailLabel(session.user?.email || "");
    connectSocket(session.access_token);
    setAuthUiVisible(true);
  } else {
    setAuthUiVisible(false);
  }
}

bootstrap().catch((err) => {
  console.error(err);
  showAuthError("Could not start the app.");
  authCard.classList.remove("hidden");
});
