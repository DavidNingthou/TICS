import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

const RATE_LIMIT_WINDOW = 10000;
const MAX_REQUESTS_PER_USER = 3;
const userRateLimit = new Map();

let exchangeData = {
  mexc: {
    price: null,
    volume: null,
    high: null,
    low: null,
    timestamp: 0,
    connected: false
  },
  lbank: {
    price: null,
    volume: null,
    high: null,
    low: null,
    timestamp: 0,
    connected: false
  }
};

let lbankWs = null;
let mexcPollingInterval = null;

async function safeReply(ctx, message, options = {}) {
  try {
    return await ctx.reply(message, options);
  } catch (error) {
    if (error.description && (
      error.description.includes('Too Many Requests') ||
      error.description.includes('slow mode') ||
      error.description.includes('retry after') ||
      error.code === 429
    )) {
      try {
        await ctx.react('😢');
        return null;
      } catch (reactError) {
        return null;
      }
    }
    throw error;
  }
}

function isRateLimited(userId) {
  const now = Date.now();
  const userLimit = userRateLimit.get(userId);
  
  if (!userLimit || now > userLimit.resetTime) {
    userRateLimit.set(userId, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return false;
  }
  
  if (userLimit.count >= MAX_REQUESTS_PER_USER) {
    return true;
  }
  
  userLimit.count++;
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, limit] of userRateLimit.entries()) {
    if (now > limit.resetTime) {
      userRateLimit.delete(userId);
    }
  }
}, RATE_LIMIT_WINDOW);

async function fetchMexcData() {
  try {
    const response = await fetch('https://www.mexc.co/open/api/v2/market/ticker?symbol=TICS_USDT', {
      timeout: 5000,
      headers: {
        'User-Agent': 'TICS-Bot/3.0'
      }
    });
    
    if (!response.ok) throw new Error(`MEXC API Error: ${response.status}`);
    
    const data = await response.json();
    if (data.code === 200 && data.data[0]) {
      const ticker = data.data[0];
      exchangeData.mexc = {
        price: parseFloat(ticker.last).toFixed(4),
        volume: parseFloat(ticker.volume),
        high: parseFloat(ticker.high).toFixed(4),
        low: parseFloat(ticker.low).toFixed(4),
        timestamp: Date.now(),
        connected: true
      };
    }
  } catch (error) {
    exchangeData.mexc.connected = false;
  }
}

function startMexcPolling() {
  fetchMexcData();
  mexcPollingInterval = setInterval(fetchMexcData, 2000);
}

function connectLBankWebSocket() {
  try {
    lbankWs = new WebSocket('wss://www.lbkex.net/ws/V2/');
    
    lbankWs.on('open', () => {
      console.log('✅ LBank WebSocket connected');
      exchangeData.lbank.connected = true;
      
      const subscribeMsg = {
        action: "subscribe",
        subscribe: "tick",
        pair: "tics_usdt"
      };
      lbankWs.send(JSON.stringify(subscribeMsg));
    });
    
    lbankWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'tick' && message.pair === 'tics_usdt' && message.tick) {
          const tickerData = message.tick;
          exchangeData.lbank = {
            price: parseFloat(tickerData.latest).toFixed(4),
            volume: parseFloat(tickerData.vol),
            high: parseFloat(tickerData.high).toFixed(4),
            low: parseFloat(tickerData.low).toFixed(4),
            timestamp: Date.now(),
            connected: true
          };
        }
      } catch (error) {
      }
    });
    
    lbankWs.on('close', () => {
      exchangeData.lbank.connected = false;
      setTimeout(connectLBankWebSocket, 5000);
    });
    
    lbankWs.on('error', (error) => {
      exchangeData.lbank.connected = false;
    });
    
  } catch (error) {
    setTimeout(connectLBankWebSocket, 5000);
  }
}

async function fetchLBankREST() {
  try {
    const response = await fetch('https://api.lbank.info/v2/ticker.do?symbol=tics_usdt');
    const data = await response.json();
    
    if (data.result === 'true' && data.data[0]) {
      const ticker = data.data[0].ticker;
      return {
        price: parseFloat(ticker.latest).toFixed(4),
        volume: parseFloat(ticker.vol),
        high: parseFloat(ticker.high).toFixed(4),
        low: parseFloat(ticker.low).toFixed(4),
        timestamp: Date.now()
      };
    }
  } catch (error) {
  }
  return null;
}

async function getExchangeData(exchange) {
  const data = exchangeData[exchange];
  const now = Date.now();
  
  if (data.connected && data.price && (now - data.timestamp) < 30000) {
    return data;
  }
  
  if (exchange === 'lbank') {
    const restData = await fetchLBankREST();
    if (restData) {
      exchangeData.lbank = { ...restData, connected: false };
      return exchangeData.lbank;
    }
  }
  
  return null;
}

