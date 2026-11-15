// Navigation and event creation use buttons. Keep only essential support commands
// in Telegram's command list; legacy command handlers remain available.
export const botCommands = [
  { command: 'start', description: 'Open XEvents' },
  { command: 'refresh', description: 'Refresh upload and delivery status' },
  { command: 'help', description: 'Help with XEvents' },
  { command: 'cancel', description: 'Stop current input' },
  { command: 'paysupport', description: 'Payment support and refunds' }
];
export const botCommandsVersion = 'start-refresh-navigation-v2';
