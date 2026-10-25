// The command menu Telegram shows next to the input field (and on typing "/").

import { api } from 'sdk';
import { ADMIN_IDS } from './users.js';

const GROUP = [
  { command: 'rps', description: '🎮 Начать игру' },
  { command: 'stop', description: '✖️ Остановить игру' },
  { command: 'stats', description: '📊 Моя статистика' },
  { command: 'top', description: '🏆 Лучшие игроки' },
];

const PRIVATE = [
  { command: 'start', description: '❓ Как начать игру' },
  { command: 'stats', description: '📊 Моя статистика' },
  { command: 'top', description: '🏆 Лучшие игроки' },
];

const ADMIN = [...PRIVATE, { command: 'users', description: '👥 Пользователи' }];

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
  for (const id of ADMIN_IDS) {
    await api.setMyCommands({ commands: ADMIN, scope: { type: 'chat', chat_id: id } });
  }
}
