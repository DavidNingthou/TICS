import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply('Welcome! Send /price to get TICS stats.'));

bot.command('price', async (ctx) => {
  try {
    const res = await fetch('https://www.mexc.co/open/api/v2/market/ticker?symbol=TICS_USDT');
    const json = await res.json();
    const data = json.data[0];

    const price = parseFloat(data.last).toFixed(4);
    const change = parseFloat(data.change_rate).toFixed(2);
    const volume = parseFloat(data.volume).toLocaleString();

    const message = `
💰 *TICS / USDT*
Price: \`$${price}\`
24h Change: ${change >= 0 ? '📈 +' : '📉 '}${change}%
24h Volume: \`${volume} TICS\`
_Source: MEXC_
    `.trim();

    ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
  } catch (err) {
    ctx.reply('❌ Failed to fetch price.');
    console.error(err);
  }
});

bot.launch();
console.log('✅ TICS Bot running...');
