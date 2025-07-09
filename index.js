import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_GROUP_ID = -1002771496854;
const bot = new Telegraf(BOT_TOKEN);

const QUBETICS_RPC = 'https://rpc.qubetics.com';
const CEX_THRESHOLD = 1;
const WHALE_THRESHOLD = 100;
const CEX_ADDRESSES = {
  'lbank': '0xB9885e76B4FeE07791377f4099d6eD4F3E49c4d0',
  'mexc': '0x05d71131B754d09ffc84E8250419539Fb5BFe8eb'
};

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
let whaleWs = null;
let lastProcessedBlock = null;

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

function isAllowedGroup(ctx) {
  return ctx.chat.id === ALLOWED_GROUP_ID;
}

async function handleUnauthorizedUsage(ctx) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔗 Join TicsDev Group', url: 'https://t.me/TicsDev' }
      ]
    ]
  };
  
  await safeReply(ctx, '🚫 *Unauthorized Access*\n\nThis bot only works in the TicsDev group.', {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

async function deleteAndReply(ctx, message, options = {}) {
  try {
    await ctx.deleteMessage();
  } catch (error) {
  }
  
  const userMention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const messageWithMention = `${userMention}\n\n${message}`;
  
  return await safeReply(ctx, messageWithMention, options);
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(2) + 'K';
  }
  return num.toFixed(2);
}

function weiToTics(weiValue) {
  if (!weiValue || weiValue === '0x0' || weiValue === '0') return 0;
  
  try {
    const hexValue = weiValue.toString().startsWith('0x') ? weiValue : '0x' + weiValue;
    const bigIntValue = BigInt(hexValue);
    const divisor = BigInt('1000000000000000000');
    const result = Number(bigIntValue) / Number(divisor);
    return result;
  } catch (error) {
    return 0;
  }
}

async function getCurrentPrice() {
  try {
    const priceData = await getCombinedData().catch(() => 
      exchangeData.mexc.price ? exchangeData.mexc : null
    );
    if (priceData && priceData.price) {
      return parseFloat(priceData.price);
    }
  } catch (error) {
  }
  return 0;
}

async function sendCexAlert(type, cexName, amount, usdValue, txHash) {
  try {
    const emoji = type === 'deposit' ? '📈' : '📉';
    const action = type === 'deposit' ? 'Deposit to' : 'Withdrawal from';
    
    const message = `
🏦 *CEX ALERT*

${emoji} **${action} ${cexName}**
🪙 **Amount:** \`${formatNumber(amount)} TICS\`
💰 **Value:** \`$${usdValue.toFixed(2)} USDT\`
🔗 [View on Explorer](https://ticsscan.com/tx/${txHash})
`.trim();
    
    await bot.telegram.sendMessage(ALLOWED_GROUP_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error('Failed to send CEX alert:', error);
  }
}

async function sendWhaleAlert(fromAddr, toAddr, amount, usdValue, txHash) {
  try {
    const shortFrom = `${fromAddr.slice(0, 6)}...${fromAddr.slice(-4)}`;
    const shortTo = `${toAddr.slice(0, 6)}...${toAddr.slice(-4)}`;
    
    const message = `
🐋 *WHALE ALERT*

💸 **Large Transfer**
📤 **From:** \`${shortFrom}\`
📥 **To:** \`${shortTo}\`
🪙 **Amount:** \`${formatNumber(amount)} TICS\`
💰 **Value:** \`$${usdValue.toFixed(2)} USDT\`
🔗 [View on Explorer](https://ticsscan.com/tx/${txHash})
`.trim();
    
    await bot.telegram.sendMessage(ALLOWED_GROUP_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error('Failed to send whale alert:', error);
  }
}

async function processTransaction(tx) {
  try {
    if (!tx.hash) return;
    
    let detectedTransfers = [];
    
    // Check native TICS transfer
    if (tx.value && tx.value !== '0x0' && tx.value !== '0') {
      const amount = weiToTics(tx.value);
      if (amount >= CEX_THRESHOLD) {
        detectedTransfers.push({
          from: tx.from ? tx.from.toLowerCase() : '',
          to: tx.to ? tx.to.toLowerCase() : '',
          amount: amount,
          type: 'native'
        });
      }
    }
    
    // Check for contract-based transfers
    try {
      const receiptResponse = await fetch(QUBETICS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getTransactionReceipt',
          params: [tx.hash],
          id: 1
        })
      });
      
      const receiptData = await receiptResponse.json();
      if (receiptData.result && receiptData.result.logs) {
        for (const log of receiptData.result.logs) {
          if (log.topics && log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
            if (log.topics.length >= 3 && log.data && log.data !== '0x') {
              try {
                const fromAddr = '0x' + log.topics[1].slice(-40);
                const toAddr = '0x' + log.topics[2].slice(-40);
                const amount = weiToTics(log.data);
                
                if (amount >= CEX_THRESHOLD) {
                  detectedTransfers.push({
                    from: fromAddr.toLowerCase(),
                    to: toAddr.toLowerCase(),
                    amount: amount,
                    type: 'contract'
                  });
                }
              } catch (logError) {
              }
            }
          }
        }
      }
    } catch (receiptError) {
    }
    
    // Process all detected transfers
    const currentPrice = await getCurrentPrice();
    
    for (const transfer of detectedTransfers) {
      const usdValue = transfer.amount * currentPrice;
      
      // Check for CEX alerts
      let transferType = null;
      let cexName = null;
      
      // Check for deposits (TO CEX)
      for (const [name, address] of Object.entries(CEX_ADDRESSES)) {
        if (transfer.to === address.toLowerCase()) {
          transferType = 'deposit';
          cexName = name.toUpperCase();
          await sendCexAlert(transferType, cexName, transfer.amount, usdValue, tx.hash);
          break;
        }
      }
      
      // Check for withdrawals (FROM CEX)
      if (!transferType) {
        for (const [name, address] of Object.entries(CEX_ADDRESSES)) {
          if (transfer.from === address.toLowerCase()) {
            transferType = 'withdrawal';
            cexName = name.toUpperCase();
            await sendCexAlert(transferType, cexName, transfer.amount, usdValue, tx.hash);
            break;
          }
        }
      }
      
      // Check for whale alerts (large transfers regardless of CEX)
      if (transfer.amount >= WHALE_THRESHOLD) {
        await sendWhaleAlert(transfer.from, transfer.to, transfer.amount, usdValue, tx.hash);
      }
    }
    
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
}

async function processBlock(blockNumber) {
  try {
    const response = await fetch(QUBETICS_RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: [blockNumber, true],
        id: 1
      })
    });
    
    const data = await response.json();
    
    if (data.result && data.result.transactions) {
      for (const tx of data.result.transactions) {
        await processTransaction(tx);
      }
    }
  } catch (error) {
    console.error('Error fetching block:', error);
  }
}

