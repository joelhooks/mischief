import { HostShell } from "@rat-king/alchemy-nest";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Schema } from "effect";

export const credentialScript = String.raw`
import json, os, pathlib, stat, subprocess, sys
def private(path):
    return not any(part.is_symlink() for part in [path, *path.parents])
try:
    action, directory, name = sys.argv[1:4]
    directory = pathlib.Path(directory)
    binding = directory/'bindings'
    if not directory.is_absolute():
        raise ValueError()
    if action == 'observe':
        if not directory.exists() or not binding.exists():
            print('missing')
            sys.exit(0)
        if not private(binding):
            raise ValueError()
        ready = (stat.S_IMODE(directory.stat().st_mode) == 0o700 and
                 stat.S_IMODE(binding.stat().st_mode) == 0o600 and
                 set(json.loads(binding.read_text())) == {'MISCHIEF_CREDENTIAL'})
        print('ready' if ready else 'missing')
        sys.exit(0)
    if action != 'apply':
        raise ValueError()
    leased = subprocess.run(['secrets', '--no-update-check', 'lease', name, '--ttl', '15m',
                             '--client-id', 'mischief-celld'],
                            check=True, capture_output=True, text=True).stdout.strip()
    if len(leased) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in leased):
        raise ValueError()
    directory.mkdir(mode=0o700, exist_ok=True)
    if not private(directory) or not directory.is_dir():
        raise ValueError()
    directory.chmod(0o700)
    pending = directory/'bindings.pending'
    if pending.exists():
        pending.unlink()
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(json.dumps({'MISCHIEF_CREDENTIAL': leased}))
    os.replace(pending, binding)
    print('ready')
except Exception:
    print('Credential binding refused; values redacted', file=sys.stderr)
    sys.exit(1)
`;

export const CredentialBindingsSchema = Schema.Struct({
  directory: Schema.String.check(Schema.isPattern(/^\/[^\0]*[^/]$/u)),
  ready: Schema.String,
  secretName: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/u)),
});

export type CredentialBindingsProps = typeof CredentialBindingsSchema.Type;

export interface CredentialBindingsAttributes {
  readonly bindings: string;
  readonly directory: string;
  readonly secretName: string;
}

export type CredentialBindingsResource = Resource<
  "Mischief.CredentialBindings",
  CredentialBindingsProps,
  CredentialBindingsAttributes
>;

export const CredentialBindings = Resource<CredentialBindingsResource>(
  "Mischief.CredentialBindings"
);

const outputFor = (
  props: CredentialBindingsProps
): CredentialBindingsAttributes => ({
  bindings: `${props.directory}/bindings`,
  directory: props.directory,
  secretName: props.secretName,
});

const absent = undefined;

const refused = (reason: string) =>
  Effect.die(new Error(`Mischief credential bindings: ${reason}`));

export const CredentialBindingsProvider = () =>
  Provider.effect(
    CredentialBindings,
    Effect.gen(function* provider() {
      const shell = yield* HostShell;

      const validate = (props: CredentialBindingsProps) =>
        Schema.decodeUnknownEffect(CredentialBindingsSchema)(props).pipe(
          Effect.catchCause(() =>
            refused(
              "directory must be an absolute path and secretName a lower-case agent-secrets name"
            )
          )
        );

      const run = (
        action: "apply" | "observe",
        props: Pick<CredentialBindingsProps, "directory" | "secretName">
      ) =>
        shell
          .exec([
            "python3",
            "-c",
            credentialScript,
            action,
            props.directory,
            props.secretName,
          ])
          .pipe(
            Effect.flatMap((result) =>
              result.code === 0
                ? Effect.succeed(result.stdout.trim())
                : refused(
                    `the host refused to ${action} the bindings. Check that agent-secrets on the host holds ${props.secretName} (at least 32 printable characters) and that ${props.directory} is a private directory, not a symlink`
                  )
            )
          );

      const owned = (directory: string) =>
        shell.purgeRoots.some((root) => directory.startsWith(`${root}/`));

      return CredentialBindings.Provider.of({
        delete: Effect.fn("CredentialBindings.delete")(function* remove({
          output,
        }) {
          if (!owned(output.directory)) {
            return yield* refused(
              "the bindings directory is outside every purge root the shell owns"
            );
          }

          if ((yield* shell.stat(output.bindings)) !== undefined) {
            yield* shell.remove(output.bindings);
          }

          if ((yield* shell.stat(output.directory)) !== undefined) {
            yield* shell.rmdir(output.directory);
          }

          return yield* Effect.void;
        }),
        diff: Effect.fn("CredentialBindings.diff")(function* diff({
          news,
          output,
        }) {
          if (!isResolved(news) || output === undefined) {
            return absent;
          }

          yield* validate(news);

          if (output.directory !== news.directory) {
            return { action: "replace" } as const;
          }

          return {
            action:
              output.secretName === news.secretName &&
              (yield* run("observe", news)) === "ready"
                ? "noop"
                : "update",
          } as const;
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("CredentialBindings.read")(function* read({ output }) {
          if (output === undefined) {
            return absent;
          }

          return (yield* run("observe", output)) === "ready"
            ? output
            : undefined;
        }),
        reconcile: Effect.fn("CredentialBindings.reconcile")(
          function* reconcile({ news }) {
            yield* validate(news);

            if (!owned(news.directory)) {
              return yield* refused(
                "the bindings directory is outside every purge root the shell owns"
              );
            }

            if ((yield* run("apply", news)) !== "ready") {
              return yield* refused("the bindings failed readback");
            }

            return outputFor(news);
          }
        ),
      });
    })
  );
