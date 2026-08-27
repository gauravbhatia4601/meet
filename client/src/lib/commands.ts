export interface CommandDef {
  name: string;
  aliases?: string[];
  label: string;
  description: string;
}

/** Commands available in the call command bar. Drives autocomplete + /help. */
export const COMMANDS: CommandDef[] = [
  { name: 'mute', aliases: ['unmute', 'mic'], label: '/mute', description: 'Toggle microphone' },
  { name: 'cam', aliases: ['camera', 'video'], label: '/cam', description: 'Toggle camera' },
  { name: 'share', aliases: ['screen', 'present'], label: '/share', description: 'Toggle screen share' },
  { name: 'hand', aliases: ['raise'], label: '/hand', description: 'Raise hand' },
  { name: 'chat', aliases: ['comms'], label: '/chat', description: 'Toggle chat (mobile)' },
  { name: 'copy', aliases: ['invite', 'link'], label: '/copy', description: 'Copy invite link' },
  { name: 'diag', aliases: ['net'], label: '/diag', description: 'Toggle network diagnostics' },
  { name: 'alias', label: '/alias', description: 'Define a command macro' },
  { name: 'chimes', label: '/chimes', description: 'Toggle join/leave chimes' },
  { name: 'exit', aliases: ['leave', 'quit'], label: '/exit', description: 'Leave the session' },
  { name: 'help', aliases: ['?', 'commands'], label: '/help', description: 'List commands' },
];

/** Find the command definition for a typed input (e.g. "/m" or "/mute"). */
export function matchCommand(input: string): CommandDef | null {
  const lower = input.trim().toLowerCase();
  const body = lower.startsWith('/') ? lower.slice(1) : lower;
  const [action] = body.split(/\s+/);
  if (!action) return null;
  return COMMANDS.find((c) => c.name === action || c.aliases?.includes(action)) ?? null;
}

/** Suggestions for the autocomplete dropdown, filtered by the typed prefix. */
export function suggestCommands(query: string): CommandDef[] {
  const q = query.toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)),
  );
}