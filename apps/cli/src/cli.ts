// ============================================================================
// DevCortex CLI entry point.
//
// A thin commander surface over @devcortex/core (+ @devcortex/claude-code for
// `install claude`). Every action runs inside `runAction`, which renders
// success or a clean error and sets the process exit code. The CLI never
// throws a raw stack to the user.
//
// Exit codes (spec section 6): 0 ok · 1 internal error · 2 ship NOT_READY (so
// CI / Claude Code hooks can gate).
// ============================================================================

import { Command, CommanderError } from 'commander';

import pkg from '../package.json';
import * as commands from './commands';
import * as daemon from './daemon';
import { emit, emitHookOutcome, EXIT_OK, fail, readGlobals, readHookPayload } from './runtime';
import type { CommandResult, GlobalOptions, HookOutcome, HookPayload } from './runtime';

// Read from package.json so `--version` can never drift from the published version.
const VERSION = pkg.version;

/** Accumulate a repeatable string option into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Parse a `--port` option into a valid TCP port, or undefined to use the default. */
function parsePort(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

/** Register the global `--cwd` / `--json` flags on a command (no defaults). */
function withGlobals(command: Command): Command {
  return command
    .option('--cwd <dir>', 'run as if invoked from this directory')
    .option('--json', 'emit machine-readable JSON output');
}

/**
 * Run a command body: resolve globals, emit the result (human or JSON), and set
 * the exit code. Any thrown value is rendered as a clean message — never a stack.
 */
async function runAction(
  command: Command,
  body: (globals: GlobalOptions) => Promise<CommandResult>,
): Promise<void> {
  const globals = readGlobals(command);
  try {
    const result = await body(globals);
    emit(result, globals.json);
  } catch (err) {
    fail(err, globals.json);
  }
}

/**
 * Run a host-hook command body (PreToolUse `guard` / PostToolUse `record-evidence`).
 *
 * FAIL-OPEN CONTRACT (spec §8): a host hook must NEVER break the agent. Any
 * internal error — unreadable stdin, malformed payload, uninitialized workspace,
 * or an engine fault — degrades to passive (exit 0, no block). Only a deliberate,
 * explained policy block reaches the host (via emitHookOutcome, exit 2).
 */
async function runHookAction(
  command: Command,
  body: (globals: GlobalOptions, payload: HookPayload) => Promise<HookOutcome>,
): Promise<void> {
  const globals = readGlobals(command);
  try {
    const payload = await readHookPayload();
    const outcome = await body(globals, payload);
    emitHookOutcome(outcome, globals.json);
  } catch {
    process.exitCode = EXIT_OK;
  }
}

function buildProgram(): Command {
  const program = new Command();

  withGlobals(program)
    .name('devcortex')
    .description('DevCortex — the cognitive layer for production-grade AI coding agents.')
    .version(VERSION, '-v, --version')
    .showHelpAfterError('(add --help for usage)')
    .enablePositionalOptions();

  // --- init ---
  withGlobals(program.command('init'))
    .description('Scan the repo and create the .cortex/ workspace')
    .option('-f, --force', 'overwrite an existing workspace', false)
    .action(function (this: Command) {
      const opts = this.opts();
      return runAction(this, (g) => commands.cmdInit(g, { force: opts.force === true }));
    });

  // --- doctor ---
  withGlobals(program.command('doctor'))
    .description('Diagnose the workspace, graph cache, stack, and gate configuration')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdDoctor(g));
    });

  // --- scan ---
  withGlobals(program.command('scan'))
    .description('Re-scan the repo and refresh the cached project graph')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdScan(g));
    });

  // --- brief ---
  withGlobals(program.command('brief'))
    .description('Print the compact session-start project brief (risks, features, decisions, protected paths)')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdBrief(g));
    });

  // --- preflight ---
  withGlobals(program.command('preflight'))
    .description('Compile risk + blast radius + intent + context for a task')
    .argument('<task...>', 'the task you are about to start')
    .action(function (this: Command, taskParts: string[]) {
      return runAction(this, (g) => commands.cmdPreflight(g, taskParts.join(' ')));
    });

  // --- context ---
  withGlobals(program.command('context'))
    .description('Compile the minimum-complete context pack')
    .argument('[task...]', 'optional task to focus the context on')
    .option('--level <level>', 'force a depth: tiny | standard | deep')
    .action(function (this: Command, taskParts: string[]) {
      const opts = this.opts();
      const level = typeof opts.level === 'string' ? opts.level : undefined;
      return runAction(this, (g) => commands.cmdContext(g, taskParts.join(' '), { level }));
    });

  // --- plan ---
  withGlobals(program.command('plan'))
    .description('Select a workflow and emit an ordered plan (stages + implementation + DoD)')
    .argument('<task...>', 'the task you are about to start')
    .action(function (this: Command, taskParts: string[]) {
      return runAction(this, (g) => commands.cmdPlan(g, taskParts.join(' ')));
    });

  // --- verify ---
  withGlobals(program.command('verify'))
    .description('Run the quality gate (typecheck/lint/build/test + route/env checks)')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdVerify(g));
    });

  // --- gate ---
  withGlobals(program.command('gate'))
    .description(
      'Run a deep quality gate — code | ui | security | devops | product | premium-ui ' +
        '(default: every family applicable to the detected stack). Exit 2 on a failing required check.',
    )
    .argument('[family]', 'gate family: code | ui | security | devops | product | premium-ui')
    .action(function (this: Command, family: string | undefined) {
      return runAction(this, (g) => commands.cmdGate(g, family));
    });

  // --- ship ---
  withGlobals(program.command('ship'))
    .description('Generate an evidence-backed ship report (exit 2 when NOT_READY)')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdShip(g));
    });

  // --- learn ---
  withGlobals(program.command('learn'))
    .description('Analyze recurring failures and create durable remedies (skills, notes, memory)')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdLearn(g));
    });

  // --- guard (PreToolUse hook; fail-open; may emit a deliberate exit-2 block) ---
  withGlobals(program.command('guard'))
    .description('PreToolUse hook: block edits to protected paths in guarded mode (fail-open)')
    .action(function (this: Command) {
      return runHookAction(this, (g, payload) => commands.cmdGuard(g, payload));
    });

  // --- record-evidence (PostToolUse hook; fail-open) ---
  withGlobals(program.command('record-evidence'))
    .description('PostToolUse hook: record evidence of a tool action to the ledger (fail-open)')
    .action(function (this: Command) {
      return runHookAction(this, (g, payload) => commands.cmdRecordEvidence(g, payload));
    });

  // --- distill (Stop hook; fail-open; runs before the ship gate) ---
  withGlobals(program.command('distill'))
    .description('Stop hook: distill the session transcript into a run record + observed memory (fail-open)')
    .option('--transcript <path>', 'transcript path (otherwise read from the hook payload stdin)')
    .action(function (this: Command) {
      const o = this.opts();
      const transcriptOverride = typeof o.transcript === 'string' ? o.transcript : undefined;
      return runHookAction(this, (g, payload) => commands.cmdDistill(g, { ...payload, transcriptOverride }));
    });

  // --- daemon ---
  const daemonCmd = withGlobals(program.command('daemon')).description(
    'Local daemon: watch the repo and serve the API + dashboard on 127.0.0.1',
  );
  withGlobals(daemonCmd.command('start'))
    .description('Start the daemon in the background')
    .option('--port <n>', 'port to bind on 127.0.0.1 (default 7420)')
    .action(function (this: Command) {
      const o = this.opts();
      return runAction(this, (g) => daemon.cmdDaemonStart(g, { port: parsePort(o.port) }));
    });
  withGlobals(daemonCmd.command('stop'))
    .description('Stop the running daemon')
    .action(function (this: Command) {
      return runAction(this, (g) => daemon.cmdDaemonStop(g));
    });
  withGlobals(daemonCmd.command('status'))
    .description('Report whether the daemon is running')
    .action(function (this: Command) {
      return runAction(this, (g) => daemon.cmdDaemonStatus(g));
    });

  // --- dashboard ---
  withGlobals(program.command('dashboard'))
    .description('Start the daemon (if needed) and print the local dashboard URL')
    .option('--port <n>', 'port to bind on 127.0.0.1 (default 7420)')
    .action(function (this: Command) {
      const o = this.opts();
      return runAction(this, (g) => daemon.cmdDashboard(g, { port: parsePort(o.port) }));
    });

  // --- memory ---
  const memory = withGlobals(program.command('memory')).description('Project memory ledger');

  withGlobals(memory.command('add'))
    .description('Record a memory item')
    .requiredOption('--title <title>', 'short title')
    .requiredOption('--summary <summary>', 'one-paragraph summary')
    .option('--type <type>', 'fact | decision | risk | assumption | constraint | pattern', 'fact')
    .option('--source <source>', 'where this came from', 'cli')
    .option('--confidence <0..1>', 'confidence the memory is true', '0.5')
    .option('--risk <level>', 'low | medium | high | critical', 'low')
    .option('--related-file <path>', 'repeatable: a related file', collect, [])
    .option('--related-feature <id>', 'repeatable: a related feature id', collect, [])
    .action(function (this: Command) {
      const o = this.opts();
      return runAction(this, (g) =>
        commands.cmdMemoryAdd(g, {
          type: String(o.type),
          title: String(o.title),
          summary: String(o.summary),
          source: String(o.source),
          confidence: String(o.confidence),
          risk: String(o.risk),
          relatedFile: o.relatedFile as string[],
          relatedFeature: o.relatedFeature as string[],
        }),
      );
    });

  withGlobals(memory.command('list'))
    .description('List memory items')
    .option('--type <type>', 'filter by memory type')
    .action(function (this: Command) {
      const o = this.opts();
      const type = typeof o.type === 'string' ? o.type : undefined;
      return runAction(this, (g) => commands.cmdMemoryList(g, { type }));
    });

  withGlobals(memory.command('get'))
    .description('Show one memory item')
    .argument('<id>', 'memory id')
    .action(function (this: Command, id: string) {
      return runAction(this, (g) => commands.cmdMemoryGet(g, id));
    });

  // --- feature ---
  const feature = withGlobals(program.command('feature')).description('Project feature ledger');

  withGlobals(feature.command('add'))
    .description('Record a feature')
    .requiredOption('--name <name>', 'feature name')
    .requiredOption('--purpose <purpose>', 'why it exists')
    .requiredOption('--user-value <value>', 'the value it delivers')
    .option('--status <status>', 'planned | building | shipped | deprecated', 'planned')
    .option('--route <path>', 'repeatable: a route', collect, [])
    .option('--component <path>', 'repeatable: a component', collect, [])
    .option('--api <path>', 'repeatable: an API endpoint', collect, [])
    .option('--table <name>', 'repeatable: a database table', collect, [])
    .option('--env <name>', 'repeatable: an env var', collect, [])
    .option('--dependency <name>', 'repeatable: a dependency', collect, [])
    .option('--acceptance <text>', 'repeatable: an acceptance criterion', collect, [])
    .option('--test <path>', 'repeatable: a test', collect, [])
    .option('--known-risk <text>', 'repeatable: a known risk', collect, [])
    .option('--protected-behavior <text>', 'repeatable: a behavior that must not regress', collect, [])
    .option('--related-decision <id>', 'repeatable: a related decision id', collect, [])
    .option('--regression-check <text>', 'repeatable: a regression check', collect, [])
    .action(function (this: Command) {
      const o = this.opts();
      return runAction(this, (g) =>
        commands.cmdFeatureAdd(g, {
          name: String(o.name),
          purpose: String(o.purpose),
          userValue: String(o.userValue),
          status: String(o.status),
          route: o.route as string[],
          component: o.component as string[],
          api: o.api as string[],
          table: o.table as string[],
          env: o.env as string[],
          dependency: o.dependency as string[],
          acceptance: o.acceptance as string[],
          test: o.test as string[],
          knownRisk: o.knownRisk as string[],
          protectedBehavior: o.protectedBehavior as string[],
          relatedDecision: o.relatedDecision as string[],
          regressionCheck: o.regressionCheck as string[],
        }),
      );
    });

  withGlobals(feature.command('list'))
    .description('List features')
    .option('--status <status>', 'filter by status')
    .action(function (this: Command) {
      const o = this.opts();
      const status = typeof o.status === 'string' ? o.status : undefined;
      return runAction(this, (g) => commands.cmdFeatureList(g, { status }));
    });

  withGlobals(feature.command('get'))
    .description('Show one feature record')
    .argument('<id>', 'feature id')
    .action(function (this: Command, id: string) {
      return runAction(this, (g) => commands.cmdFeatureGet(g, id));
    });

  // --- skill ---
  const skill = withGlobals(program.command('skill')).description('Skill engine (reusable engineering behaviors)');

  withGlobals(skill.command('list'))
    .description('List built-in and installed skills')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdSkillList(g));
    });

  withGlobals(skill.command('recommend'))
    .description('Recommend skills for a task, ranked by trigger match')
    .argument('<task...>', 'the task to recommend skills for')
    .action(function (this: Command, taskParts: string[]) {
      return runAction(this, (g) => commands.cmdSkillRecommend(g, taskParts.join(' ')));
    });

  withGlobals(skill.command('install'))
    .description('Install a built-in skill into the project (.cortex/skills/)')
    .argument('<id>', 'the built-in skill id to install')
    .action(function (this: Command, id: string) {
      return runAction(this, (g) => commands.cmdSkillInstall(g, id));
    });

  // --- workflow ---
  const workflow = withGlobals(program.command('workflow')).description('Workflow orchestrator (risk-scaled task workflows)');

  withGlobals(workflow.command('list'))
    .description('List the named workflows')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdWorkflowList(g));
    });

  withGlobals(workflow.command('run'))
    .description('Run a named workflow and persist a WorkflowRun (exit 2 when blocked)')
    .argument('<id>', 'the workflow id (see `workflow list`)')
    .argument('<task...>', 'the task the workflow operates on')
    .action(function (this: Command, id: string, taskParts: string[]) {
      return runAction(this, (g) => commands.cmdWorkflowRun(g, id, taskParts.join(' ')));
    });

  // --- mcp (Safe MCP Manager, §7.19) ---
  const mcp = withGlobals(program.command('mcp')).description(
    'Safe MCP Manager — recommend, install (read-only by default), and audit MCP servers',
  );

  withGlobals(mcp.command('list'))
    .description('List installed MCP servers and the catalog servers recommended next')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdMcpList(g));
    });

  withGlobals(mcp.command('recommend'))
    .description('Recommend MCP servers for a task, ranked by task + stack match')
    .argument('<task...>', 'the task to recommend MCP servers for')
    .action(function (this: Command, taskParts: string[]) {
      return runAction(this, (g) => commands.cmdMcpRecommend(g, taskParts.join(' ')));
    });

  withGlobals(mcp.command('install'))
    .description('Safely install a catalog MCP server (read-only posture; refuses unknown ids)')
    .argument('<id>', 'the catalog MCP server id (see `mcp list`)')
    .option('-f, --force', 'overwrite an existing .mcp.json entry for this id', false)
    .action(function (this: Command, id: string) {
      const opts = this.opts();
      return runAction(this, (g) => commands.cmdMcpInstall(g, id, { force: opts.force === true }));
    });

  withGlobals(mcp.command('audit'))
    .description('Audit installed MCP servers against the firewall policy for write/destructive/secret risks')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdMcpAudit(g));
    });

  // --- firewall (MCP Security Firewall, §7.20) ---
  const firewall = withGlobals(program.command('firewall')).description(
    'MCP security firewall — the allow / deny / require-approval policy for tool calls',
  );

  withGlobals(firewall.command('show'))
    .description('Print the effective firewall policy (safe defaults when none is configured)')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdFirewallShow(g));
    });

  withGlobals(firewall.command('check'))
    .description('Evaluate a sample tool call and print the decision, risk score, and reasons')
    .argument('<server>', 'the MCP server id, e.g. github')
    .argument('<tool>', 'the tool name on that server, e.g. delete_branch')
    .action(function (this: Command, server: string, tool: string) {
      return runAction(this, (g) => commands.cmdFirewallCheck(g, server, tool));
    });

  // --- privacy (Privacy & Redaction Engine, §7.22) ---
  const privacy = withGlobals(program.command('privacy')).description(
    'Privacy & redaction — the active privacy mode and what may leave the machine',
  );

  withGlobals(privacy.command('status'))
    .description('Show the active privacy mode and what each mode permits')
    .action(function (this: Command) {
      return runAction(this, (g) => commands.cmdPrivacyStatus(g));
    });

  withGlobals(privacy.command('redact'))
    .description('Print a redaction summary for a file (secrets / PII the engine would mask)')
    .argument('<file>', 'path to the file to scan')
    .action(function (this: Command, file: string) {
      return runAction(this, (g) => commands.cmdPrivacyRedact(g, file));
    });

  // --- install ---
  withGlobals(program.command('install'))
    .description('Install a host integration (claude, codex, cursor, vscode, github) — or --all')
    .argument('[target]', 'integration target: claude | codex | cursor | vscode | github')
    .option('--all', 'install every supported host integration', false)
    .option('-f, --force', 'apply changes even when files would be overwritten', false)
    .action(function (this: Command, target: string | undefined) {
      const opts = this.opts();
      const force = opts.force === true;
      if (opts.all === true) {
        return runAction(this, (g) => commands.cmdInstallAll(g, { force }));
      }
      return runAction(this, (g) => commands.cmdInstall(g, target, { force }));
    });

  return program;
}

export async function run(argv: readonly string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help / version display and usage errors: commander already wrote output.
      // Honour its exit code (0 for help/version, non-zero for usage errors).
      process.exitCode = err.exitCode;
      return;
    }
    // Unreachable in practice (action errors are handled in runAction), but we
    // refuse to ever surface a raw stack.
    const json = argv.includes('--json');
    fail(err, json);
  }
}

run(process.argv).catch((err: unknown) => {
  // Absolute last-resort guard so the process never dies with an unhandled
  // rejection / raw stack trace.
  fail(err, process.argv.includes('--json'));
});
