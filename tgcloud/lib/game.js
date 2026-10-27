// A group game: lobby (join, pick the win target, start), rounds played through
// private messages with the bot, and the 30-second move deadline.
//
// The runtime has no timers, so an overdue round is closed by whatever update
// arrives next: every handler calls sweepExpired() first, and a player who has
// moved gets a "time's up?" button in their private chat for when it's quiet.
//
// The group sees only the lobby and the final result; rounds stay in private.

import { db, api } from 'sdk';
import { eq, and, lt, asc, desc, inArray, isNotNull, sql } from 'sdk/db';
import { games, gamePlayers, players } from '../schema.js';
import {
  MOVES, ROUND_SECONDS, moveLabel, winningMoves,
  escapeHtml, displayName, safeEdit,
} from './rps.js';

export const TARGETS = [1, 2, 3, 5];
const MAX_PLAYERS = 10;
const LOBBY_TTL_SECONDS = 15 * 60;
// Grace on top of ROUND_SECONDS for network lag on the last-second click.
const GRACE_MS = 2000;

export async function getGame(id) {
  return db.select().from(games).where(eq(games.id, id)).get();
}

async function activeGame(chatId) {
  return db.select().from(games)
    .where(and(eq(games.chatId, chatId), inArray(games.status, ['lobby', 'playing'])))
    .get();
}

async function listPlayers(gameId) {
  return db.select().from(gamePlayers)
    .where(eq(gamePlayers.gameId, gameId))
    .orderBy(asc(gamePlayers.joined), asc(gamePlayers.userId));
}

// ---------------------------------------------------------------- lobby

export async function createGame(message) {
  const chatId = message.chat.id;
  const existing = await activeGame(chatId);
  if (existing) {
    const stale = existing.status === 'lobby' && existing.created < Date.now() / 1000 - LOBBY_TTL_SECONDS;
    if (!stale) {
      return api.sendMessage({
        chat_id: chatId,
        text: 'Игра уже идёт. Остановить: /stop',
      });
    }
    await closeGame(existing, '✖️ Игра так и не началась.');
  }

  const [game] = await db.insert(games).values({
    chatId,
    chatTitle: message.chat.title ?? null,
    creatorId: message.from.id,
  }).returning();

  // The creator is in by default — if the bot can write to them privately.
  await joinGame(game, message.from);

  const sent = await api.sendMessage({ chat_id: chatId, parse_mode: 'HTML', ...(await lobbyView(game)) });
  await db.update(games).set({ msgId: sent.message_id }).where(eq(games.id, game.id)).run();
}

// → 'ok' | 'already' | 'closed' | 'full' | 'no_dm'
export async function joinGame(game, user) {
  if (game.status !== 'lobby') return 'closed';
  const ps = await listPlayers(game.id);
  if (ps.some((p) => p.userId === user.id)) return 'already';
  if (ps.length >= MAX_PLAYERS) return 'full';

  // Moves are made in private, so the bot must be able to message the player.
  try {
    await api.sendMessage({
      chat_id: user.id,
      parse_mode: 'HTML',
      text: `✅ Вы в игре${game.chatTitle ? ` «${escapeHtml(game.chatTitle)}»` : ''}.\n`
        + 'Ходить будете здесь.',
    });
  } catch (e) {
    if (e.code === 403 || e.code === 400) return 'no_dm';
    throw e;
  }

  await db.insert(gamePlayers).values({ gameId: game.id, userId: user.id, name: displayName(user) })
    .onConflictDoNothing().run();
  await renderLobby(game);
  return 'ok';
}

export async function leaveGame(game, user) {
  if (game.status !== 'lobby') return 'Игра уже идёт.';
  const res = await db.delete(gamePlayers)
    .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.userId, user.id))).run();
  if (res.rowsAffected === 0) return 'Вы не в игре.';
  await renderLobby(game);
  return 'Вы вышли.';
}

export async function setTarget(game, user, target) {
  if (game.status !== 'lobby') return 'Игра уже идёт.';
  if (game.creatorId !== user.id) return 'Это выбирает создатель игры.';
  if (!TARGETS.includes(target)) return null;
  await db.update(games).set({ target }).where(eq(games.id, game.id)).run();
  await renderLobby({ ...game, target });
  return `Играем до ${target} побед.`;
}