function startWhaleMonitoring() {
  try {
    whaleWs = new WebSocket('wss://socket.qubetics.com');
    
    whaleWs.on('open', () => {
      console.log('✅ Whale monitoring WebSocket connected');
      
      const subscribeMsg = {
        jsonrpc: '2.0',
        method: 'eth_subscribe',
        params: ['newHeads'],
        id: 1
      };
      whaleWs.send(JSON.stringify(subscribeMsg));
    });
    
    whaleWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.method === 'eth_subscription' && message.params) {
          const blockHeader = message.params.result;
          if (blockHeader && blockHeader.number) {
            const blockNumber = blockHeader.number;
            
            if (lastProcessedBlock !== blockNumber) {
              lastProcessedBlock = blockNumber;
              await processBlock(blockNumber);
            }
          }
        }
      } catch (error) {
        console.error('Error processing whale monitoring message:', error);
      }
    });
    
    whaleWs.on('close', () => {
      console.log('🔄 Whale monitoring disconnected, reconnecting...');
      setTimeout(startWhaleMonitoring, 5000);
    });
    
    whaleWs.on('error', (error) => {
      console.error('Whale monitoring WebSocket error:', error);
    });
    
  } catch (error) {
    console.error('Failed to start whale monitoring:', error);
    setTimeout(startWhaleMonitoring, 5000);
  }
}

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

function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, limit] of userRateLimit.entries()) {
    if (now > limit.resetTime) {
      userRateLimit.delete(userId);
    }
  }
}, RATE_LIMIT_WINDOW);

bot.telegram.setMyCommands([
  { command: 'price', description: 'Get TICS price from both exchanges' },
  { command: 'check', description: 'Check TICS portfolio (usage: /check wallet_address)' }
]);

