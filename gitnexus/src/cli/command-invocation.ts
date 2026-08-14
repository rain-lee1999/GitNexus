const WINDOWS_COMMAND_SCRIPT_ALWAYS_UNSAFE = /[&|<>^%!"\r\n]/;
const WINDOWS_COMMAND_SCRIPT_GROUPING = /[()]/;

const isUnsafeWindowsCommandScriptValue = (value: string): boolean =>
  WINDOWS_COMMAND_SCRIPT_ALWAYS_UNSAFE.test(value) ||
  (WINDOWS_COMMAND_SCRIPT_GROUPING.test(value) && !/[\t ]/.test(value));

export interface SpawnInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve a process invocation without enabling Node's broad `shell: true` mode.
 *
 * Windows command scripts still require cmd.exe. Because `/c` parses command
 * text even when Node receives an argv array, fail closed when the script path
 * or any argument contains cmd.exe metacharacters instead of pretending argv
 * separation alone makes those values literal.
 */
export function resolveSpawnInvocation(
  command: string,
  args: string[],
  platform = process.platform,
  comSpec = process.env.ComSpec,
): SpawnInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  const unsafeValue = [command, ...args].find(isUnsafeWindowsCommandScriptValue);
  if (unsafeValue !== undefined) {
    throw new Error(
      'Windows command-script launch rejected a path or argument containing cmd.exe metacharacters.',
    );
  }

  return {
    command: comSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
}
