/**
 * Skills module tests: fail-soft discovery over skills roots, the hand-rolled
 * frontmatter parser, role-scoped prompt rendering and the `<skill>` body
 * block. Fixtures are written to temp directories at runtime; nothing here
 * touches the real `skills/` trees.
 *
 * Run with: node --test tests/skills.test.ts (or node tests/run-all.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  discoverSkills,
  renderSkillBody,
  renderSkillsSection,
  validateSkillFrontmatter,
  type SkillCatalog,
} from "../src/skills.ts";

interface TempRoot {
  root: string;
  cleanup: () => void;
}

function tmpdir(): TempRoot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-skills-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Write `<root>/<rel>` (creating parents) and return the absolute path. */
function writeFile(root: string, rel: string, content: string): string {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** `---` fence around the given frontmatter lines, then an optional body. */
function skillDoc(frontmatter: string, body = ""): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function names(catalog: SkillCatalog): string[] {
  return catalog.skills.map((skill) => skill.name);
}

test("discovers directory-form and flat skills, sorted by name", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(
    root,
    "zeta/SKILL.md",
    skillDoc("name: zeta\ndescription: The last skill.\nscope: junior", "# Zeta\n\nBody text."),
  );
  writeFile(
    root,
    "alpha/SKILL.md",
    skillDoc(
      "name: alpha\ndescription: The first skill.\ntools: workspace_read_file, workspace_search_text",
    ),
  );
  writeFile(root, "flat-one.md", skillDoc("name: flat-one\ndescription: A loose markdown file."));
  writeFile(root, "notes.txt", "not a skill");
  writeFile(root, "alpha/references/acceptance.md", "supporting material, not a skill");

  const catalog = discoverSkills([root]);

  assert.deepEqual(names(catalog), ["alpha", "flat-one", "zeta"]);
  assert.deepEqual(catalog.diagnostics, []);

  const alpha = catalog.skills[0];
  assert.equal(alpha.description, "The first skill.");
  assert.equal(alpha.scope, "shared");
  assert.deepEqual(alpha.tools, ["workspace_read_file", "workspace_search_text"]);
  assert.ok(path.isAbsolute(alpha.file));
  assert.ok(alpha.file.endsWith(path.join("alpha", "SKILL.md")));
  assert.equal(alpha.body, "");

  const zeta = catalog.skills[2];
  assert.equal(zeta.scope, "junior");
  assert.equal(zeta.body, "# Zeta\n\nBody text.");
  assert.equal(catalog.skills[1].file, path.join(root, "flat-one.md"));
});

test("frontmatter: quotes, comments, CRLF, unknown scalar keys and colons in values", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const raw = [
    "---",
    'name: "quoted-skill"',
    "description: 'Single quoted description' # trailing comment",
    "when-to-use: Ignored but harmless.",
    "scope: SENIOR",
    "---",
    "",
    "Body.",
  ].join("\r\n");
  writeFile(root, "quoted/SKILL.md", raw);

  const parsed = validateSkillFrontmatter(raw);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.fields, {
    name: "quoted-skill",
    description: "Single quoted description",
    "when-to-use": "Ignored but harmless.",
    scope: "SENIOR",
  });

  const catalog = discoverSkills([root]);
  assert.deepEqual(names(catalog), ["quoted-skill"]);
  assert.equal(catalog.skills[0].description, "Single quoted description");
  assert.equal(catalog.skills[0].scope, "senior");
});

test("a description may contain a colon; a URL hash is not a comment", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(
    root,
    "colon/SKILL.md",
    skillDoc("name: colon\ndescription: When: the task has a colon in it."),
  );
  const catalog = discoverSkills([root]);
  assert.equal(catalog.skills[0].description, "When: the task has a colon in it.");
  assert.deepEqual(catalog.diagnostics, []);
});

test("nested and flow YAML lines are skipped with a diagnostic", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const raw = [
    "---",
    "name: nested",
    "description: Has nested metadata.",
    "metadata:",
    "  owner: someone",
    "tags:",
    "  - one",
    "  - two",
    "extra: [a, b]",
    "block: |",
    "  line",
    "---",
    "",
    "Body.",
  ].join("\n");
  writeFile(root, "nested/SKILL.md", raw);

  const parsed = validateSkillFrontmatter(raw);
  assert.equal(parsed.fields.name, "nested");
  assert.equal(parsed.fields.description, "Has nested metadata.");
  const unsupported = parsed.diagnostics.filter((line) =>
    line.includes("unsupported frontmatter line skipped"),
  );
  assert.equal(unsupported.length, 6, parsed.diagnostics.join("\n"));
  assert.ok(unsupported.some((line) => line.includes("owner: someone")));
  assert.ok(unsupported.some((line) => line.includes("extra: [a, b]")));
  assert.ok(unsupported.some((line) => line.includes("block: |")));
  assert.ok(unsupported.some((line) => line.includes("line")));

  const catalog = discoverSkills([root]);
  assert.deepEqual(names(catalog), ["nested"]);
  assert.equal(catalog.skills[0].body, "Body.");
  assert.ok(catalog.diagnostics.every((line) => line.startsWith(path.join(root, "nested"))));
  assert.equal(
    catalog.diagnostics.filter((line) => line.includes("unsupported frontmatter line skipped"))
      .length,
    unsupported.length,
  );
});

