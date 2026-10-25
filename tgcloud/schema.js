import { table, integer, text, index, primaryKey, sql } from 'sdk/db';

// A game in a group chat: lobby → playing → done | cancelled.
export const games = table('games', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  chatId:    integer('chat_id').notNull(),
  chatTitle: text('chat_title'),
  creatorId: integer('creator_id').notNull(),
  target:    integer('target').notNull().default(3),   // wins needed to take the game
  status:    text('status').notNull().default('lobby'),
  round:     integer('round').notNull().default(0),
  // Unix ms when the current round's moves are due; NULL while no round is open.
  deadline:  integer('deadline'),
  // The group message the game is shown in (the lobby, then the current round).
  msgId:     integer('msg_id'),
  created:   integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  chatIdx:     index('idx_games_chat_status').on(t.chatId, t.status),
  deadlineIdx: index('idx_games_status_deadline').on(t.status, t.deadline),
}));

// A participant of a game; `move` is the current round's pick (NULL = not yet).
export const gamePlayers = table('game_players', {
  gameId:  integer('game_id').notNull(),
  userId:  integer('user_id').notNull(),
  name:    text('name').notNull(),
  score:   integer('score').notNull().default(0),
  move:    text('move'),
  dmMsgId: integer('dm_msg_id'),   // the private message with this round's move buttons
  joined:  integer('joined_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  pk: primaryKey({ columns: [t.gameId, t.userId] }),
}));

// Lifetime stats per user.
export const players = table('players', {
  userId: integer('user_id').primaryKey(),
  name:   text('name').notNull(),
  games:  integer('games').notNull().default(0),
  wins:   integer('wins').notNull().default(0),
});

// Everyone who has interacted with the bot (for the admin /users report).
export const users = table('users', {
  userId:   integer('user_id').primaryKey(),
  name:     text('name').notNull(),
  username: text('username'),
  created:  integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  createdIdx: index('idx_users_created').on(t.created),
}));
