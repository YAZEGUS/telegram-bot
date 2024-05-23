require('dotenv').config();
const { Bot, GrammyError, HttpError, InlineKeyboard, session } = require('grammy');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { logger } = require('./utils/logger');
const { updateUserData, recordUserInteraction } = require('./utils/helpers');
const bot = new Bot(process.env.BOT_API_KEY);
let suggestionClicked = {};
const fs = require('fs');

bot.use(session({
  initial: () => ({})
}));

async function createTables(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    timesStarted INTEGER DEFAULT 0,
    lastSeen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    interactionTime TIMESTAMP
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS blocked_users (
    id INTEGER PRIMARY KEY
  )`);

  logger.info('Tables created or already exist');
}

async function blockUser(db, userId) {
  await db.run('INSERT INTO blocked_users (id) VALUES (?)', userId);
}

async function isUserBlocked(db, userId) {
  const user = await db.get('SELECT * FROM blocked_users WHERE id = ?', userId);
  return user !== undefined;
}

let db;
(async () => {
  const dbPath = './userData.db';

  const dbExists = fs.existsSync(dbPath);

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  if (!dbExists) {
    await createTables(db);
  }

  logger.info('Database initialized and connection established');
})();

bot.command('start', async (ctx) => {
  logger.info(`User ${ctx.from.id} started the bot`);
  await updateUserData(db, ctx.from.id);
  await ctx.reply(`Привет, ${ctx.from.first_name}! 👋\nЯ бот предложка СКР. Я могу помочь вам отправить сообщение, фото или видео администратору.`);
  
  // Устанавливаем suggestionClicked в true
  suggestionClicked[ctx.from.id] = true;
});

let userMessages = {};

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const userLink = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.first_name}`;
  if (await isUserBlocked(db, userId)) {
    // Если пользователь заблокирован, просто игнорируем его сообщения
    return;
  }

  if (suggestionClicked[ctx.from.id]) {
    const adminId = process.env.ADMIN_ID; // ID администратора

    // Создаем клавиатуру с кнопками "Принять", "Отклонить" и "Блокировать"
    const keyboard = new InlineKeyboard()
      .text('Принять ✅', `accept:${userId}:${ctx.message.message_id}`)
      .text('Отклонить ❌', `reject:${userId}:${ctx.message.message_id}`)
      .text('Блокировать 🚫', `block:${userId}:${ctx.message.message_id}`);

    // Сохраняем сообщение пользователя
    userMessages[`${userId}:${ctx.message.message_id}`] = ctx.message;

    if(ctx.message.text){
      let text = `${ctx.message.text}\nСообщение от пользователя: ${userLink}`;
      await bot.api.sendMessage(adminId, text, {
        reply_markup: keyboard,
        parse_mode: 'HTML'
      });
    } else if(ctx.message.video){
      let caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
      await bot.api.sendVideo(adminId, ctx.message.video.file_id, {
        caption: `Видео от пользователя ${userLink}${caption}`,
        reply_markup: keyboard
      })
    } else if(ctx.message.photo){
      let caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
      await bot.api.sendPhoto(adminId, ctx.message.photo[0].file_id, {
        caption: `Фото от пользователя ${userLink}${caption}`,
        reply_markup: keyboard
      })
    }

    await ctx.reply('Ваше сообщение было отправлено администратору.');
  }
});

bot.callbackQuery(/^accept:(\d+):(\d+)$/, async (ctx) => {
  // Отправляем сообщение в канал
  const channelId = process.env.CHANNEL_ID; // ID канала
  const userId = parseInt(ctx.match[1]);
  const messageId = parseInt(ctx.match[2]);

  // Получаем сохраненное сообщение пользователя
  const userMessage = userMessages[`${userId}:${messageId}`];

  let caption = '\n\n<a href="https://t.me/your_suggestion_bot">Ссылка на предложку</a>\n<a href="https://t.me/your_chat">Ссылка на чат</a>'; // Замените URL на реальные ссылки

  if(userMessage.text){
    let text = `${userMessage.text}${caption}`;
    await bot.api.sendMessage(channelId, text, { 
      parse_mode: 'HTML' 
    });
  } else if(userMessage.video){
    let videoCaption = userMessage.caption ? `${userMessage.caption}${caption}` : caption;
    await bot.api.sendVideo(channelId, userMessage.video.file_id, {
      caption: videoCaption,
      parse_mode: 'HTML'
    })
  } else if(userMessage.photo){
    let photoCaption = userMessage.caption ? `${userMessage.caption}${caption}` : caption;
    await bot.api.sendPhoto(channelId, userMessage.photo[0].file_id, {
      caption: photoCaption,
      parse_mode: 'HTML'
    })
  }

  // Уведомляем администратора
  await ctx.answerCallbackQuery({ text: 'Сообщение принято и отправлено в канал.' });

  // Удаляем сохраненное сообщение пользователя
  delete userMessages[`${userId}:${messageId}`];
})

bot.callbackQuery(/^reject:(\d+):(\d+)$/, async (ctx) => {
  // Уведомляем администратора
  await ctx.answerCallbackQuery({ text: 'Сообщение отклонено.' });

  // Удаляем сообщение бота из чата
  await bot.api.deleteMessage(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id);
});

bot.callbackQuery(/^block:(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  await blockUser(db, userId);
  await ctx.answerCallbackQuery({ text: 'Пользователь заблокирован.' });
});

bot.start();
