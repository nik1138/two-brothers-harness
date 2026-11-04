/**
 * Combined test entry. Runs every test file in-process, avoiding the test
 * runner's child-process spawn (which some sandboxes block).
 *
 *   node tests/run-all.ts
 */
import "./protocol.test.ts";
import "./harness.test.ts";
import "./session.test.ts";