bot.start(async (ctx) => {
  if (!isAllowedGroup(ctx)) {
    await handleUnauthorizedUsage(ctx);
    return;
  }
  
  await deleteAndReply(ctx, '🎉 *TICS Price Bot Ready!*\n\n📊 Commands:\n/price - Combined data from MEXC + LBank\n/check - Portfolio tracker (usage: /check wallet_address)', 
    { parse_mode: 'Markdown' });
});

bot.command(['help', `help@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  if (!isAllowedGroup(ctx)) {
    await handleUnauthorizedUsage(ctx);
    return;
  }
  
  const helpMessage = `
🤖 *TICS Price Bot*

📊 /price - Combined price from MEXC + LBank
💼 /check - Portfolio tracker
   Usage: \`/check 0x...\`
  `.trim();
  
  await deleteAndReply(ctx, helpMessage, { parse_mode: 'Markdown' });
});

bot.command(['price', `price@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  if (!isAllowedGroup(ctx)) {
    await handleUnauthorizedUsage(ctx);
    return;
  }
  
  const userId = ctx.from.id;
  
  if (isRateLimited(userId)) {
    await deleteAndReply(ctx, '⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown'
    });
    return;
  }
  
  ctx.sendChatAction('typing').catch(() => {});
  
  try {
    const data = await getCombinedData();
    
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
    
    await deleteAndReply(ctx, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
  } catch (error) {
    await deleteAndReply(ctx, '❌ *Price unavailable*\n\n🔧 Both exchanges temporarily unavailable', { 
      parse_mode: 'Markdown'
    });
  }
});

bot.command(['check', `check@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  if (!isAllowedGroup(ctx)) {
    await handleUnauthorizedUsage(ctx);
    return;
  }
  
  const userId = ctx.from.id;
  
  if (isRateLimited(userId)) {
    await deleteAndReply(ctx, '⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown'
    });
    return;
  }
  
  const input = ctx.message.text.split(' ');
  
  if (input.length < 2) {
    await deleteAndReply(ctx, '❌ *Invalid usage*\n\nPlease provide a wallet address:\n`/check 0x...`', {
      parse_mode: 'Markdown'
    });
    return;
  }
  
  const walletAddress = input[1].trim();
  
  if (!isValidWalletAddress(walletAddress)) {
    await deleteAndReply(ctx, '❌ *Invalid wallet address*\n\nPlease provide a valid Ethereum wallet address (0x...)', {
      parse_mode: 'Markdown'
    });
    return;
  }
  
  ctx.sendChatAction('typing').catch(() => {});
  
  try {
    const [walletData, priceData] = await Promise.all([
      fetchWalletData(walletAddress),
      getCombinedData().catch(() => exchangeData.mexc.price ? exchangeData.mexc : null)
    ]);
    
    if (!priceData || !priceData.price) {
      await deleteAndReply(ctx, '❌ *Price data unavailable*\n\nCannot calculate portfolio value - price feeds are down', {
        parse_mode: 'Markdown'
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
    
    await deleteAndReply(ctx, message, {
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    if (error.message === 'WALLET_NOT_FOUND') {
      await deleteAndReply(ctx, '❌ *Wallet not found*\n\nThis wallet address has no TICS holdings or doesn\'t exist in the system.', {
        parse_mode: 'Markdown'
      });
    } else {
      await deleteAndReply(ctx, '❌ *Portfolio check failed*\n\nUnable to fetch wallet data. Please try again later.', {
        parse_mode: 'Markdown'
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
startWhaleMonitoring();

bot.launch();
console.log('✅ TICS Multi-Exchange Bot running');
console.log('📡 MEXC: Live polling (2s) | LBank: WebSocket');
console.log('💼 Portfolio tracker: /check wallet_address');
console.log('🏦 CEX alerts: 1+ TICS threshold');
console.log('🐋 Whale alerts: 100+ TICS threshold');

setInterval(() => {
  console.log(`📊 MEXC: ${exchangeData.mexc.connected ? '✅' : '❌'} | LBank: ${exchangeData.lbank.connected ? '✅' : '❌'} | Alerts: ${whaleWs && whaleWs.readyState === 1 ? '✅' : '❌'}`);
}, 300000);

const shutdown = (signal) => {
  console.log(`🛑 ${signal} received, stopping bot...`);
  
  if (mexcPollingInterval) clearInterval(mexcPollingInterval);
  if (lbankWs) lbankWs.close();
  if (whaleWs) whaleWs.close();
  
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