test("invalid names skip the skill; the fallback name comes from the directory or file", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "good-dir/SKILL.md", skillDoc("description: Fallback name from the directory."));
  writeFile(root, "Loose-File.md", skillDoc("description: Fallback name from the file stem."));
  writeFile(root, "bad name/SKILL.md", skillDoc("description: Space in the fallback."));
  writeFile(root, "explicit/SKILL.md", skillDoc("name: NotLowercase\ndescription: Bad name."));

  const catalog = discoverSkills([root]);

  assert.deepEqual(names(catalog), ["good-dir", "loose-file"]);
  assert.equal(catalog.skills[0].description, "Fallback name from the directory.");
  const badNameDiagnostics = catalog.diagnostics.filter((line) => line.includes("invalid skill name"));
  assert.equal(badNameDiagnostics.length, 2);
  assert.ok(badNameDiagnostics.some((line) => line.includes('"bad name"')));
  assert.ok(badNameDiagnostics.some((line) => line.includes('"NotLowercase"')));
});

test("missing description and missing frontmatter are diagnosed, not fatal", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "no-desc/SKILL.md", skillDoc("name: no-desc"));
  writeFile(root, "bare.md", "# Only a body\n\nNo frontmatter here.");

  const catalog = discoverSkills([root]);

  assert.deepEqual(names(catalog), ["bare", "no-desc"]);
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
  assert.equal(byName.get("no-desc")?.description, "");
  assert.equal(byName.get("bare")?.description, "");
  assert.equal(byName.get("bare")?.body, "# Only a body\n\nNo frontmatter here.");
  assert.equal(
    catalog.diagnostics.filter((line) => line.includes("missing description")).length,
    2,
  );
  assert.equal(
    catalog.diagnostics.filter((line) => line.includes("missing frontmatter block")).length,
    1,
  );
});

test("invalid scope falls back to shared with a diagnostic", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(
    root,
    "odd-scope/SKILL.md",
    skillDoc("name: odd-scope\ndescription: Bad scope.\nscope: everyone"),
  );

  const catalog = discoverSkills([root]);
  assert.equal(catalog.skills[0].scope, "shared");
  assert.ok(
    catalog.diagnostics.some(
      (line) => line.includes('invalid scope "everyone"') && line.includes("defaulting to shared"),
    ),
  );
});

test("renderSkillsSection advertises shared plus the role's own skills, or null", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "shared-thing/SKILL.md", skillDoc("description: Both brothers see this."));
  writeFile(
    root,
    "senior-check/SKILL.md",
    skillDoc("name: senior-check\ndescription: Senior only.\nscope: senior"),
  );
  writeFile(
    root,
    "junior-recipe/SKILL.md",
    skillDoc("name: junior-recipe\ndescription: Junior only.\nscope: junior"),
  );

  const catalog = discoverSkills([root]);

  assert.equal(
    renderSkillsSection(catalog, "senior"),
    [
      "## Available skills",
      "",
      "- senior-check: Senior only.",
      "- shared-thing: Both brothers see this.",
    ].join("\n"),
  );
  assert.equal(
    renderSkillsSection(catalog, "junior"),
    [
      "## Available skills",
      "",
      "- junior-recipe: Junior only.",
      "- shared-thing: Both brothers see this.",
    ].join("\n"),
  );

  const seniorOnlyRoot = path.join(root, "role-only");
  writeFile(
    seniorOnlyRoot,
    "only-senior/SKILL.md",
    skillDoc("description: Only one role.\nscope: senior"),
  );
  const seniorOnly = discoverSkills([seniorOnlyRoot]);
  assert.equal(renderSkillsSection(seniorOnly, "junior"), null);
  assert.equal(renderSkillsSection({ skills: [], diagnostics: [] }, "senior"), null);
});

