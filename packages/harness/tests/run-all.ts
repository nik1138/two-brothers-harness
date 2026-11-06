/**
 * Combined test entry. Runs every test file in-process, avoiding the test
 * runner's child-process spawn (which some sandboxes block).
 *
 *   node tests/run-all.ts
 */
import "./protocol.test.ts";
import "./harness.test.ts";
import "./payloadrepair.test.ts";
import "./relaxedparse.test.ts";
import "./graph.test.ts";
import "./session.test.ts";
import "./prompts.test.ts";
import "./promptsections.test.ts";
import "./providers.test.ts";
import "./adapters.test.ts";
import "./retryregistry.test.ts";
import "./workspace.test.ts";
import "./editqueue.test.ts";
import "./output.test.ts";
import "./settings.test.ts";
import "./runtime.test.ts";
import "./server.test.ts";
import "./cli.test.ts";
import "./printmode.test.ts";
import "./mcp.test.ts";
import "./plugins.test.ts";
import "./compaction.test.ts";
import "./compactionv2.test.ts";
import "./compactiontokens.test.ts";
import "./skills.test.ts";
import "./presets.test.ts";
import "./cost.test.ts";
import "./cliergonomics.test.ts";
import "./plugincore.test.ts";
import "./toolschema.test.ts";
import "./streaming.test.ts";
import "./streamingtokens.test.ts";
import "./commands.test.ts";
import "./pluginmcp.test.ts";
import "./skillinvoke.test.ts";
import "./approvaldeny.test.ts";
import "./security.test.ts";
import "./providerwarnings.test.ts";
import "./cliwiring.test.ts";
import "./serveshutdown.test.ts";
import "./apicommands.test.ts";
import "./integration.test.ts";
import "./tui.test.ts";
import "./tuieditor.test.ts";
import "./tuikeymap.test.ts";
import "./tuiterminal.test.ts";
import "./tuiwidth.test.ts";
import "./tuivisualmodel.test.ts";
import "./tuiviewlane.test.ts";
import "./tuiintegration.test.ts";
import "./tuihistory.test.ts";
import "./doctor.test.ts";
import "./completions.test.ts";
import "./reliability.test.ts";
import "./roleendpoints.test.ts";
import "./sessionsearch.test.ts";
import "./serversearch.test.ts";
import "./sessionscommands.test.ts";
import "./tuifind.test.ts";
import "./tuistyle.test.ts";
import "./approvalbrokerdeny.test.ts";
