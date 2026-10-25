// Everyone who has talked to the bot, and the admin-only /users report.

import { db } from 'sdk';
import { desc } from 'sdk/db';
import { users } from '../schema.js';
import { escapeHtml, displayName } from './rps.js';
import { ADMIN_IDS } from './secrets.js';

export { ADMIN_IDS };

export function isAdmin(user) {
  return ADMIN_IDS.includes(user?.id);
}

// Called on every update: registers new users and keeps names fresh.
export async function trackUser(user) {
  if (!user || user.is_bot) return;
  const row = { name: displayName(user), username: user.username ?? null };
  await db.insert(users).values({ userId: user.id, ...row })
    .onConflictDoUpdate({ target: users.userId, set: row }).run();
}

export async function usersText() {
  const total = await db.$count(users);
  const recent = await db.select().from(users).orderBy(desc(users.created), desc(users.userId)).limit(5);
  if (total === 0) return 'Пользователей пока нет.';

  const rows = [
    ['#', 'Имя', 'Username', 'Добавлен (UTC)'],
    ...recent.map((u, i) => [
      String(i + 1),
      clip(u.name, 16),
      u.username ? clip(`@${u.username}`, 18) : '—',
      new Date(u.created * 1000).toISOString().slice(0, 16).replace('T', ' '),
    ]),
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => [...r[c]].length)));
  const line = (r) => r.map((cell, c) => cell + ' '.repeat(widths[c] - [...cell].length)).join(' │ ');
  const table = [line(rows[0]), widths.map((w) => '─'.repeat(w)).join('─┼─'), ...rows.slice(1).map(line)];

  return [
    `👥 <b>Пользователей:</b> ${total}`,
    '',
    `<b>Последние ${recent.length}:</b>`,
    `<pre>${escapeHtml(table.join('\n'))}</pre>`,
  ].join('\n');
}

function clip(s, max) {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}
