# Conflict Mediator Chat (Localhost)

Two users can join the same room from separate browser windows and chat in real time.  
Either person can press **Get AI Mediation Feedback** to generate:

- Argument summary
- Fact-check style assessment (from conversation content)
- Recommended guidance for resolution

## 1) Install Node.js

Install Node.js 18+ so `node` and `npm` are available.

## 2) Setup

```bash
cd path/to/project
npm install
cp .env.example .env
```

Create a .env file in the project root with the following:

```env
OPENAI_API_KEY="your_key_here"
OPENAI_MODEL=gpt-4o-mini
PORT=3000
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
4. Both users chat.
5. Click **Get AI Mediation Feedback** to generate AI mediation.

## Notes

- Room/chat data is stored in-memory while the server is running.
- This is a local prototype for localhost usage.
