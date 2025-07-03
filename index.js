import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const MAX_REQUESTS_PER_USER = 3; // Max 3 requests per 10 seconds per user
const userRateLimit = new Map();

// Data storage for both exchanges
let exchangeData = {
  mexc: {
    price: null,
    volume: null,
    change: null,
    timestamp: 0,
    connected: false
  },
  lbank: {
    price: null,
    volume: null,
    change: null,
    timestamp: 0,
    connected: false
  }
};

// WebSocket connections
let lbankWs = null;

// MEXC REST polling (more reliable than their WebSocket for ticker data)
let mexcPollingInterval = null;

// Helper function to safely send reply with slow mode handling
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

// Rate limiting function
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

// Cleanup old rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [userId, limit] of userRateLimit.entries()) {
    if (now > limit.resetTime) {
      userRateLimit.delete(userId);
    }
  }
}, RATE_LIMIT_WINDOW);

// MEXC REST API polling
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
        change: parseFloat(ticker.change_rate * 100).toFixed(2), // Convert to percentage
        timestamp: Date.now(),
        connected: true
      };
    }
  } catch (error) {
    exchangeData.mexc.connected = false;
  }
}

// Start MEXC polling (every 2 seconds for more real-time feel)
function startMexcPolling() {
  fetchMexcData(); // Initial fetch
  mexcPollingInterval = setInterval(fetchMexcData, 2000); // Poll every 2 seconds
}