async function getCombinedData() {
  const mexcData = exchangeData.mexc.price ? exchangeData.mexc : null;
  const lbankData = await getExchangeData('lbank');
  
  if (!mexcData && !lbankData) {
    throw new Error('No data available from either exchange');
  }
  
  if (!mexcData) return { ...lbankData, source: 'LBank only' };
  if (!lbankData) return { ...mexcData, source: 'MEXC only' };
  
  const mexcPrice = parseFloat(mexcData.price);
  const lbankPrice = parseFloat(lbankData.price);
  const mexcVol = mexcData.volume;
  const lbankVol = lbankData.volume;
  
  const totalVolume = mexcVol + lbankVol;
  const weightedPrice = ((mexcPrice * mexcVol) + (lbankPrice * lbankVol)) / totalVolume;
  
  const avgHigh = ((parseFloat(mexcData.high) + parseFloat(lbankData.high)) / 2);
  const avgLow = ((parseFloat(mexcData.low) + parseFloat(lbankData.low)) / 2);
  
  return {
    price: weightedPrice.toFixed(4),
    volume: totalVolume,
    high: avgHigh.toFixed(4),
    low: avgLow.toFixed(4),
    mexcPrice: mexcData.price,
    lbankPrice: lbankData.price,
    mexcVolume: mexcVol,
    lbankVolume: lbankVol,
    mexcHigh: mexcData.high,
    mexcLow: mexcData.low,
    lbankHigh: lbankData.high,
    lbankLow: lbankData.low,
    timestamp: Math.max(mexcData.timestamp, lbankData.timestamp),
    source: 'Combined'
  };
}

bot.telegram.setMyCommands([
  { command: 'price', description: 'Get TICS price from both exchanges' }
]);

bot.start(async (ctx) => {
  await safeReply(ctx, '🎉 *TICS Price Bot Ready!*\n\n📊 Command: /price - Combined data from MEXC + LBank', 
    { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  const helpMessage = `
🤖 *TICS Price Bot*

📊 /price - Combined price from MEXC + LBank
  `.trim();
  
  await safeReply(ctx, helpMessage, { parse_mode: 'Markdown' });
});

bot.command('price', async (ctx) => {
  const userId = ctx.from.id;
  
  if (isRateLimited(userId)) {
    await safeReply(ctx, '⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  
  ctx.sendChatAction('typing').catch(() => {});
  
  try {
    const data = await getCombinedData();
    const now = Date.now();
    const dataAge = Math.floor((now - data.timestamp) / 1000);
    
    const message = `
🚀 *TICS / USDT* (Combined)

💵 **Avg Price:** \`${data.price}\`
📊 **24h Volume:** \`${data.volume.toLocaleString()} TICS\`
🟢 **High:** \`${data.high}\` | 🔴 **Low:** \`${data.low}\`

📈 **Exchange Breakdown:**
🔸 MEXC: \`${data.mexcPrice}\` (${data.mexcVolume.toLocaleString()})
🔹 LBank: \`${data.lbankPrice}\` (${data.lbankVolume.toLocaleString()})
`.trim();
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Trade on MEXC', url: 'https://www.mexc.com/exchange/TICS_USDT' },
          { text: 'Trade on LBank', url: 'https://www.lbank.com/trade/tics_usdt' }
        ]
      ]
    };
    
    await safeReply(ctx, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
      reply_markup: keyboard
    });
    
  } catch (error) {
    await safeReply(ctx, '❌ *Price unavailable*\n\n🔧 Both exchanges temporarily unavailable', { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id 
    });
  }
});

bot.catch(async (err, ctx) => {
  if (ctx.update.message && !err.message.includes('rate')) {
    try {
      await safeReply(ctx, '⚠️ Temporary issue - please retry');
    } catch (replyError) {
    }
  }
});

startMexcPolling();
connectLBankWebSocket();

bot.launch();
console.log('✅ TICS Multi-Exchange Bot running');
console.log('📡 MEXC: Live polling (2s) | LBank: WebSocket');

setInterval(() => {
  console.log(`📊 MEXC: ${exchangeData.mexc.connected ? '✅' : '❌'} | LBank: ${exchangeData.lbank.connected ? '✅' : '❌'}`);
}, 300000);

const shutdown = (signal) => {
  console.log(`🛑 ${signal} received, stopping bot...`);
  
  if (mexcPollingInterval) clearInterval(mexcPollingInterval);
  if (lbankWs) lbankWs.close();
  
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
