// Shared fixture for the session-multiplexer e2e specs.
//
// The multiplexer only ever tracks sessions it spawned through its own
// `SessionDriver`, so these specs drive real spawns against the mock server
// (which materializes each created session) and assert the switcher, focus, and
// close behavior the way a user observes them.

const serverKey = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "C:/OpenCode/MultiplexerProject"
const projectID = "proj_multiplexer"

type MessageInfo = { id: string; sessionID: string; role: "user" | "assistant" } & Record<string, unknown>
type MessagePart = { id: string; type: string; text?: string } & Record<string, unknown>
type Message = { info: MessageInfo; parts: MessagePart[] }

function textTurn(sessionID: string, marker: string): Message[] {
  const userID = `msg_user_${sessionID}`
  const assistantID = `msg_assistant_${sessionID}`
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
      },
      parts: [{ id: `prt_user_${sessionID}`, sessionID, messageID: userID, type: "text", text: `Prompt for ${marker}` }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 1700000000000 + 1_000, completed: 1700000000000 + 2_000 },
        parentID: userID,
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: `prt_assistant_${sessionID}`,
          sessionID,
          messageID: assistantID,
          type: "text",
          text: `Reply marker ${marker}`,
        },
      ],
    },
  ]
}

const baseID = "ses_mplex_base"
const alphaID = "ses_mplex_alpha"
const bravoID = "ses_mplex_bravo"
const charlieID = "ses_mplex_charlie"

// Identities the mock hands back for successive spawns, with a distinct title so
// the focused-session heading uniquely identifies which session is rendered.
const spawned = [
  { id: alphaID, title: "Alpha multiplex session" },
  { id: bravoID, title: "Bravo multiplex session" },
  { id: charlieID, title: "Charlie multiplex session" },
] as const

const messages: Record<string, Message[]> = {
  [baseID]: textTurn(baseID, "base"),
  [alphaID]: textTurn(alphaID, "alpha"),
  [bravoID]: textTurn(bravoID, "bravo"),
  [charlieID]: textTurn(charlieID, "charlie"),
}

export const fixture = {
  serverKey,
  directory,
  projectID,
  baseID,
  alphaID,
  bravoID,
  charlieID,
  spawned,
  project: {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "multiplexer-project",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  },
  provider: {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  },
  // The single session the app lands on before any multiplexing happens.
  baseSession: {
    id: baseID,
    slug: "base",
    projectID,
    directory,
    title: "Base session",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  },
  titles: {
    base: "Base session",
    alpha: "Alpha multiplex session",
    bravo: "Bravo multiplex session",
    charlie: "Charlie multiplex session",
  },
}

export function pageMessages(sessionID: string) {
  return { items: messages[sessionID] ?? [] }
}