export async function startGame(game, user) {
  if (game.status !== 'lobby') return 'Игра уже идёт.';
  if (game.creatorId !== user.id) return 'Начать может только создатель игры.';
  const count = await db.$count(gamePlayers, eq(gamePlayers.gameId, game.id));
  if (count < 2) return 'Нужно минимум 2 игрока.';

  const res = await db.update(games).set({ status: 'playing' })
    .where(and(eq(games.id, game.id), eq(games.status, 'lobby'))).run();
  if (res.rowsAffected === 0) return 'Игра уже идёт.';

  await safeEdit({ chat_id: game.chatId, message_id: game.msgId, ...(await lobbyView({ ...game, status: 'playing' })) });
  await startRound(game.id, 1);
  return 'Поехали!';
}

// /stop in a group.
export async function stopChatGame(message) {
  const game = await activeGame(message.chat.id);
  const refusal = game
    ? await stopGame(game, message.from.id)
    : 'Игры нет. Начать: /rps';
  if (refusal) await api.sendMessage({ chat_id: message.chat.id, text: refusal });
}

// → null when stopped, otherwise why not.
export async function stopGame(game, userId) {
  if (!(await canManage(game, userId))) return 'Остановить может создатель игры или админ.';
  await closeGame(game, '✖️ Игра остановлена.');
  return null;
}

async function closeGame(game, text) {
  const res = await db.update(games).set({ status: 'cancelled', deadline: null })
    .where(and(eq(games.id, game.id), inArray(games.status, ['lobby', 'playing']))).run();
  if (res.rowsAffected === 0) return;
  if (game.msgId) await safeEdit({ chat_id: game.chatId, message_id: game.msgId, text });
  for (const p of await listPlayers(game.id)) {
    if (p.dmMsgId && !p.move) await safeEdit({ chat_id: p.userId, message_id: p.dmMsgId, text });
  }
}

async function canManage(game, userId) {
  if (game.creatorId === userId) return true;
  try {
    const m = await api.getChatMember({ chat_id: game.chatId, user_id: userId });
    return m.status === 'creator' || m.status === 'administrator';
  } catch {
    return false;
  }
}

async function renderLobby(game) {
  if (!game.msgId) return;
  await safeEdit({ chat_id: game.chatId, message_id: game.msgId, ...(await lobbyView(game)) });
}

async function lobbyView(game) {
  const ps = await listPlayers(game.id);
  const list = ps.length
    ? ps.map((p, i) => `${i + 1}. ${escapeHtml(p.name)}`).join('\n')
    : '<i>пока никого</i>';
  const lines = [
    '🪨✂️📄 <b>Камень, ножницы, бумага</b>',
    `До ${game.target} ${winsWord(game.target)} · ${ROUND_SECONDS} сек на ход`,
    '',
    `<b>Игроки (${ps.length}):</b>`,
    list,
  ];
  if (game.status !== 'lobby') return { text: [...lines, '', '▶️ Игра началась!'].join('\n') };

  lines.push('', 'Жмите «Играть». Ходы — в чате с ботом.');
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🙋 Играть', callback_data: `j:${game.id}` },
          { text: '🚪 Выйти', callback_data: `l:${game.id}` },
        ],
        TARGETS.map((n) => ({
          text: n === game.target ? `✅ до ${n}` : `до ${n}`,
          callback_data: `t:${game.id}:${n}`,
        })),
        [
          { text: '▶️ Старт', callback_data: `s:${game.id}` },
          { text: '✖️ Отмена', callback_data: `c:${game.id}` },
        ],
      ],
    },
  };
}

// ---------------------------------------------------------------- rounds

