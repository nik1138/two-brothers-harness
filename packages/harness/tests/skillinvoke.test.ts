/**
 * Skill invocation: a structured reply that asks for a skill with
 * `<skill name="…">` gets the body delivered as a `<skill-loaded name="…">`
 * `message` envelope from "user" — kimi-code's convention, wired through the
 * existing append path so it lands in the shared context (dense `seq`, session
 * JSONL, `onEnvelope`, "Context events:").
 *
 * Covered here: the happy path and what the next turn sees, the tolerant
 * request grammar, role scoping, unknown names, the per-run cap and the
 * no-repeat guard, JSONL persistence, and the fail-soft contract.
 *
 * Run with: node --test tests/skillinvoke.test.ts (or node tests/run-all.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { SharedContext, type ChatMessage } from "../src/context.ts";
import { TwoBrothersHarness, type HarnessOptions } from "../src/harness.ts";
import type { Message } from "../src/protocol.ts";
import { MockProvider, type Provider } from "../src/provider.ts";
import { SessionStore } from "../src/session.ts";
import type { Skill, SkillCatalog, SkillScope } from "../src/skills.ts";

const cfg = (extra: Record<string, unknown> = {}) =>
  resolveConfig({ provider: "mock", ...extra });

/** One strict-valid payload per structured kind (the scripted baseline). */
const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID[kind], ...extra });
}

/** A strict-valid reply followed by a skill request (tolerantly parsed). */
function replyWithSkill(kind: string, marker: string, extra: Record<string, unknown> = {}): string {
  return `${validReply(kind, extra)}\n\n${marker}`;
}

function skill(
  name: string,
  scope: SkillScope = "shared",
  body = `# ${name}\n\nBody of ${name}.`,
): Skill {
  return {
    name,
    description: `${name} skill`,
    scope,
    tools: [],
    file: path.resolve(`${name}/SKILL.md`),
    body,
  };
}

function catalog(...skills: Skill[]): SkillCatalog {
  return { skills: [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), diagnostics: [] };
}

interface Call {
  kind: string;
  messages: ChatMessage[];
}

/** Scripted text provider: one reply queue per kind, valid payloads otherwise. */
class ScriptedProvider implements Provider {
  readonly calls: Call[] = [];
  private readonly replies: Record<string, string[]>;

  constructor(replies: Record<string, string[]> = {}) {
    this.replies = replies;
  }

  async chat(messages: ChatMessage[], responseKind = "message"): Promise<string> {
    this.calls.push({ kind: responseKind, messages: messages.map((message) => ({ ...message })) });
    const queue = this.replies[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return validReply(responseKind);
  }

  callsOf(kind: string): Call[] {
    return this.calls.filter((call) => call.kind === kind);
  }
}

function userOf(call: Call): string {
  return call.messages.find((message) => message.role === "user")?.content ?? "";
}

function delivered(messages: Message[]): Message[] {
  return messages.filter(
    (message) =>
      message.from === "user" &&
      message.kind === "message" &&
      String(message.payload.text ?? "").startsWith("<skill-loaded"),
  );
}

function harnessWith(
  provider: ScriptedProvider,
  skills: SkillCatalog | undefined,
  extra: HarnessOptions = {},
  config: Record<string, unknown> = {},
): TwoBrothersHarness {
  return new TwoBrothersHarness(cfg({ mode: "consult", ...config }), {
    senior: provider,
    junior: new ScriptedProvider(),
    ...(skills === undefined ? {} : { skills }),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// happy path: one delivery, unwrapped body, visible to the next turn
// ---------------------------------------------------------------------------

test("a <skill> request delivers the body as one <skill-loaded> envelope", async () => {
  const body = "# Alpha\n\nAlways check the ledger before answering.";
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", '<skill name="alpha">')],
  });
  const junior = new ScriptedProvider();
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior,
    skills: catalog(skill("alpha", "shared", body)),
  });

  const result = await harness.run("build a catalog");

  const blocks = delivered(result.messages);
  assert.equal(blocks.length, 1, "exactly one delivery for one request");
  assert.equal(blocks[0].from, "user", "harness-injected context rides from \"user\"");
  assert.equal(blocks[0].to, "senior");
  assert.equal(blocks[0].kind, "message");
  assert.deepEqual(Object.keys(blocks[0].payload), ["text"]);
  const text = String(blocks[0].payload.text);
  assert.equal(text, `<skill-loaded name="alpha">\n${body}\n</skill-loaded>`);
  assert.ok(!text.includes("<skill name="), "the skill body is not double-wrapped");

  // the node is unchanged: the payload was already parsed and appended
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "message", "consult", "proposal", "review", "decision"],
  );
  assert.equal(result.messages.find((message) => message.kind === "consult")!.payload.ask, "a");
  assert.deepEqual(result.errors, []);

  // the NEXT turn's request carries the body inside the byte-stable transcript
  const juniorCalls = junior.callsOf("proposal");
  const user = userOf(juniorCalls[0]);
  assert.ok(user.startsWith("[[TASK]]\nbuild a catalog\n[[/TASK]]\n\nContext events:"));
  // the transcript renders payloads as JSON, so the block is escaped there
  assert.ok(user.includes("skill-loaded"));
  assert.ok(user.includes("Always check the ledger before answering."));
});

test("the request grammar is tolerant: any case, quotes optional, slash optional", async () => {
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", "<SKILL NAME='Alpha' />")],
  });
  const harness = harnessWith(senior, catalog(skill("alpha")));

  const result = await harness.run("build a catalog");

  const blocks = delivered(result.messages);
  assert.equal(blocks.length, 1);
  assert.equal(
    String(blocks[0].payload.text),
    '<skill-loaded name="alpha">\n# alpha\n\nBody of alpha.\n</skill-loaded>',
    "the catalog's canonical name is used",
  );
});

