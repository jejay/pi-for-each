/**
 * pi-for — a pi extension that adds a `/for` prompt-loop command with variable
 * insertion.
 *
 * ---------------------------------------------------------------------------
 * What it does
 * ---------------------------------------------------------------------------
 * Write a message that contains `$each@<path>` (dollar + "each" + at-sign +
 * a file or directory path), then invoke it as the `/for` command, e.g.:
 *
 *     /for Please reword the skill in $each@./skills/ and make it more polite
 *
 * While composing the message, typing `$each@` opens pi's fuzzy file/directory
 * search (the same one `@` after a space opens) so you can pick a path. The
 * in-editor command becomes `$each@<file-or-dir>`.
 *
 * When the `/for` command runs, it executes a *prompt loop*:
 *
 *   - If the path points to a DIRECTORY, the loop iterates over every child
 *     element (files and subdirectories, excluding dotfiles). Each iteration
 *     replaces the full `$each@<dir>` token with `<dir>/<child>` (directories
 *     keep a trailing slash).
 *   - If the path points to a FILE, the loop iterates over every line of the
 *     file. Each iteration replaces the full `$each@<file>` token with the
 *     corresponding line.
 *
 * Iterations are strictly sequential (no parallelism). The first iteration is
 * sent as a normal message into the *current* (origin) session. Every following
 * iteration **forks** the session from the message that preceded the loop, so
 * each iteration lives in its own session file (the fork semantic: the origin
 * survives with the first message, and every following iteration keeps the same
 * base context while the previous iteration's session is replaced). While the
 * loop runs, a hint is shown in the same region the UI normally uses for queued
 * messages.
 *
 * ---------------------------------------------------------------------------
 * Implementation notes
 * ---------------------------------------------------------------------------
 * - This is driven by a real registered command (`/for`). The fork is a hard
 *   requirement, and `ctx.fork()` is only available on `ExtensionCommandContext`
 *   (the context passed to command handlers) — `ExtensionContext` (used by the
 *   `input`/`session_start` handlers) does not expose it. So the loop runs
 *   inside the `/for` command handler, where `cmdCtx.fork()` is available.
 * - `ExtensionAPI.sendUserMessage()` intentionally skips command handling
 *   (`expandPromptTemplates: false`), so the old approach of
 *   `sendUserMessage("/clone")` could never fork — `/clone` was just appended
 *   as a literal message into the same session. That is why the loop previously
 *   chained every iteration into one session. We now use the real `ctx.fork()`.
 * - The `$each@` fuzzy search reuses pi's built-in fuzzy file/directory provider
 *   (`CombinedAutocompleteProvider.getFuzzyFileSuggestions`) via a wrapping
 *   `AutocompleteProvider`, plus a `readdir` fallback. The editor is extended so
 *   that typing `$each@` opens that search exactly as `@` after a space does.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  EditorComponent,
  EditorTheme,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// `$each@` followed by a (possibly empty) token of non-`@`, non-space characters.
// Used to detect the trigger while typing / at the cursor and to open the search.
const FOR_CONTEXT_RE = /\$each@([^@\s]*)$/;
// Global variant used to find the token anywhere in a submitted message.
const FOR_TOKEN_RE = /\$each@(\S+)/;
// Bare trigger with no path (e.g. `$each@ ` or a message ending in `$each@`).
const FOR_BARE_RE = /\$each@(?=\s|$)/;

const WIDGET_KEY = "pi-for";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let wordCwd = process.cwd();
let loopRunning = false;
/** Latest session context. Updated on every session_start so the loop can act
 * on the *current* session after a fork switches the active runtime. */
let currentCtx: ExtensionCommandContext | null = null;
/** Resolvers for pending "wait until the agent has settled" promises. */
let settleWaiters: Array<() => void> = [];
/** Resolvers for pending session_start events, keyed by reason. */
let sessionStartWaiters: Array<(reason: string) => void> = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string for compact hint rendering. */
function truncate(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Build the replacement value for a directory child. */
function childReplacement(
  tokenPath: string,
  childName: string,
  isDir: boolean,
): string {
  let joined: string;
  if (tokenPath === "" || tokenPath === ".") {
    joined = childName;
  } else if (tokenPath.endsWith("/")) {
    joined = tokenPath + childName;
  } else {
    joined = tokenPath + "/" + childName;
  }
  // Directories keep a trailing slash so the resulting path is unambiguous.
  return isDir ? (joined.endsWith("/") ? joined : joined + "/") : joined;
}

/** Resolve the loop kind and the ordered list of replacement values. */
function buildReplacements(
  tokenPath: string,
  cwd: string,
): { kind: "directory" | "line"; kindLabel: string; replacements: string[] } {
  const abs = resolve(cwd, tokenPath);
  if (!existsSync(abs)) throw new Error(`${tokenPath} does not exist`);
  const st = statSync(abs);
  if (st.isDirectory()) {
    const children = readdirSync(abs, { withFileTypes: true }).filter(
      (e) => e.name !== "." && e.name !== ".." && !e.name.startsWith("."),
    );
    const replacements = children.map((e) => {
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(join(abs, e.name)).isDirectory();
        } catch {
          /* broken symlink — treat as file */
        }
      }
      return childReplacement(tokenPath, e.name, isDir);
    });
    return { kind: "directory", kindLabel: "directory", replacements };
  }
  if (st.isFile()) {
    const content = readFileSync(abs, "utf8");
    const lines = content.split("\n");
    // Drop a trailing empty line left by a final newline.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const replacements = lines.map((l) => l.replace(/\r$/, ""));
    return { kind: "line", kindLabel: "line", replacements };
  }
  throw new Error(`${tokenPath} is neither a file nor a directory`);
}

