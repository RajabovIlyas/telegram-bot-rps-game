// The command menu Telegram shows next to the input field (and on typing "/").

import { api } from 'sdk';
import { ADMIN_IDS } from './users.js';

const GROUP = [
  { command: 'rps', description: '🎮 Начать игру' },
  { command: 'start', description: '🎮 Начать игру' },
  { command: 'stop', description: '✖️ Остановить игру' },
  { command: 'stats', description: '📊 Моя статистика' },
  { command: 'top', description: '🏆 Лучшие игроки' },
];

const PRIVATE = [
  { command: 'start', description: '❓ Как играть' },
  { command: 'stats', description: '📊 Моя статистика' },
  { command: 'top', description: '🏆 Лучшие игроки' },
];

// The runtime has no deploy hook, so the menu is (re)set once per isolate,
// on the first update it handles.
let done;
export function ensureCommands() {
  done ??= setCommands().catch((e) => {
    done = undefined;
    console.error('setMyCommands failed', e);
  });
  return done;
}

async function setCommands() {
  await api.setMyCommands({ commands: GROUP, scope: { type: 'all_group_chats' } });
  await api.setMyCommands({ commands: PRIVATE, scope: { type: 'all_private_chats' } });
  // /users stays out of the menu (it still works when typed). Admins used to get
  // a per-chat menu with it, which would override the one above — clear it.
  for (const id of ADMIN_IDS) {
    await api.deleteMyCommands({ scope: { type: 'chat', chat_id: id } });
  }
}
