/**
 * pi-for — a pi extension that adds a `$for@` prompt-loop editor feature.
 *
 * ---------------------------------------------------------------------------
 * What it does
 * ---------------------------------------------------------------------------
 * While composing a message you can write `$for@` (dollar + "for" + at-sign).
 * Vanilla pi only opens its fuzzy file/directory search when `@` follows a
 * space. This extension additionally opens that *same* fuzzy search when `@`
 * follows `$for`. Pick a path and the in-editor command becomes
 * `$for@<file-or-dir>`.
 *
 * When such a message is submitted, the extension runs a *prompt loop*:
 *
 *   - If the path points to a DIRECTORY, the loop iterates over every child
 *     element (files and subdirectories, excluding dotfiles). Each iteration
 *     replaces the full `$for@<dir>` token with `<dir>/<child>` (directories
 *     keep a trailing slash).
 *   - If the path points to a FILE, the loop iterates over every line of the
 *     file. Each iteration replaces the full `$for@<file>` token with the
 *     corresponding line.
 *
 * Iterations are strictly sequential (no parallelism). The first iteration is
 * sent as a normal message. Every following iteration *forks* the session from
 * the previous conversation (position "before") so that the previous message is
 * replaced while the earlier conversation context is preserved, then sends the
 * next replacement. While the loop runs, a hint is shown in the same region the
 * UI normally uses for queued messages.
 *
 * ---------------------------------------------------------------------------
 * Implementation notes
 * ---------------------------------------------------------------------------
 * - This is an *editor* feature, not a slash command. No command is registered.
 *   The loop is driven entirely from the `input` event handler.
 * - The fork semantic is a hard requirement, but the `/fork` *command* is not
 *   used. Instead the fork is re-implemented at a lower level by calling
 *   `SessionManager.branch()` to move the active leaf back to the pre-loop
 *   conversation, then `pi.sendUserMessage()` to append the next iteration as a
 *   fresh branch. This reproduces the fork/clone behaviour (each iteration has
 *   the same base context; the previous iteration's message is replaced) without
 *   switching session files and without any slash command.
 * - The `$for@` fuzzy search reuses pi's built-in fuzzy file/directory provider
 *   (`CombinedAutocompleteProvider.getFuzzyFileSuggestions`) via a wrapping
 *   `AutocompleteProvider`, plus a `readdir` fallback. The editor is extended so
 *   that typing `$for@` opens that search exactly as `@` after a space does.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
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

// `$for@` followed by a (possibly empty) token of non-`@`, non-space characters.
// Used to detect the trigger while typing / at the cursor and to open the search.
const FOR_CONTEXT_RE = /\$for@([^@\s]*)$/;
// Global variant used to find the token anywhere in a submitted message.
const FOR_TOKEN_RE = /\$for@(\S+)/;
// Bare trigger with no path (e.g. `$for@ ` or a message ending in `$for@`).
const FOR_BARE_RE = /\$for@(?=\s|$)/;

const WIDGET_KEY = "pi-for";

/** Lower-level SessionManager methods used to re-implement the fork. */
interface BranchableSessionManager {
  getLeafId(): string | null;
  branch(branchFromId: string): void;
  resetLeaf(): void;
}