/** Resolve on the next `agent_settled` event. */
function waitForSettle(): Promise<void> {
  return new Promise((resolve) => {
    settleWaiters.push(resolve);
  });
}

/**
 * Resolve on the next `session_start` whose reason matches. Used to detect when
 * a fork has switched the active session to the new file.
 * A timeout safety net prevents the loop from hanging if the switch never fires.
 */
function waitForSessionStart(reason: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (r: string) => {
      if (done || r !== reason) return;
      done = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("session switch did not complete in time"));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    sessionStartWaiters.push(finish);
  });
}

/** Current UI context, preferring the live (post-fork) session context. */
function ui() {
  return currentCtx?.ui;
}

// ---------------------------------------------------------------------------
// The for-loop, driven from the `/for` command handler (has ctx.fork()).
// ---------------------------------------------------------------------------

async function runLoop(
  pi: ExtensionAPI,
  args: string,
  cmdCtx: ExtensionCommandContext,
): Promise<void> {
  if (loopRunning) {
    cmdCtx.ui.notify("pi-for: a for-loop is already running", "warning");
    return;
  }
  loopRunning = true;

  const showHint = (i: number, total: number, kindLabel: string, value: string) => {
    if (!ui()) return;
    ui()!.setWidget(WIDGET_KEY, [
      `for-loop · ${i + 1}/${total} · ${kindLabel}`,
      `↳ ${truncate(value)}`,
    ]);
  };
  const clearHint = () => {
    if (!ui()) return;
    try {
      ui()!.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* ignore */
    }
  };

  try {
    const m = args.match(FOR_TOKEN_RE);
    if (!m) {
      cmdCtx.ui.notify(
        "pi-for: no $each@<path> token found. Example: /for Review $each@./src/",
        "error",
      );
      return;
    }
    const tokenPath = m[1];

    let parsed: ReturnType<typeof buildReplacements>;
    try {
      parsed = buildReplacements(tokenPath, cmdCtx.cwd);
    } catch (err) {
      cmdCtx.ui.notify(
        `pi-for: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    const { kindLabel, replacements } = parsed;
    const total = replacements.length;
    if (total === 0) {
      cmdCtx.ui.notify(`pi-for: no iterations found for ${tokenPath}`, "warning");
      return;
    }

    // The leaf of the conversation that existed *before* the loop started. Every
    // subsequent iteration forks from this point, so each forked session keeps
    // only this base context plus a single iteration. Capture it now, before we
    // send iteration 0 (which would otherwise advance the leaf past it).
    const preLoopLeafId = cmdCtx.sessionManager.getLeafId();

    // Replace the *full* `$each@<path>` token (not just the path) with the value.
    const replaceToken = (replacement: string) =>
      args.replace(FOR_TOKEN_RE, replacement);

    // Send a message into the *current* active session and wait for the agent
    // to fully settle. Used for iteration 0 (sent into the origin session).
    const sendAndWait = async (value: string) => {
      const wait = waitForSettle();
      pi.sendUserMessage(replaceToken(value));
      await wait;
    };

    // Iterations 1..N-1 each fork into a *new session file*. Because forking
    // disposes the previous session and invalidates the captured command ctx,
    // we must NOT reuse `cmdCtx` across forks. Instead we fork from the live
    // `ctx` passed in, and do all post-fork work inside the `withSession`
    // callback, which receives a *fresh* `ReplacedSessionContext` (it even has
    // its own `sendUserMessage`/`fork`). We then recurse using that fresh ctx
    // for the next iteration — matching pi's documented fork pattern.
    const forkChain = async (i: number, ctx: ExtensionCommandContext) => {
      if (i >= total) return;

      const swapped = waitForSessionStart("fork");
      await ctx.fork(preLoopLeafId, {
        position: "at",
        withSession: async (ctx2) => {
          // We are now inside the freshly forked session (its session_start has
          // already fired and updated `currentCtx`). Set the hint HERE, on the
          // new session's UI — not before the fork, or it would be written to
          // the session that is about to be torn down and never shown.
          showHint(i, total, kindLabel, replacements[i]);

          // ctx2 is a fresh ReplacedSessionContext bound to the newly forked
          // session (its type is inferred from fork()'s withSession signature).
          const wait = waitForSettle();
          ctx2.sendUserMessage(replaceToken(replacements[i]));
          await wait;
          // Continue the chain with the fresh context for the next iteration.
          await forkChain(i + 1, ctx2);
        },
      });
      // Wait until the runtime has actually switched to the new session file.
      await swapped;
    };

    // Iteration 0 — sent into the current (origin) session, no fork. The origin
    // thereby survives with this first message (fork semantic).
    showHint(0, total, kindLabel, replacements[0]);
    await sendAndWait(replacements[0]);

    // No base message to fork from (empty session), or fork is unavailable in
    // this mode: degrade to plain sequential sends rather than throwing inside
    // the fork call.
    if (!preLoopLeafId || typeof cmdCtx.fork !== "function") {
      if (!preLoopLeafId) {
        cmdCtx.ui.notify(
          "pi-for: no base message to fork from; sending remaining iterations sequentially",
          "warning",
        );
      } else {
        cmdCtx.ui.notify(
          "pi-for: fork is unavailable in this mode; sending remaining iterations sequentially",
          "warning",
        );
      }
      for (let i = 1; i < total; i++) {
        showHint(i, total, kindLabel, replacements[i]);
        await sendAndWait(replacements[i]);
      }
      return;
    }

    // Fork iterations 1..N-1, each into its own session file.
    await forkChain(1, cmdCtx);
  } catch (err) {
    cmdCtx.ui.notify(
      `pi-for: loop error: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  } finally {
    loopRunning = false;
    clearHint();
  }
}

// ---------------------------------------------------------------------------
// Autocomplete provider: makes `$each@` open pi's fuzzy file/directory search.
// ---------------------------------------------------------------------------

class ForAutocompleteProvider implements AutocompleteProvider {
  triggerCharacters = ["@", "#"];
  private readonly current: AutocompleteProvider;
  private readonly getCwd: () => string;

  constructor(current: AutocompleteProvider, getCwd: () => string) {
    this.current = current;
    this.getCwd = getCwd;
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (FOR_CONTEXT_RE.test(before)) return true;
    return this.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const m = before.match(FOR_CONTEXT_RE);
    if (!m) {
      return this.current.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    const partial = m[1];
    const cwd = this.getCwd();
    let items = await this.fuzzy(partial, options);
    if (items.length === 0) items = this.fallback(partial, cwd);

    // Strip the leading "@" pi's fuzzy provider adds so we can re-prefix with
    // `$each@` in applyCompletion.
    const transformed: AutocompleteItem[] = items.map((it) => ({
      value: it.value && it.value.startsWith("@") ? it.value.slice(1) : it.value,
      label: it.label,
      description: it.description,
    }));

    return { items: transformed, prefix: "$each@" + partial };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (prefix.startsWith("$each@")) {
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);
      // Don't add a space after directories so the user can keep autocompleting.
      const isDir = item.label.endsWith("/");
      const suffix = isDir ? "" : " ";
      const newLine = beforePrefix + "$each@" + item.value + suffix + afterCursor;
      const newLines = lines.slice();
      newLines[cursorLine] = newLine;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + "$each@".length + item.value.length + suffix.length,
      };
    }
    return this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  /** Delegate to pi's real fuzzy file/directory search when available. */
  private async fuzzy(
    partial: string,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteItem[]> {
    const fn = (this.current as unknown as {
      getFuzzyFileSuggestions?: (
        query: string,
        opts: { signal: AbortSignal; isQuotedPrefix?: boolean },
      ) => Promise<AutocompleteItem[] | null>;
    }).getFuzzyFileSuggestions;
    if (typeof fn !== "function") return [];
    try {
      const res = await fn.call(this.current, partial, { signal: options.signal });
      return res ?? [];
    } catch {
      return [];
    }
  }

  /** Synchronous directory listing fallback when no fuzzy finder is present. */
  private fallback(partial: string, cwd: string): AutocompleteItem[] {
    let searchDir: string;
    let searchPrefix: string;
    if (
      partial === "" ||
      partial === "./" ||
      partial === "../" ||
      partial === "~" ||
      partial === "~/" ||
      partial === "/"
    ) {
      searchDir = partial === "" ? cwd : partial.startsWith("/") ? partial : resolve(cwd, partial);
      searchPrefix = "";
    } else if (partial.endsWith("/")) {
      searchDir = partial.startsWith("/") ? partial : resolve(cwd, partial);
      searchPrefix = "";
    } else {
      const d = partial.startsWith("/") ? dirname(partial) : resolve(cwd, dirname(partial));
      searchDir = d;
      searchPrefix = basename(partial);
    }

    let entries: ReturnType<typeof readdirSync> | undefined;
    try {
      entries = readdirSync(searchDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const items: AutocompleteItem[] = [];
    for (const e of entries) {
      if (e.name === "." || e.name === "..") continue;
      if (e.name.startsWith(".")) continue;
      if (searchPrefix && !e.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(join(searchDir, e.name)).isDirectory();
        } catch {
          /* ignore */
        }
      }
      const value = isDir ? e.name + "/" : e.name;
      items.push({
        value,
        label: isDir ? e.name + "/" : e.name,
        description: isDir ? "directory" : "file",
      });
    }
    items.sort((a, b) => {
      const ad = a.value.endsWith("/") ? 0 : 1;
      const bd = b.value.endsWith("/") ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.label.localeCompare(b.label);
    });
    return items;
  }
}

// ---------------------------------------------------------------------------
// Editor: extends the default editor so that typing `$each@` opens the search.
// ---------------------------------------------------------------------------

class ForEditor extends CustomEditor {
  handleInput(data: string): void {
    // Let the default editor handle everything (typing, native `@` after space,
    // autocomplete continuation, etc.).
    super.handleInput(data);

    try {
      const { line, col } = this.getCursor();
      const lines = this.getLines();
      const before = (lines[line] ?? "").slice(0, col);
      if (FOR_CONTEXT_RE.test(before) && !this.isShowingAutocomplete()) {
        // The built-in trigger only fires when `@` follows a space/tab, so we
        // explicitly open the autocomplete for the `$each@` context. Once open,
        // the editor keeps it updated as the user keeps typing.
        const trigger = (
          this as unknown as { tryTriggerAutocomplete?: () => void }
        ).tryTriggerAutocomplete;
        if (typeof trigger === "function") trigger.call(this);
      }
    } catch {
      // Never let autocomplete wiring break normal editing.
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Register the `/for` command. Command handlers receive an
  // `ExtensionCommandContext` that exposes `ctx.fork()`, which is what makes
  // the per-iteration fork into separate session files possible.
  pi.registerCommand("for", {
    description:
      "Run a prompt loop: fork a new session per iteration over a directory or file referenced by a $each@<path> token.",
    handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
      await runLoop(pi, args, cmdCtx);
    },
  });

  // Wrap the active autocomplete provider so `$each@` opens the file search, and
  // extend the editor so typing `$each@` triggers the search. The wrapper list is
  // reset on every session rebind (including forks), so re-wrapping here is safe
  // and never nests.
  pi.on("session_start", (_event, ctx) => {
    wordCwd = ctx.cwd;
    currentCtx = ctx as ExtensionCommandContext;
    ctx.ui.addAutocompleteProvider(
      (current) => new ForAutocompleteProvider(current, () => wordCwd),
    );
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent =>
        new ForEditor(tui, theme, keybindings),
    );
    // Notify any pending loop that the session switched (e.g. after a fork).
    const waiters = sessionStartWaiters;
    sessionStartWaiters = [];
    for (const w of waiters) w(_event.reason);
  });

  // Resolve any pending "wait for the agent to settle" promises.
  pi.on("agent_settled", () => {
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const w of waiters) w();
  });

  // Drop in-flight waiters when the session ends. Note: during a fork the
  // old session's `session_shutdown` fires *before* the new session's
  // `session_start`, so we must NOT clear `sessionStartWaiters` here (that would
  // orphan a pending fork-wait) and must NOT reset `currentCtx`/`loopRunning`
  // (the loop continues in the forked session).
  pi.on("session_shutdown", () => {
    settleWaiters = [];
  });

  // Guard against the old `$each@`-as-a-plain-message syntax. A `$each@<path>`
  // token only works inside the `/for` command now; if a user submits it as a
  // normal message we explain the new invocation instead of silently sending an
  // unresolved token to the model.
  pi.on("input", (event, ctx): InputEventResult | void => {
    if (event.source === "extension") return { action: "continue" };

    const text = event.text;
    // The `/for` command is handled by the command pipeline, not here.
    if (text.startsWith("/for")) return { action: "continue" };

    if (FOR_TOKEN_RE.test(text)) {
      ctx.ui.notify(
        "pi-for: use the /for command — e.g. /for Review $each@./src/",
        "warning",
      );
      return { action: "handled" };
    }

    if (FOR_BARE_RE.test(text)) {
      ctx.ui.notify("pi-for: $each@ needs a file or directory path", "warning");
      return { action: "handled" };
    }

    return { action: "continue" };
  });
}