async function startRound(gameId, round) {
  await db.update(gamePlayers).set({ move: null, dmMsgId: null }).where(eq(gamePlayers.gameId, gameId)).run();
  const deadline = Date.now() + ROUND_SECONDS * 1000 + GRACE_MS;
  const res = await db.update(games).set({ round, deadline })
    .where(and(eq(games.id, gameId), eq(games.status, 'playing'))).run();
  if (res.rowsAffected === 0) return;

  const game = await getGame(gameId);
  const ps = await listPlayers(gameId);

  for (const p of ps) {
    try {
      const dm = await api.sendMessage({
        chat_id: p.userId,
        parse_mode: 'HTML',
        text: `⚔️ <b>Раунд ${round}</b>${game.chatTitle ? ` · ${escapeHtml(game.chatTitle)}` : ''}\n`
          + `Ваш ход! ${ROUND_SECONDS} секунд.`,
        reply_markup: {
          inline_keyboard: [Object.keys(MOVES).map((move) => ({
            text: moveLabel(move),
            callback_data: `m:${gameId}:${round}:${move}`,
          }))],
        },
      });
      await db.update(gamePlayers).set({ dmMsgId: dm.message_id })
        .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, p.userId))).run();
    } catch (e) {
      // Blocked the bot mid-game — they'll simply time out this round.
      console.warn('round DM failed', { userId: p.userId, code: e.code });
    }
  }
}

// Returns the toast for the player.
export async function makeMove(query, gameId, round, move) {
  const game = await getGame(gameId);
  if (!game || game.status !== 'playing' || game.round !== round || game.deadline == null) {
    return 'Раунд уже закончился.';
  }
  if (Date.now() > game.deadline) {
    await resolveRound(gameId, round);
    return '⌛ Время вышло.';
  }

  // Guarded by the round too, so a stale button can't land in the next round.
  const res = await db.run(sql`
    UPDATE game_players SET move = ${move}
    WHERE game_id = ${gameId} AND user_id = ${query.from.id} AND move IS NULL
      AND EXISTS (SELECT 1 FROM games WHERE id = ${gameId} AND round = ${round} AND deadline IS NOT NULL)
  `);
  if (res.rowsAffected === 0) return 'Ход уже сделан.';

  if (query.message) {
    await safeEdit({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: `⚔️ <b>Раунд ${round}</b>\nВы: ${moveLabel(move)}. Ждём других…`,
      reply_markup: {
        inline_keyboard: [[{ text: '⏰ Время вышло?', callback_data: `x:${gameId}` }]],
      },
    });
  }

  const ps = await listPlayers(gameId);
  if (ps.every((p) => p.move)) await resolveRound(gameId, round);
  return `Ваш ход: ${moveLabel(move)}`;
}

export async function checkTimeout(gameId) {
  const game = await getGame(gameId);
  if (!game || game.status !== 'playing' || game.deadline == null) return 'Раунд уже закончился.';
  const left = Math.ceil((game.deadline - GRACE_MS - Date.now()) / 1000);
  if (left > 0) return `Ещё ${left} сек.`;
  await resolveRound(gameId, game.round);
  return 'Раунд завершён.';
}

// Closes every overdue round. Cheap (one indexed query) — called on each update.
export async function sweepExpired() {
  const due = await db.select({ id: games.id, round: games.round }).from(games)
    .where(and(eq(games.status, 'playing'), isNotNull(games.deadline), lt(games.deadline, Date.now())))
    .limit(5);
  for (const g of due) await resolveRound(g.id, g.round);
}

