const { Telegraf } = require('telegraf');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Replace with your real bot token
const BOT_TOKEN = '8001376703:AAE10T4IV7q6hy8eNl1gyuJWDjgKKAoKYVU';
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply('Welcome! Send /price to get the current TICS stats.'));

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

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });

  } catch (err) {
    console.error("Error fetching price:", err);
    await ctx.reply('❌ Failed to fetch TICS price.', {
      reply_to_message_id: ctx.message.message_id
    });
  }
});

bot.launch();
console.log("✅ TICS bot is running...");
