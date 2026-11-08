# Code style and working rules

This file is the instruction for anyone changing Chronicle, and above all for AI agents. Read it before the first edit and follow it without being asked. When a rule here conflicts with a habit, the rule wins. When this file and the code disagree, say so instead of guessing.

## How to work

1. **Read before writing.** Find how the nearby code already does it and do the same. Reuse an existing helper instead of adding a second one.
2. **Change only what the task needs.** No drive-by refactors, no options nobody asked for, no handling for cases that cannot happen. Every line added has to be reviewed and maintained.
3. **Fix the cause.** Do not hide a failure with a retry, a longer timeout or a skipped test until you know why it fails.
4. **Prove it runs.** A passing type check says little. Run the code path you changed, as described under [Checking your work](#checking-your-work).
5. **Report honestly.** Say what you verified and what you did not. A test against a mock is not a test against the real thing, and the report must say which one it was.
6. **Stop before anything hard to undo.** Do not push tags, publish releases, rewrite pushed history or delete data unless you were asked to.

## Architecture

Dependencies point one way. Check this before adding an import.

| Layer | May use | Must not use |
| --- | --- | --- |
| `src/shared` | Nothing but itself | Node, Electron, React |
| `src/core` | Node, `src/shared` | Electron, React |
| `src/main` | Electron, `src/core`, `src/shared` | React |
| `src/preload` | The Electron bridge only | Anything else: it runs sandboxed |
| `src/renderer` | React, `src/shared`, types from elsewhere | Node, Electron, runtime code from `src/core` |

- Business logic goes in `src/core` or `src/shared`, where it can be tested without Electron. The interface only displays results and calls the API.
- The interface reaches the system only through `window.chronicle`. Every new call goes through `src/main/api.ts`.
- Repository calls are checked against the list of opened repositories in the main process. Do not add a way around that.

## TypeScript

- Two-space indent, single quotes, no semicolons. Match the surrounding formatting: there is no formatter to do it for you.
- Strict types. No `any`. Keep `as` casts to places where the type really is known from outside, such as parsed JSON.
- Explicit return types on functions, including `: ReactNode` on components.
- Named exports only. Export only what another file uses.
- `async`/`await` rather than `.then` chains, except for fire-and-forget calls in React effects.
- Prefer a plain function to a class. Use a class only for something with real state and a lifetime, such as a server.
- Add a dependency only with a strong reason. Runtime code currently has almost none, and that is on purpose.

## Naming and comments

- Names say what a thing is, in full words: `remoteBranch`, not `rb`.
- A comment explains **why**, or warns about something the code cannot show. Never restate the code, and never describe the history of a change.
- Write comments as plain statements of fact, in English, on the line above the code.
- A doc comment on an exported function is welcome when the name alone leaves a question open.

## Language

| What | Language |
| --- | --- |
| Code, identifiers, comments, tests, commit messages | English |
| Everything a user reads: buttons, errors, hints | Russian |

Text in the interface is plain and specific. It says what happened and what to do next, and it does not blame the user. Translate git's errors into human terms when a cause is recognized, and keep the original message available otherwise.

## Git operations

These rules protect people's repositories. They are not style preferences.

- Run git through `src/core/git.ts`. It fixes the locale so output can be parsed, and routes questions to the app instead of a terminal.
- Pass arguments as an array, never through a shell string. Put `--` before user-controlled values.
- Validate anything from outside before it becomes an argument. A branch name or host starting with `-` would be read as an option.
- Refs change through `moveRefs` and `update-ref --stdin`, with the expected old value, so a change is atomic and fails if the ref moved.
- Keep a backup and a journal entry for every rewrite, so it can be undone. Preview must never move a ref.
- Never rewrite `refs/remotes/*`. Force-pushes always use `--force-with-lease` with an explicit expected value.
- Commit objects are bytes. Do not decode and re-encode them on a path that must keep a SHA.

## Secrets

- Passwords and keys never go on a command line, where other programs can read them, or in a log, a toast or a file in plain text. Use `AskpassServer.oneShot`.
- Every field where a person types a password, a key passphrase, a token or a PIN hides it behind dots (`type="password"`).
- Do not read private key files. Pass their path to ssh.
- On macOS any `safeStorage` call can open a system dialog, and the synchronous calls freeze the whole app while it is open. Use only the asynchronous calls, and only when actually saving or reading a secret. Never call them just to see whether encryption works.
- Never overwrite a user's key, change `~/.ssh/config` or change global git settings. Settings for one repository go in that repository.

## Interface

- Reuse what exists: `Modal`, `Icon`, `useRepo`, `run`, and the classes and color tokens in `styles.css`. Every color has to work in both themes.
- Long operations go through `run`, which shows progress and turns errors into messages.
- A destructive action asks for confirmation and says exactly what will be lost. Say so when it cannot be undone.
- Check a visual change on a screenshot, in both themes.

## Platforms

Everything must work on macOS, Windows and Linux.

- Build paths with `node:path`. Remember that Git for Windows has its own `ssh` and `sh` and may print paths as `C:/x` or `/c/x`.
- Scripts that git or ssh must execute are written to disk at startup, because they cannot run from inside the app archive.
- A packaged app gets a different environment from a dev run. On macOS, an app started from Finder has a minimal `PATH`. Anything that depends on the environment needs checking in a packaged build.

## Tests

- New behavior comes with a test, and a fixed bug comes with a test that would have caught it.
- Test with real git in temporary repositories from `tests/helpers.ts`, not with mocks of git.
- Name a test as a statement of behavior: `'never overwrites an existing key'`.
- Tests must not touch the machine they run on. No real `~/.ssh`, agent, keychain, global git config, clipboard or browser. See how `tests/ssh.test.ts` and `e2e/access.test.ts` isolate these.
- Tests must not depend on the network. Use local servers.
- Do not paper over a flaky test with a sleep. Wait for the condition you actually need.

## Checking your work

Before every commit:

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm test:e2e
```

Also, depending on the change:

- **Interface:** run the app and look at it.
- **Packaging, startup, helper scripts or the environment:** build it with `pnpm dist:mac` or `pnpm dist:win`, and run `node --experimental-strip-types e2e/packaged-smoke.ts` with the path to the built executable.
- **Windows:** CI runs everything on real Windows. A change is not finished until that run passes.
- **Network or keys:** test against a real server where you can. Tests use a mock keychain, so a change around `safeStorage` also needs a real run on macOS.

## Commits

- Write the subject in the imperative, in English, describing what changes: `Find Git's ssh on Windows whatever its folder layout`. Use a body only when the reason is not obvious.
- One logical change per commit, with the tests passing at each one.
- No `Co-Authored-By`, `Generated with` or any other tool or AI attribution, in commits, pull requests or files.
- Never commit build output, secrets, or personal paths and names.
