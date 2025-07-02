import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// Cache configuration
const CACHE_DURATION = 5000; // 5 seconds cache duration
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const MAX_REQUESTS_PER_USER = 3; // Max 3 requests per 10 seconds per user

// Cache and rate limiting
let priceCache = {
  data: null,
  timestamp: 0,
  isLoading: false
};
let pendingRequests = [];
const userRateLimit = new Map(); // userId -> { count, resetTime }

// Helper function to safely send reply with slow mode handling
async function safeReply(ctx, message, options = {}) {
  try {
    return await ctx.reply(message, options);
  } catch (error) {
    // Check if error is due to slow mode
    if (error.description && (
      error.description.includes('Too Many Requests') ||
      error.description.includes('slow mode') ||
      error.description.includes('retry after') ||
      error.code === 429
    )) {
      console.log(`Slow mode detected for chat ${ctx.chat?.id}, reacting with sad emoji`);
      
      // Try to react with sad emoji instead
      try {
        await ctx.react('😢');
        return null;
      } catch (reactError) {
        console.error('Failed to react due to slow mode:', reactError.message);
        return null;
      }
    }
    
    // Re-throw other errors
    throw error;
  }
}

// Rate limiting function
function isRateLimited(userId) {
  const now = Date.now();
  const userLimit = userRateLimit.get(userId);
  
  if (!userLimit || now > userLimit.resetTime) {
    // Reset or create new limit window
    userRateLimit.set(userId, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return false;
  }
  
  if (userLimit.count >= MAX_REQUESTS_PER_USER) {
    return true; // Rate limited
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

// Enhanced async fetch with better error handling
async function fetchTicsPrice() {
  const now = Date.now();
  
  // Return cached data if fresh
  if (priceCache.data && (now - priceCache.timestamp) < CACHE_DURATION) {
    return priceCache.data;
  }
  
  // If loading, queue the request
  if (priceCache.isLoading) {
    return new Promise((resolve, reject) => {
      pendingRequests.push({ resolve, reject });
      
      // Timeout for queued requests
      setTimeout(() => {
        const index = pendingRequests.findIndex(req => req.resolve === resolve);
        if (index > -1) {
          pendingRequests.splice(index, 1);
          reject(new Error('Request timeout in queue'));
        }
      }, 8000);
    });
  }
  
  priceCache.isLoading = true;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    
    const res = await fetch('https://www.mexc.co/open/api/v2/market/ticker?symbol=TICS_USDT', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TICS-Bot/2.0',
        'Accept': 'application/json'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    
    const json = await res.json();
    if (!json.data?.[0]) throw new Error('Invalid response');
    
    const data = json.data[0];
    const formattedData = {
      price: parseFloat(data.last).toFixed(4),
      change: parseFloat(data.change_rate).toFixed(2),
      volume: parseFloat(data.volume).toLocaleString(),
      timestamp: now
    };
    
    priceCache.data = formattedData;
    priceCache.timestamp = now;
    
    // Resolve all pending
    pendingRequests.forEach(req => req.resolve(formattedData));
    pendingRequests = [];
    
    return formattedData;
    
  } catch (error) {
    // Reject all pending
    pendingRequests.forEach(req => req.reject(error));
    pendingRequests = [];
    throw error;
  } finally {
    priceCache.isLoading = false;
  }
}

// Commands setup
bot.telegram.setMyCommands([
  { command: 'price', description: 'Get current TICS price and stats' },
  { command: 'help', description: 'Show available commands' }
]);

bot.start(async (ctx) => {
  await safeReply(ctx, '🎉 *TICS Bot Ready!*\n\nSend /price for current stats.', 
    { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  const helpMessage = `
🤖 *Commands:*
/price - TICS price & stats
/help - This message

💡 Use menu button (/) for quick access

  `.trim();
  
  await safeReply(ctx, helpMessage, { parse_mode: 'Markdown' });
});

bot.command('price', async (ctx) => {
  const userId = ctx.from.id;
  
  // Check rate limit
  if (isRateLimited(userId)) {
    await safeReply(ctx, '⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  
  // Show typing immediately
  ctx.sendChatAction('typing').catch(() => {});
  
  try {
    const data = await fetchTicsPrice();
    const cacheAge = Math.floor((Date.now() - priceCache.timestamp) / 1000);
    
    const message = `
🚀 *TICS / USDT*

💎 **$${data.price}**
${data.change >= 0 ? '🟢' : '🔴'} **${data.change >= 0 ? '+' : ''}${data.change}%** _24h_
📊 Volume: \`${data.volume} TICS\`

⚡ _Live from MEXC_ ${cacheAge > 0 ? `• ${cacheAge}s ago` : ''}
    `.trim();
    
    // Create inline keyboard with trading buttons
    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🏛️ Trade on MEXC',
            url: 'https://www.mexc.com/exchange/TICS_USDT'
          },
          {
            text: '🏦 Trade on LBank',
            url: 'https://www.lbank.com/trade/tics_usdt'
          }
        ]
      ]
    };
    
    await safeReply(ctx, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
      reply_markup: keyboard
    });
    
  } catch (error) {
    console.error(`Price error for user ${userId}:`, error.message);
    
    let errorMsg = '❌ *Price unavailable*\n\n';
    if (error.message.includes('timeout') || error.message.includes('abort')) {
      errorMsg += '⏱️ Request timed out';
    } else if (error.message.includes('API Error')) {
      errorMsg += '🌐 Exchange API issue';
    } else {
      errorMsg += '🔧 Try again in a moment';
    }
    
    await safeReply(ctx, errorMsg, { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id 
    });
  }
});

// Enhanced error handling
bot.catch(async (err, ctx) => {
  console.error('Bot error:', err.message);
  
  // Don't flood users with error messages
  if (ctx.update.message && !err.message.includes('rate')) {
    try {
      await safeReply(ctx, '⚠️ Temporary issue - please retry');
    } catch (replyError) {
      console.error('Failed to send error message:', replyError.message);
    }
  }
});

// Message processing queue to prevent blocking
const messageQueue = [];
let processingQueue = false;

async function processMessageQueue() {
  if (processingQueue || messageQueue.length === 0) return;
  
  processingQueue = true;
  
  while (messageQueue.length > 0) {
    const { ctx, next } = messageQueue.shift();
    try {
      await next();
    } catch (error) {
      console.error('Queue processing error:', error.message);
    }
  }
  
  processingQueue = false;
}

// Queue middleware for high load
bot.use(async (ctx, next) => {
  // Process non-command messages immediately
  if (!ctx.message?.text?.startsWith('/')) {
    return next();
  }
  
  // Queue command messages during high load
  if (messageQueue.length > 20) {
    messageQueue.push({ ctx, next });
    setImmediate(processMessageQueue);
  } else {
    await next();
  }
});

bot.launch();
console.log('✅ TICS Bot running with rate limiting and slow mode handling');
console.log(`🕒 Cache: ${CACHE_DURATION/1000}s | Rate: ${MAX_REQUESTS_PER_USER}/${RATE_LIMIT_WINDOW/1000}s per user`);

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`🛑 ${signal} received, stopping bot...`);
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
