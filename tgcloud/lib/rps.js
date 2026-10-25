// Game rules and small Telegram helpers shared by the handlers.

import { api } from 'sdk';

export const MOVES = {
  rock:     { emoji: '🪨', name: 'Камень' },
  scissors: { emoji: '✂️', name: 'Ножницы' },
  paper:    { emoji: '📄', name: 'Бумага' },
};

const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

export const ROUND_SECONDS = 30;

export function isMove(move) {
  return Object.hasOwn(MOVES, move);
}

export function moveLabel(move) {
  return `${MOVES[move].emoji} ${MOVES[move].name}`;
}

// Who takes the round, given the moves of those who picked in time.
// With exactly two kinds of moves on the table, everyone holding the stronger one
// wins. With one kind, its holders win only if someone timed out (they beat the
// no-shows). Three kinds, or one kind with nobody missing, is a draw.
// Returns the set of winning moves.
export function winningMoves(moves, someoneTimedOut) {
  const kinds = [...new Set(moves)];
  if (kinds.length === 1) return someoneTimedOut ? new Set(kinds) : new Set();
  if (kinds.length === 2) {
    const [a, b] = kinds;
    return new Set([BEATS[a] === b ? a : b]);
  }
  return new Set();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `id${user.id}`;
}

let username;
export async function botUsername() {
  username ??= (await api.getMe()).username;
  return username;
}

export async function botLink(start) {
  const base = `https://t.me/${await botUsername()}`;
  return start ? `${base}?start=${start}` : base;
}

// editMessageText that tolerates "message is not modified" / "message to edit not found".
export async function safeEdit(params) {
  try {
    await api.editMessageText({ parse_mode: 'HTML', ...params });
  } catch (e) {
    if (e.code !== 400) throw e;
  }
}