async function resolveRound(gameId, round) {
  // Clearing the deadline is the lock: only one caller gets to score the round.
  const lock = await db.update(games).set({ deadline: null })
    .where(and(eq(games.id, gameId), eq(games.round, round), eq(games.status, 'playing'), isNotNull(games.deadline)))
    .run();
  if (lock.rowsAffected === 0) return;

  const game = await getGame(gameId);
  const ps = await listPlayers(gameId);
  const late = ps.filter((p) => !p.move);
  const movers = ps.filter((p) => p.move);
  const win = winningMoves(movers.map((p) => p.move), late.length > 0);
  const winners = movers.filter((p) => win.has(p.move));

  for (const p of winners) {
    p.score += 1;
    await db.update(gamePlayers).set({ score: p.score })
      .where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.userId, p.userId))).run();
  }

  const winnerNames = winners.map((p) => `<b>${escapeHtml(p.name)}</b>`).join(', ');
  const moveLines = ps.map((p) => `${escapeHtml(p.name)}: ${p.move ? moveLabel(p.move) : '⌛ не успел(а)'}${winners.includes(p) ? ' ⭐' : ''}`);
  const score = `Счёт: ${scoreLine(ps)}`;

  // The result goes to each player's private chat, in place of the move buttons.
  for (const p of ps) {
    if (!p.dmMsgId) continue;
    let verdict;
    if (winners.includes(p)) verdict = '⭐ Очко ваше!';
    else if (winners.length === 0) verdict = '🤝 Ничья';
    else if (!p.move) verdict = `⌛ Вы не успели. Очко: ${winnerNames}`;
    else verdict = `❌ Очко: ${winnerNames}`;
    await safeEdit({
      chat_id: p.userId,
      message_id: p.dmMsgId,
      text: [`⚔️ <b>Раунд ${round}</b>`, '', ...moveLines, '', verdict, score].join('\n'),
    });
  }

  if (movers.length === 0) {
    await db.update(games).set({ status: 'cancelled' }).where(eq(games.id, gameId)).run();
    const text = '💤 Никто не походил — игра остановлена.';
    await api.sendMessage({ chat_id: game.chatId, text });
    for (const p of ps) await sendPrivate(p.userId, text);
    return;
  }

  // The game needs a single leader at the target; a tie at the top plays on.
  const top = Math.max(...ps.map((p) => p.score));
  const leaders = ps.filter((p) => p.score === top);
  if (top >= game.target && leaders.length === 1) {
    await finishGame(game, leaders[0], ps);
  } else {
    await startRound(gameId, round + 1);
  }
}

async function finishGame(game, winner, ps) {
  await db.update(games).set({ status: 'done' }).where(eq(games.id, game.id)).run();
  for (const p of ps) {
    await db.run(sql`
      INSERT INTO players (user_id, name, games, wins)
      VALUES (${p.userId}, ${p.name}, 1, ${p === winner ? 1 : 0})
      ON CONFLICT (user_id) DO UPDATE SET
        name = excluded.name,
        games = games + 1,
        wins = wins + excluded.wins
    `);
  }
  const score = `Счёт: ${scoreLine(ps)}`;
  await api.sendMessage({
    chat_id: game.chatId,
    parse_mode: 'HTML',
    text: [
      `🏆 <b>Победил(а) ${escapeHtml(winner.name)}!</b>`,
      score,
      '',
      'Ещё раз? /rps',
    ].join('\n'),
  });

  for (const p of ps) {
    await sendPrivate(p.userId, [
      p === winner ? '🏆 <b>Вы победили!</b>' : `😔 Победил(а) <b>${escapeHtml(winner.name)}</b>`,
      score,
    ].join('\n'));
  }
}

// A message to a player's private chat; they may have blocked the bot since.
async function sendPrivate(userId, text) {
  try {
    await api.sendMessage({ chat_id: userId, parse_mode: 'HTML', text });
  } catch (e) {
    console.warn('private message failed', { userId, code: e.code });
  }
}

// ---------------------------------------------------------------- stats

export async function statsText(user) {
  const p = await db.select().from(players).where(eq(players.userId, user.id)).get();
  if (!p) return 'Вы ещё не сыграли ни одной игры.';
  return `📊 <b>${escapeHtml(p.name)}</b>\nИгр: ${p.games}\n🏆 Побед: ${p.wins} (${Math.round((p.wins / p.games) * 100)}%)`;
}

export async function topText() {
  const rows = await db.select().from(players).orderBy(desc(players.wins), asc(players.games)).limit(10);
  if (rows.length === 0) return 'Пока никто не играл.';
  const medals = ['🥇', '🥈', '🥉'];
  return [
    '🏆 <b>Лучшие игроки</b>',
    '',
    ...rows.map((p, i) => `${medals[i] ?? `${i + 1}.`} ${escapeHtml(p.name)} — ${p.wins} из ${p.games}`),
  ].join('\n');
}

// ---------------------------------------------------------------- helpers

function scoreLine(ps) {
  return [...ps].sort((a, b) => b.score - a.score)
    .map((p) => `${escapeHtml(p.name)} <b>${p.score}</b>`).join(' · ');
}

function winsWord(n) {
  return n === 1 ? 'победы' : 'побед';
}
