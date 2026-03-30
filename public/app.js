const socket = io();

const setupCard = document.getElementById("setupCard");
const chatCard = document.getElementById("chatCard");
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

let roomState = {
  roomCode: "",
  problem: "",
  context: "",
  messages: []
};

function renderMessage(msg) {
  const el = document.createElement("div");
  el.className = "msg";
  const t = new Date(msg.ts).toLocaleTimeString();
  el.innerHTML = `
    <div class="meta"><strong>${escapeHtml(msg.username)}</strong> • ${t}</div>
    <div>${escapeHtml(msg.text)}</div>
  `;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showRoom(data) {
  roomState.roomCode = data.roomCode;
  roomState.problem = data.context?.problem || "";
  roomState.context = data.context?.context || "";
  roomState.messages = data.messages || [];

  roomLabel.textContent = `Room code: ${roomState.roomCode}`;
  problemLabel.textContent = `Problem: ${roomState.problem}`;
  contextLabel.textContent = roomState.context ? `Context: ${roomState.context}` : "";

  messagesEl.innerHTML = "";
  roomState.messages.forEach(renderMessage);

  setupCard.classList.add("hidden");
  chatCard.classList.remove("hidden");
}

createBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const problem = problemInput.value.trim();
  const context = contextInput.value.trim();
  if (!username || !problem) {
    alert("Name and problem are required to create a room.");
    return;
  }

  socket.emit("createRoom", { username, problem, context }, (resp) => {
    if (!resp.ok) {
      alert(resp.error || "Failed to create room.");
      return;
    }
    showRoom(resp);
    alert(`Share this room code with the other person: ${resp.roomCode}`);
  });
});

joinBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const roomCode = roomCodeInput.value.trim();
  if (!username || !roomCode) {
    alert("Name and room code are required to join.");
    return;
  }

  socket.emit("joinRoom", { username, roomCode }, (resp) => {
    if (!resp.ok) {
      alert(resp.error || "Failed to join room.");
      return;
    }
    showRoom(resp);
  });
});

socket.on("newMessage", (msg) => {
  roomState.messages.push(msg);
  renderMessage(msg);
});

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

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
        messages: roomState.messages
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