// LBank WebSocket Connection
function connectLBankWebSocket() {
  try {
    lbankWs = new WebSocket('wss://www.lbkex.net/ws/V2/');
    
    lbankWs.on('open', () => {
      console.log('✅ LBank WebSocket connected');
      exchangeData.lbank.connected = true;
      
      // Subscribe to TICS_USDT ticker
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
        
        // Handle ticker data
        if (message.type === 'tick' && message.pair === 'tics_usdt' && message.tick) {
          const tickerData = message.tick;
          exchangeData.lbank = {
            price: parseFloat(tickerData.latest).toFixed(4),
            volume: parseFloat(tickerData.vol),
            change: parseFloat(tickerData.change).toFixed(2),
            timestamp: Date.now(),
            connected: true
          };
        }
      } catch (error) {
        // Silent error handling
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

// Fallback REST API function for LBank
async function fetchLBankREST() {
  try {
    const response = await fetch('https://api.lbank.info/v2/ticker.do?symbol=tics_usdt');
    const data = await response.json();
    
    if (data.result === 'true' && data.data[0]) {
      const ticker = data.data[0].ticker;
      return {
        price: parseFloat(ticker.latest).toFixed(4),
        volume: parseFloat(ticker.vol),
        change: parseFloat(ticker.change).toFixed(2),
        timestamp: Date.now()
      };
    }
  } catch (error) {
    // Silent error handling
  }
  return null;
}

// Get fresh data with fallback
async function getExchangeData(exchange) {
  const data = exchangeData[exchange];
  const now = Date.now();
  
  // If data is fresh (less than 30 seconds old), use it
  if (data.connected && data.price && (now - data.timestamp) < 30000) {
    return data;
  }
  
  // Otherwise, fall back to REST API (only for LBank)
  if (exchange === 'lbank') {
    const restData = await fetchLBankREST();
    if (restData) {
      exchangeData.lbank = { ...restData, connected: false };
      return exchangeData.lbank;
    }
  }
  
  return null;
}

// Calculate combined price data
async function getCombinedData() {
  // MEXC uses polling, so just get current data
  const mexcData = exchangeData.mexc.price ? exchangeData.mexc : null;
  const lbankData = await getExchangeData('lbank');
  
  if (!mexcData && !lbankData) {
    throw new Error('No data available from either exchange');
  }
  
  if (!mexcData) return { ...lbankData, source: 'LBank only' };
  if (!lbankData) return { ...mexcData, source: 'MEXC only' };
  
  // Calculate volume-weighted average price
  const mexcPrice = parseFloat(mexcData.price);
  const lbankPrice = parseFloat(lbankData.price);
  const mexcVol = mexcData.volume;
  const lbankVol = lbankData.volume;
  
  const totalVolume = mexcVol + lbankVol;
  const weightedPrice = ((mexcPrice * mexcVol) + (lbankPrice * lbankVol)) / totalVolume;
  
  // Calculate average change
  const avgChange = ((parseFloat(mexcData.change) + parseFloat(lbankData.change)) / 2);
  
  return {
    price: weightedPrice.toFixed(4),
    volume: totalVolume,
    change: avgChange.toFixed(2),
    mexcPrice: mexcData.price,
    lbankPrice: lbankData.price,
    mexcVolume: mexcVol,
    lbankVolume: lbankVol,
    timestamp: Math.max(mexcData.timestamp, lbankData.timestamp),
    source: 'Combined'
  };
}

// Commands setup
bot.telegram.setMyCommands([
  { command: 'price', description: 'Get combined TICS price from both exchanges' },
  { command: 'mexc', description: 'Get TICS price from MEXC only' },
  { command: 'lbank', description: 'Get TICS price from LBank only' }
]);

bot.start(async (ctx) => {
  await safeReply(ctx, '🎉 *TICS Price Bot Ready!*\n\n📊 Commands:\n/price - Combined data from both exchanges\n/mexc - MEXC only\n/lbank - LBank only', 
    { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  const helpMessage = `
🤖 *TICS Prics Bot Commands:*

📊 /price - Combined price from MEXC + LBank
🔸 /mexc - MEXC exchange data only  
🔹 /lbank - LBank exchange data only
❓ /help - This message

  `.trim();
  
  await safeReply(ctx, helpMessage, { parse_mode: 'Markdown' });
});

// Combined price command
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
${data.change >= 0 ? '🟢' : '🔴'} **Avg Change:** ${data.change >= 0 ? '+' : ''}${data.change}%
📊 **Total Volume:** \`${data.volume.toLocaleString()} TICS\`

📈 **Exchange Breakdown:**
🔸 MEXC: \`${data.mexcPrice}\` (${data.mexcVolume.toLocaleString()})
🔹 LBank: \`${data.lbankPrice}\` (${data.lbankVolume.toLocaleString()})

⚡ _Live + ${exchangeData.lbank.connected ? 'Live' : 'REST'}_ ${dataAge > 0 ? `• ${dataAge}s ago` : ''}
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

// MEXC-only command
bot.command('mexc', async (ctx) => {
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
    const data = exchangeData.mexc;
    if (!data.price) throw new Error('MEXC data unavailable');
    
    const dataAge = Math.floor((Date.now() - data.timestamp) / 1000);
    
    const message = `
🔸 *MEXC - TICS/USDT*

💵 **Price:** \`${data.price}\`
${data.change >= 0 ? '🟢' : '🔴'} **Change:** ${data.change >= 0 ? '+' : ''}${data.change}%
📊 **Volume:** \`${data.volume.toLocaleString()} TICS\`

⚡ _Live Data (2s)_ ${dataAge > 0 ? `• ${dataAge}s ago` : ''}
    `.trim();
    
    const keyboard = {
      inline_keyboard: [[
        { text: 'Trade on MEXC', url: 'https://www.mexc.com/exchange/TICS_USDT' }
      ]]
    };
    
    await safeReply(ctx, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
      reply_markup: keyboard
    });
    
  } catch (error) {
    await safeReply(ctx, '❌ *MEXC data unavailable*\n\n🔧 Try again in a moment', { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id 
    });
  }
});

// LBank-only command
bot.command('lbank', async (ctx) => {
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
    const data = await getExchangeData('lbank');
    if (!data) throw new Error('LBank data unavailable');
    
    const dataAge = Math.floor((Date.now() - data.timestamp) / 1000);
    
    const message = `
🔹 *LBank - TICS/USDT*

💵 **Price:** \`${data.price}\`
${data.change >= 0 ? '🟢' : '🔴'} **Change:** ${data.change >= 0 ? '+' : ''}${data.change}%
📊 **Volume:** \`${data.volume.toLocaleString()} TICS\`

⚡ _${exchangeData.lbank.connected ? 'Live WebSocket' : 'REST API'}_ ${dataAge > 0 ? `• ${dataAge}s ago` : ''}
    `.trim();
    
    const keyboard = {
      inline_keyboard: [[
        { text: 'Trade on LBank', url: 'https://www.lbank.com/trade/tics_usdt' }
      ]]
    };
    
    await safeReply(ctx, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
      reply_markup: keyboard
    });
    
  } catch (error) {
    await safeReply(ctx, '❌ *LBank data unavailable*\n\n🔧 Try again in a moment', { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id 
    });
  }
});

// Enhanced error handling
bot.catch(async (err, ctx) => {
  if (ctx.update.message && !err.message.includes('rate')) {
    try {
      await safeReply(ctx, '⚠️ Temporary issue - please retry');
    } catch (replyError) {
      // Silent error handling
    }
  }
});

// Initialize connections
startMexcPolling();
connectLBankWebSocket();

// Start the bot
bot.launch();
console.log('✅ TICS Multi-Exchange Bot running');
console.log('📡 MEXC: Live polling (2s) | LBank: WebSocket');

// Health check (reduced frequency)
setInterval(() => {
  console.log(`📊 MEXC: ${exchangeData.mexc.connected ? '✅' : '❌'} | LBank: ${exchangeData.lbank.connected ? '✅' : '❌'}`);
}, 300000); // Every 5 minutes

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`🛑 ${signal} received, stopping bot...`);
  
  if (mexcPollingInterval) clearInterval(mexcPollingInterval);
  if (lbankWs) lbankWs.close();
  
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
