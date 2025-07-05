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

// New function to fetch wallet data
async function fetchWalletData(walletAddress) {
  try {
    const response = await fetch(`https://presale-api.qubetics.com/v1/projects/qubetics/wallet/${walletAddress}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'TICS-Bot/3.0'
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('WALLET_NOT_FOUND');
      }
      throw new Error(`API Error: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    if (error.message === 'WALLET_NOT_FOUND') {
      throw error;
    }
    throw new Error('Failed to fetch wallet data');
  }
}

// Helper function to validate wallet address
function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Helper function to format large numbers
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(2) + 'K';
  }
  return num.toFixed(2);
}

bot.telegram.setMyCommands([
  { command: 'price', description: 'Get TICS price from both exchanges' },
  { command: 'check', description: 'Check TICS portfolio (usage: /check wallet_address)' }
]);

bot.start(async (ctx) => {
  await safeReply(ctx, '🎉 *TICS Price Bot Ready!*\n\n📊 Commands:\n/price - Combined data from MEXC + LBank\n/check - Portfolio tracker (usage: /check wallet_address)', 
    { parse_mode: 'Markdown' });
});

bot.command(['help', `help@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  const helpMessage = `
🤖 *TICS Price Bot*

📊 /price - Combined price from MEXC + LBank
💼 /check - Portfolio tracker
   Usage: \`/check 0x...\`
  `.trim();
  
  await safeReply(ctx, helpMessage, { parse_mode: 'Markdown' });
});

// Handle both /price and /price@botusername
bot.command(['price', `price@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
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

// New portfolio check command
// Handle both /check and /check@botusername
bot.command(['check', `check@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  const userId = ctx.from.id;
  
  // Check if command is used in a group
  if (ctx.chat.type !== 'private') {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '💬 Use in DM', url: `https://t.me/${ctx.botInfo.username}` }
        ]
      ]
    };
    
    await safeReply(ctx, '🔒Please use this command in DM.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
      reply_markup: keyboard
    });
    return;
  }
  
  if (isRateLimited(userId)) {
    await safeReply(ctx, '⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  
  const input = ctx.message.text.split(' ');
  
  if (input.length < 2) {
    await safeReply(ctx, '❌ *Invalid usage*\n\nPlease provide a wallet address:\n`/check 0x...`', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  
  const walletAddress = input[1].trim();
  
  if (!isValidWalletAddress(walletAddress)) {
    await safeReply(ctx, '❌ *Invalid wallet address*\n\nPlease provide a valid Ethereum wallet address (0x...)', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  
  ctx.sendChatAction('typing').catch(() => {});
  
  try {
    // Fetch wallet data and current price concurrently
    const [walletData, priceData] = await Promise.all([
      fetchWalletData(walletAddress),
      getCombinedData().catch(() => exchangeData.mexc.price ? exchangeData.mexc : null)
    ]);
    
    if (!priceData || !priceData.price) {
      await safeReply(ctx, '❌ *Price data unavailable*\n\nCannot calculate portfolio value - price feeds are down', {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id
      });
      return;
    }
    
    const totalTokens = parseFloat(walletData.total_tokens);
    const currentPrice = parseFloat(priceData.price);
    const portfolioValue = totalTokens * currentPrice;
    
    const shortWalletAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    const shortReceivingAddress = walletData.claim_wallet_address ? 
      `${walletData.claim_wallet_address.slice(0, 6)}...${walletData.claim_wallet_address.slice(-4)}` : 
      'Not set';
    
    const message = `
💼 *TICS Portfolio*

👤 **Wallet:** \`${shortWalletAddress}\`
🪙 **Total TICS:** \`${formatNumber(totalTokens)} TICS\`
💰 **Portfolio Value:** \`$${portfolioValue.toFixed(2)} USDT\`

📊 **Current Price:** \`$${currentPrice}\`
${priceData.source ? `📈 **Source:** ${priceData.source}` : ''}

🎯 **Receiving Address:** \`${shortReceivingAddress}\`
`.trim();
    
    await safeReply(ctx, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    
  } catch (error) {
    if (error.message === 'WALLET_NOT_FOUND') {
      await safeReply(ctx, '❌ *Wallet not found*\n\nThis wallet address has no TICS holdings or doesn\'t exist in the system.', {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id
      });
    } else {
      await safeReply(ctx, '❌ *Portfolio check failed*\n\nUnable to fetch wallet data. Please try again later.', {
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id
      });
    }
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
console.log('💼 Portfolio tracker: /check wallet_address');

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