interface LoopPlan {
  /** Original message text that contains the `$for@<path>` token. */
  text: string;
  /** Working directory at submit time. */
  cwd: string;
  /** Path captured from the `$for@<path>` token. */
  tokenPath: string;
  /** Leaf id of the last message before the for-loop started. */
  preLoopLeafId: string | null;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let wordCwd = process.cwd();
let loopRunning = false;
/** Resolvers for pending "wait until the agent has settled" promises. */
let settleWaiters: Array<() => void> = [];

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

// ---------------------------------------------------------------------------
// The for-loop, driven from the `input` handler (no slash command).
// ---------------------------------------------------------------------------

async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  plan: LoopPlan,
): Promise<void> {
  loopRunning = true;
  const sm = ctx.sessionManager as unknown as BranchableSessionManager;
  const showHint = (i: number, total: number, kindLabel: string, value: string) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, [
      `for-loop · ${i + 1}/${total} · ${kindLabel}`,
      `↳ ${truncate(value)}`,
    ]);
  };
  const clearHint = () => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* ignore */
    }
  };

  try {
    let parsed: ReturnType<typeof buildReplacements>;
    try {
      parsed = buildReplacements(plan.tokenPath, plan.cwd);
    } catch (err) {
      ctx.ui.notify(`pi-for: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }

    const { kindLabel, replacements } = parsed;
    const total = replacements.length;
    if (total === 0) {
      ctx.ui.notify(`pi-for: no iterations found for ${plan.tokenPath}`, "warning");
      return;
    }

    // Replace the *full* `$for@<path>` token (not just the path) with the value.
    const replaceToken = (replacement: string) =>
      plan.text.replace(FOR_TOKEN_RE, replacement);

    // Iteration 0 — sent normally, no fork (the leaf is already the pre-loop
    // conversation, so this simply continues from it).
    showHint(0, total, kindLabel, replacements[0]);
    {
      const wait = waitForSettle();
      pi.sendUserMessage(replaceToken(replacements[0]));
      await wait;
    }

    // Iterations 1..N-1 — re-implement the fork: move the active leaf back to
    // the pre-loop conversation, then append the next iteration as a fresh
    // branch. The previous iteration's message is thereby replaced while the
    // earlier conversation context is preserved.
    for (let i = 1; i < total; i++) {
      if (plan.preLoopLeafId) sm.branch(plan.preLoopLeafId);
      else sm.resetLeaf();
      showHint(i, total, kindLabel, replacements[i]);
      const wait = waitForSettle();
      pi.sendUserMessage(replaceToken(replacements[i]));
      await wait;
    }
  } catch (err) {
    ctx.ui.notify(
      `pi-for: loop error: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  } finally {
    loopRunning = false;
    clearHint();
  }
}

// ---------------------------------------------------------------------------
// Autocomplete provider: makes `$for@` open pi's fuzzy file/directory search.
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
    // `$for@` in applyCompletion.
    const transformed: AutocompleteItem[] = items.map((it) => ({
      value: it.value && it.value.startsWith("@") ? it.value.slice(1) : it.value,
      label: it.label,
      description: it.description,
    }));

    return { items: transformed, prefix: "$for@" + partial };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (prefix.startsWith("$for@")) {
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);
      // Don't add a space after directories so the user can keep autocompleting.
      const isDir = item.label.endsWith("/");
      const suffix = isDir ? "" : " ";
      const newLine = beforePrefix + "$for@" + item.value + suffix + afterCursor;
      const newLines = lines.slice();
      newLines[cursorLine] = newLine;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + "$for@".length + item.value.length + suffix.length,
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
// Editor: extends the default editor so that typing `$for@` opens the search.
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
        // explicitly open the autocomplete for the `$for@` context. Once open,
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
  // Open the fuzzy search for `$for@` and handle the loop. Registered once.
  pi.on("session_start", (_event, ctx) => {
    wordCwd = ctx.cwd;
    // Wrap the active autocomplete provider so `$for@` opens the file search.
    ctx.ui.addAutocompleteProvider(
      (current) => new ForAutocompleteProvider(current, () => wordCwd),
    );
    // Extend the editor so typing `$for@` triggers the search.
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent =>
        new ForEditor(tui, theme, keybindings),
    );
  });

  // Resolve any pending "wait for the agent to settle" promises.
  pi.on("agent_settled", () => {
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const w of waiters) w();
  });

  // Drop any in-flight loop state when the session ends.
  pi.on("session_shutdown", () => {
    loopRunning = false;
    settleWaiters = [];
  });

  // Detect a submitted message that contains `$for@<path>` and run the loop.
  // We only act on user-typed / RPC input; messages we inject ourselves
  // (source === "extension") are ignored so the loop never re-triggers itself.
  pi.on("input", (event, ctx): InputEventResult | void => {
    if (event.source === "extension") return { action: "continue" };

    const text = event.text;
    if (FOR_TOKEN_RE.test(text)) {
      // A `$for@<path>` token is present — run the loop.
      if (loopRunning) {
        ctx.ui.notify("pi-for: a for-loop is already running", "warning");
        return { action: "handled" };
      }

      const m = text.match(FOR_TOKEN_RE)!;
      const plan: LoopPlan = {
        text,
        cwd: ctx.cwd,
        tokenPath: m[1],
        preLoopLeafId: ctx.sessionManager.getLeafId(),
      };

      // Swallow the original message and drive the loop asynchronously.
      void runLoop(pi, ctx, plan);
      return { action: "handled" };
    }

    // `$for@` present but with no path attached — it needs a path.
    if (FOR_BARE_RE.test(text)) {
      ctx.ui.notify("pi-for: $for@ needs a file or directory path", "warning");
      return { action: "handled" };
    }

    return { action: "continue" };
  });
}
