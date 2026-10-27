// handlers/message.js — commands. In a group: /rps (/rpc, /start) opens a game,
// /stop ends it. In private: /start join_<id> (the deep link from "Играть").

import { api } from 'sdk';
import { botUsername } from '../lib/rps.js';
import { ensureCommands } from '../lib/commands.js';
import { trackUser, isAdmin, usersText } from '../lib/users.js';
import { createGame, getGame, joinGame, stopChatGame, sweepExpired, statsText, topText } from '../lib/game.js';

const HELP = [
  '🪨✂️📄 <b>Камень, ножницы, бумага</b>',
  '',
  '1. Добавьте меня в группу.',
  '2. Напишите там /rps.',
  '3. Жмите «Играть», а ходите здесь, в этом чате.',
  '',
  'На ход — 30 секунд.',
  '',
  '/stats — моя статистика',
  '/top — лучшие игроки',
].join('\n');

const NEW_GAME = new Set(['rps', 'rpc', 'start', 'game']);

export default async function (message) {
  // Any activity is a chance to close overdue rounds (there are no timers).
  await sweepExpired().catch((e) => console.error('sweep failed', e));
  await trackUser(message.from).catch((e) => console.error('trackUser failed', e));
  await ensureCommands();

  if (!message.text?.startsWith('/') || !message.from) return;
  const chatId = message.chat.id;
  const isPrivate = message.chat.type === 'private';

  // "/rps@MyBot", "/start @MyBot" and plain "/rps" are ours; "/rps@OtherBot" isn't.
  const [head, ...args] = message.text.trim().split(/\s+/);
  const [command, mention] = head.slice(1).toLowerCase().split('@');
  const me = (await botUsername()).toLowerCase();
  if (mention && mention !== me) return;
  if (args[0]?.startsWith('@')) {
    if (args[0].slice(1).toLowerCase() !== me) return;
    args.shift();
  }

  if (command === 'stats') return send(chatId, await statsText(message.from));
  if (command === 'top') return send(chatId, await topText());

  if (isPrivate) {
    // Admin-only, and only in private so the list never lands in a group.
    if (command === 'users' && isAdmin(message.from)) return send(chatId, await usersText());
    const join = command === 'start' && /^join_(\d+)$/.exec(args[0] ?? '');
    if (join) return joinFromLink(message.from, Number(join[1]));
    return send(chatId, HELP);
  }

  if (NEW_GAME.has(command)) return createGame(message);
  if (command === 'stop') return stopChatGame(message);
}

async function joinFromLink(user, gameId) {
  const game = await getGame(gameId);
  const result = game ? await joinGame(game, user) : 'closed';
  // On 'ok' joinGame has already confirmed in this chat.
  const replies = {
    already: 'Вы уже в игре.',
    closed: 'Эта игра уже идёт или закончилась.',
    full: 'Мест нет.',
  };
  if (replies[result]) await send(user.id, replies[result]);
}

function send(chatId, text) {
  return api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
}