// ---------------------------------------------------------------------------
// guards: catalog membership and role scope
// ---------------------------------------------------------------------------

test("an unknown skill name injects nothing", async () => {
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", '<skill name="ghost">')],
  });
  const harness = harnessWith(senior, catalog(skill("alpha")));

  const result = await harness.run("build a catalog");

  assert.equal(delivered(result.messages).length, 0);
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ["message", "consult", "proposal", "review", "decision"],
  );
});

test("a senior-only skill is not delivered to the junior", async () => {
  const senior = new ScriptedProvider();
  const junior = new ScriptedProvider({
    proposal: [replyWithSkill("proposal", '<skill name="checklist">')],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior,
    junior,
    skills: catalog(skill("checklist", "senior")),
  });

  const result = await harness.run("build a catalog");

  assert.equal(delivered(result.messages).length, 0);
  const juniorCalls = junior.callsOf("proposal");
  assert.ok(!userOf(juniorCalls[0]).includes("<skill-loaded"));
});

test("a shared skill is visible to the junior and delivered to the junior", async () => {
  const junior = new ScriptedProvider({
    proposal: [replyWithSkill("proposal", '<skill name="alpha">')],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new ScriptedProvider(),
    junior,
    skills: catalog(skill("alpha")),
  });

  const result = await harness.run("build a catalog");

  const blocks = delivered(result.messages);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].to, "junior");
});

test("without options.skills a marker in the reply injects nothing", async () => {
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", '<skill name="alpha">')],
  });
  const harness = harnessWith(senior, undefined);

  const result = await harness.run("build a catalog");

  assert.equal(delivered(result.messages).length, 0);
  assert.equal(result.messages.length, 5);
});

// ---------------------------------------------------------------------------
// guards: per-run cap and no repeats
// ---------------------------------------------------------------------------

test("at most three skill bodies are delivered per run", async () => {
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", '<skill name="alpha">')],
    review: [
      replyWithSkill("review", '<skill name="beta">', { verdict: "revise" }),
      replyWithSkill("review", '<skill name="gamma">', { verdict: "revise" }),
      replyWithSkill("review", '<skill name="delta">'),
    ],
  });
  const harness = new TwoBrothersHarness(cfg({ mode: "consult", maxRounds: 2 }), {
    senior,
    junior: new ScriptedProvider(),
    skills: catalog(skill("alpha"), skill("beta"), skill("gamma"), skill("delta")),
  });

  const result = await harness.run("build a catalog");

  assert.equal(senior.callsOf("review").length, 3, "three review rounds ran");
  const names = delivered(result.messages).map((message) =>
    /<skill-loaded name="([^"]+)"/.exec(String(message.payload.text))![1],
  );
  assert.deepEqual(names, ["alpha", "beta", "gamma"], "the fourth request is over the cap");
});

test("the same skill is delivered at most once per run", async () => {
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", '<skill name="alpha">')],
    review: [replyWithSkill("review", '<skill name="alpha">')],
  });
  const harness = harnessWith(senior, catalog(skill("alpha")));

  const result = await harness.run("build a catalog");

  assert.equal(delivered(result.messages).length, 1);
});

// ---------------------------------------------------------------------------
// the delivery rides the normal append path
// ---------------------------------------------------------------------------

test("the delivery persists to the session JSONL with a dense seq and fires onEnvelope", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-skill-invoke-"));
  try {
    const store = new SessionStore(path.join(dir, "session.jsonl"));
    const ctx = new SharedContext(store);
    const seen: Message[] = [];
    const senior = new ScriptedProvider({
      consult: [replyWithSkill("consult", '<skill name="alpha">')],
    });
    const harness = harnessWith(
      senior,
      catalog(skill("alpha")),
      { onEnvelope: (message) => seen.push(message) },
    );

    const result = await harness.run("build a catalog", ctx);

    assert.equal(seen.length, ctx.events.length, "every envelope reached onEnvelope");
    const blocks = delivered(seen);
    assert.equal(blocks.length, 1);

    const lines = fs
      .readFileSync(store.path, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    assert.equal(lines.length, ctx.events.length, "one envelope per line");
    lines.forEach((line, index) => {
      const parsed = JSON.parse(line) as { seq: number };
      assert.equal(parsed.seq, index + 1, "dense seq");
    });
    const texts = lines.map((line) => String((JSON.parse(line) as Message).payload.text ?? ""));
    assert.ok(texts.some((text) => text.startsWith('<skill-loaded name="alpha">')));
    assert.equal(result.messages.length, ctx.events.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing envelope consumer never turns skill delivery into a run failure", async () => {
  const senior = new ScriptedProvider({
    consult: [replyWithSkill("consult", '<skill name="alpha">')],
  });
  const harness = harnessWith(senior, catalog(skill("alpha")), {
    onEnvelope: (message) => {
      if (String(message.payload.text ?? "").startsWith("<skill-loaded")) {
        throw new Error("consumer exploded");
      }
    },
  });

  const result = await harness.run("build a catalog");

  assert.ok(result.decision.decision, "the run still reached its decision");
  assert.deepEqual(result.errors, []);
  assert.equal(delivered(result.messages).length, 1);
});

test("a mock-provider run is unaffected when no skill is requested", async () => {
  const harness = new TwoBrothersHarness(cfg({ mode: "consult" }), {
    senior: new MockProvider(),
    junior: new MockProvider(),
    skills: catalog(skill("alpha")),
  });

  const result = await harness.run("build a catalog");

  assert.equal(delivered(result.messages).length, 0);
  assert.equal(result.messages.length, 5);
});