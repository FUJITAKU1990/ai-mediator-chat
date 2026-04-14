# Conflict Mediator Chat (Localhost)

Two users can join the same room from separate browser windows and chat in real time.

### AI mediation

- **Debate vs Conciliatory** — In the chat, choose **AI style** for the room. *Debate* leans toward spotting flawed reasoning; *Conciliatory* leans toward common ground. Both the optional structured feedback and the automatic mediator use this mode.
- **Get AI Mediation Feedback** — Either person can press this to generate structured output in the panel below:
  - Argument summary
  - Fact-check style assessment (from conversation content)
  - Recommended guidance for resolution
- **Mediator in the chat** — After every **five** user messages, the server asks the model whether to post as **Mediator**. If the model has nothing useful to say, it stays silent (no empty message). Reactions on messages are included in what the model sees.

### Reactions

Each message has a fixed emoji palette (👍 👎 ❤️ 💀 😂 🔥). You can add **one** reaction per message; picking another replaces it; clicking your active emoji removes it.

### Private reaction totals

Only **you** can see your own totals. After sign-in, use **My reaction stats** to see how many reactions your messages have received over time (stored in Supabase). Self-reactions on your own messages do not count.

1. In Supabase → **SQL**, run the migration in [`supabase/migrations/001_reaction_stats.sql`](supabase/migrations/001_reaction_stats.sql).
2. Add **`SUPABASE_SERVICE_ROLE_KEY`** (secret **service_role** key from **Project Settings → API**) to `.env`. Without it, chat still works but totals are not saved.

## 1) Install Node.js

Install Node.js 18+ so `node` and `npm` are available.

## 2) Setup

```bash
cd path/to/conflict-mediator-app
npm install
```

Copy [`.env.example`](.env.example) to `.env` in the project root and fill in values.

**Required for sign-in:** Supabase (**Project Settings → API**): `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or publishable key). The server checks sessions with Supabase Auth over HTTPS (no `JWT_SECRET` in `.env`).

**Where users appear:** Supabase Dashboard → **Authentication** → **Users** (not the public `public` schema in Table Editor). Sign-ups create rows in `auth.users` automatically.

**For AI features:** OpenAI:

```env
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
PORT=3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_or_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_secret
```

## 3) Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in two browser windows (or two different browsers).

## 4) Use

1. User A enters name + problem (+ optional context), then clicks **Create New Group Chat**.
2. Share room code with User B.
3. User B enters name + room code, then clicks **Join Group Chat**.
4. Both users chat; optionally set **AI style** (Conciliatory / Debate) for everyone in the room.
5. Use **Get AI Mediation Feedback** whenever you want the structured summary, or wait for **Mediator** to chime in automatically after every five user messages.

## Notes

- **Accounts** — Email sign-in is required before creating or joining a room (Supabase Auth). Enable the Email provider under Authentication in the Supabase dashboard.
- Room/chat data is stored in-memory while the server is running.
- This is a local prototype for localhost usage.


vnbvuxayisceewsber@nespf.com
smai2@andrew.cmu.edu
95874-84Team5