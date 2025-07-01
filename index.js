import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);

// Cache configuration
const CACHE_DURATION = 5000; // 5 seconds
let priceCache = {
  data: null,
  timestamp: 0,
  isLoading: false
};

// Queue to handle concurrent requests
let pendingRequests = [];

// Function to fetch price data with caching
async function fetchTicsPrice() {
  const now = Date.now();
  
  // Return cached data if still fresh
  if (priceCache.data && (now - priceCache.timestamp) < CACHE_DURATION) {
    return priceCache.data;
  }
  
  // If already loading, wait for the current request
  if (priceCache.isLoading) {
    return new Promise((resolve, reject) => {
      pendingRequests.push({ resolve, reject });
    });
  }
  
  priceCache.isLoading = true;
  
  try {
    console.log('🔄 Fetching fresh TICS data...');
    const res = await fetch('https://www.mexc.co/open/api/v2/market/ticker?symbol=TICS_USDT', {
      timeout: 10000 // 10 second timeout
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const json = await res.json();
    
    if (!json.data || !json.data[0]) {
      throw new Error('Invalid API response format');
    }
    
    const data = json.data[0];
    
    // Validate data
    if (!data.last || !data.change_rate || !data.volume) {
      throw new Error('Missing required price data');
    }
    
    const formattedData = {
      price: parseFloat(data.last).toFixed(4),
      change: parseFloat(data.change_rate).toFixed(2),
      volume: parseFloat(data.volume).toLocaleString(),
      timestamp: now
    };
    
    // Update cache
    priceCache.data = formattedData;
    priceCache.timestamp = now;
    
    // Resolve all pending requests
    pendingRequests.forEach(req => req.resolve(formattedData));
    pendingRequests = [];
    
    return formattedData;
    
  } catch (error) {
    console.error('❌ Error fetching TICS price:', error.message);
    
    // Reject all pending requests
    pendingRequests.forEach(req => req.reject(error));
    pendingRequests = [];
    
    throw error;
  } finally {
    priceCache.isLoading = false;
  }
}

// Set bot commands menu
bot.telegram.setMyCommands([
  { command: 'price', description: 'Get current TICS price and stats' },
  { command: 'help', description: 'Show available commands' }
]);

bot.start((ctx) => {
  const welcomeMessage = `
🎉 *Welcome to TICS Bot!*

Get real-time TICS cryptocurrency data from MEXC exchange.

Send /price to get current stats or /help for all commands.
  `.trim();
  
  ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
});

bot.command('help', (ctx) => {
  const helpMessage = `
🤖 *Available Commands:*

/start - Welcome message
/price - Get TICS price and stats  
/help - Show this help message

💡 *Features:*
• Real-time price data from MEXC
• Smart caching to reduce API load
• Fast response times

💬 *Tip:* Use the menu button (/) to see all commands!
  `.trim();
  
  ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

bot.command('price', async (ctx) => {
  // Send "typing" action to show bot is working
  await ctx.sendChatAction('typing');
  
  try {
    const data = await fetchTicsPrice();
    
    const cacheAge = Math.floor((Date.now() - priceCache.timestamp) / 1000);
    const cacheIndicator = cacheAge < 5 ? '🟢' : '🟡';
    
    const message = `
💰 *TICS / USDT*

💵 Price: \`$${data.price}\`
📊 24h Change: ${data.change >= 0 ? '📈 +' : '📉 '}${data.change}%
📈 24h Volume: \`${data.volume} TICS\`

${cacheIndicator} *Source: MEXC* ${cacheAge > 0 ? `(${cacheAge}s ago)` : '(live)'}
    `.trim();
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    
  } catch (error) {
    console.error('Error in price command:', error.message);
    
    let errorMessage = '❌ *Unable to fetch TICS price*\n\n';
    
    if (error.message.includes('timeout')) {
      errorMessage += '⏱️ Request timed out. Please try again.';
    } else if (error.message.includes('HTTP')) {
      errorMessage += '🌐 MEXC API is temporarily unavailable.';
    } else {
      errorMessage += '🔧 Technical issue occurred. Please try again later.';
    }
    
    await ctx.reply(errorMessage, { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id 
    });
  }
});

// Handle errors gracefully
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  
  // Don't spam user with error messages for every error
  if (ctx.update.message) {
    ctx.reply('⚠️ Something went wrong. Please try again.').catch(() => {});
  }
});

// Performance monitoring
let commandCount = 0;
bot.use((ctx, next) => {
  commandCount++;
  if (commandCount % 100 === 0) {
    console.log(`📊 Processed ${commandCount} commands`);
  }
  return next();
});

bot.launch();
console.log('✅ TICS Bot running with caching enabled...');
console.log(`🕒 Cache duration: ${CACHE_DURATION / 1000} seconds`);

// Enable graceful stop
process.once('SIGINT', () => {
  console.log('🛑 Received SIGINT, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, stopping bot...');
  bot.stop('SIGTERM');
});

// Optional: Clear cache periodically to prevent memory issues
setInterval(() => {
  const now = Date.now();
  if (priceCache.data && (now - priceCache.timestamp) > CACHE_DURATION * 2) {
    priceCache.data = null;
    console.log('🧹 Cleared old cache data');
  }
}, CACHE_DURATION * 2);