test("duplicate skill names: the first root wins and the shadow is diagnosed", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  const projectRoot = path.join(root, "project");
  const userRoot = path.join(root, "user");
  const winner = writeFile(projectRoot, "dup/SKILL.md", skillDoc("description: Project version."));
  const loser = writeFile(userRoot, "dup.md", skillDoc("name: dup\ndescription: User version."));

  const catalog = discoverSkills([projectRoot, userRoot]);

  assert.deepEqual(names(catalog), ["dup"]);
  assert.equal(catalog.skills[0].description, "Project version.");
  assert.equal(catalog.skills[0].file, winner);
  const shadow = catalog.diagnostics.filter((line) => line.includes("duplicate skill name"));
  assert.equal(shadow.length, 1);
  assert.ok(shadow[0].includes(path.resolve(loser)));
  assert.ok(shadow[0].includes(path.resolve(winner)));

  writeFile(projectRoot, "second.md", skillDoc("name: dup\ndescription: Same root, later file."));
  const sameRoot = discoverSkills([projectRoot]);
  assert.deepEqual(names(sameRoot), ["dup"]);
  assert.equal(sameRoot.skills[0].description, "Project version.");
  assert.ok(sameRoot.diagnostics.some((line) => line.includes("duplicate skill name")));
});

test("directory form wins over a flat file with the same stem", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "foo/SKILL.md", skillDoc("description: Directory form."));
  writeFile(root, "foo.md", skillDoc("name: foo\ndescription: Flat form."));

  const catalog = discoverSkills([root]);
  assert.deepEqual(names(catalog), ["foo"]);
  assert.equal(catalog.skills[0].description, "Directory form.");
  assert.deepEqual(catalog.diagnostics, []);
});

test("missing roots are quiet, a non-directory root is diagnosed, duplicate roots collapse", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "one/SKILL.md", skillDoc("description: One."));
  const strayFile = writeFile(root, "not-a-root.txt", "x");

  const catalog = discoverSkills([
    path.join(root, "does-not-exist"),
    root,
    root,
    path.join(root, ".", ""),
    strayFile,
  ]);

  assert.deepEqual(names(catalog), ["one"]);
  assert.equal(catalog.diagnostics.length, 1, catalog.diagnostics.join("\n"));
  assert.ok(catalog.diagnostics[0].includes("skills root is not a directory"));

  assert.deepEqual(discoverSkills([]), { skills: [], diagnostics: [] });
});

test("dot directories, node_modules and a loose SKILL.md are ignored; nested groups are scanned", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, ".hidden/SKILL.md", skillDoc("description: Hidden."));
  writeFile(root, "node_modules/pkg/SKILL.md", skillDoc("description: Vendored."));
  writeFile(root, "SKILL.md", skillDoc("description: Directory marker, not a skill."));
  writeFile(root, "group/nested/SKILL.md", skillDoc("description: Nested group."));

  const catalog = discoverSkills([root]);
  assert.deepEqual(names(catalog), ["nested"]);
  assert.equal(catalog.skills[0].description, "Nested group.");
  assert.deepEqual(catalog.diagnostics, []);
});

test("renderSkillBody wraps the body in a <skill> block", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(
    root,
    "steps/SKILL.md",
    skillDoc("name: steps\ndescription: Steps.", "# Steps\n\n1. Do the thing."),
  );
  const [skill] = discoverSkills([root]).skills;
  assert.equal(
    renderSkillBody(skill),
    '<skill name="steps">\n# Steps\n\n1. Do the thing.\n</skill>',
  );

  assert.equal(
    renderSkillBody({ ...skill, body: "" }),
    '<skill name="steps">\n\n</skill>',
  );
});

test("validateSkillFrontmatter tolerates garbage and unterminated fences", () => {
  assert.deepEqual(validateSkillFrontmatter(""), {
    fields: {},
    diagnostics: ["missing frontmatter block"],
  });

  const unterminated = validateSkillFrontmatter("---\nname: half\ndescription: No closing fence");
  assert.deepEqual(unterminated.fields, { name: "half", description: "No closing fence" });
  assert.deepEqual(unterminated.diagnostics, ["unterminated frontmatter block"]);

  const garbage = validateSkillFrontmatter("---\n\u0000\u0001\nno colon here\n---\nbody");
  assert.deepEqual(garbage.fields, {});
  assert.equal(garbage.diagnostics.length, 2);

  assert.deepEqual(validateSkillFrontmatter("\uFEFF---\nname: bom\n---\n").fields, { name: "bom" });
});

test("diagnostics are deterministic across repeated discoveries", (t) => {
  const { root, cleanup } = tmpdir();
  t.after(cleanup);

  writeFile(root, "a/SKILL.md", skillDoc("description: A."));
  writeFile(root, "b.md", skillDoc("name: a\ndescription: Shadow."));
  writeFile(root, "bad name/SKILL.md", skillDoc("description: Bad."));

  const first = discoverSkills([root]);
  const second = discoverSkills([root]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.skills.map((skill) => skill.name),
    ["a"],
  );
});