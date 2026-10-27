// handlers/callback_query.js — buttons. Callback data:
//   j:<game> join · l:<game> leave · t:<game>:<n> win target · s:<game> start
//   c:<game> cancel · x:<game> close an overdue round · m:<game>:<round>:<move> a move

import { api } from 'sdk';
import { isMove, botLink } from '../lib/rps.js';
import { trackUser } from '../lib/users.js';
import {
  getGame, joinGame, leaveGame, setTarget, startGame, stopGame,
  makeMove, checkTimeout, sweepExpired,
} from '../lib/game.js';

const JOIN_REPLIES = {
  ok: 'Вы в игре!',
  already: 'Вы уже в игре.',
  closed: 'Игра уже идёт.',
  full: 'Мест нет.',
};

export default async function (query) {
  await sweepExpired().catch((e) => console.error('sweep failed', e));
  await trackUser(query.from).catch((e) => console.error('trackUser failed', e));

  const [kind, id, a, b] = (query.data ?? '').split(':');
  const game = await getGame(Number(id));
  const answer = { callback_query_id: query.id };

  if (!game) {
    answer.text = 'Игра не найдена.';
  } else if (kind === 'j') {
    const result = await joinGame(game, query.from);
    // The bot can't message someone who never opened it: send them to it, with
    // a deep link that joins the game on /start.
    if (result === 'no_dm') answer.url = await botLink(`join_${game.id}`);
    else answer.text = JOIN_REPLIES[result];
  } else if (kind === 'l') {
    answer.text = await leaveGame(game, query.from);
  } else if (kind === 't') {
    answer.text = await setTarget(game, query.from, Number(a));
  } else if (kind === 's') {
    answer.text = await startGame(game, query.from);
  } else if (kind === 'c') {
    answer.text = (await stopGame(game, query.from.id)) ?? 'Игра остановлена.';
  } else if (kind === 'x') {
    answer.text = await checkTimeout(game.id);
  } else if (kind === 'm' && isMove(b)) {
    answer.text = await makeMove(query, game.id, Number(a), b);
  }

  if (answer.text == null) delete answer.text;
  await api.answerCallbackQuery(answer);
}
