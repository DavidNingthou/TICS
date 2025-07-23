import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALERT_GROUP_ID = -1002771496854; 
const bot = new Telegraf(BOT_TOKEN);

const QUBETICS_RPC = 'https://rpc.qubetics.com';
const CEX_THRESHOLD = 20;
const WHALE_THRESHOLD = 100;
const CEX_ADDRESSES = {
  'lbank': '0xB9885e76B4FeE07791377f4099d6eD4F3E49c4d0',
  'mexc': '0x05d71131B754d09ffc84E8250419539Fb5BFe8eb',
  'coinstore': '0x86790abbaCcD1B21F5ecFDaA67EC6282AFbf3E83' 
};

const RATE_LIMIT_WINDOW = 10000;
const MAX_REQUESTS_PER_USER = 3;
const userRateLimit = new Map();

let exchangeData = {
  mexc: { price: null, volume: null, high: null, low: null, timestamp: 0, connected: false },
  lbank: { price: null, volume: null, high: null, low: null, timestamp: 0, connected: false },
  coinstore: { price: null, volume: null, high: null, low: null, timestamp: 0, connected: false }
};

let coinstoreWs = null;
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
  if (!userId) return false;
  
  const now = Date.now();
  const userLimit = userRateLimit.get(userId);
  
  if (!userLimit || now > userLimit.resetTime) {
    userRateLimit.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return false;
  }
  
  if (userLimit.count >= MAX_REQUESTS_PER_USER) return true;
  
  userLimit.count++;
  return false;
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
  return num.toFixed(2);
}

function weiToTics(weiValue) {
  if (!weiValue || weiValue === '0x0' || weiValue === '0') return 0;
  
  try {
    const hexValue = weiValue.toString().startsWith('0x') ? weiValue : '0x' + weiValue;
    const bigIntValue = BigInt(hexValue);
    const divisor = BigInt('1000000000000000000');
    return Number(bigIntValue) / Number(divisor);
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
    
    await bot.telegram.sendMessage(ALERT_GROUP_ID, message, {
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

💸 **Large Native TICS Transfer**
📤 **From:** \`${shortFrom}\`
📥 **To:** \`${shortTo}\`
🪙 **Amount:** \`${formatNumber(amount)} TICS\`
💰 **Value:** \`$${usdValue.toFixed(2)} USDT\`
🔗 [View on Explorer](https://ticsscan.com/tx/${txHash})
`.trim();
    
    await bot.telegram.sendMessage(ALERT_GROUP_ID, message, {
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
    
    if (tx.value && tx.value !== '0x0' && tx.value !== '0') {
      const amount = weiToTics(tx.value);
      if (amount >= CEX_THRESHOLD) {
        detectedTransfers.push({
          from: tx.from ? tx.from.toLowerCase() : '',
          to: tx.to ? tx.to.toLowerCase() : '',
          amount: amount,
          type: 'native'
        });
        console.log(`🪙 Native TICS transfer detected: ${amount.toFixed(2)} TICS`);
      }
    }
    
    const currentPrice = await getCurrentPrice();
    
    for (const transfer of detectedTransfers) {
      const usdValue = transfer.amount * currentPrice;
      
      let transferType = null;
      let cexName = null;
      
      for (const [name, address] of Object.entries(CEX_ADDRESSES)) {
        if (transfer.to === address.toLowerCase()) {
          transferType = 'deposit';
          cexName = name.toUpperCase();
          await sendCexAlert(transferType, cexName, transfer.amount, usdValue, tx.hash);
          break;
        }
      }
      
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'User-Agent': 'TICS-Bot/3.0' }
    });
    
    if (!response.ok) throw new Error(`MEXC API Error: ${response.status}`);
    
    const data = await response.json();
    if (data.code === 200 && data.data[0]) {
      const ticker = data.data[0];
      exchangeData.mexc = {
        price: parseFloat(ticker.last),
        volume: parseFloat(ticker.volume),
        high: parseFloat(ticker.high),
        low: parseFloat(ticker.low),
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
  console.log('🔄 LBank: Using Puppeteer scraping only');
  exchangeData.lbank.connected = false;
}

async function fetchLBankPuppeteer() {
    console.log('🔄 LBank: Attempting to scrape with Puppeteer...');
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        );

        await page.goto('https://www.lbank.com/trade/tics_usdt', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for dynamic content to load using setTimeout instead of page.waitForTimeout
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Try to wait for price elements to be visible
        try {
            await page.waitForSelector('.sc-uhnfH.dgUEQp', { timeout: 10000 });
            console.log('✅ LBank: Price elements found');
        } catch (e) {
            console.log('⚠️ LBank: Price selector not found, continuing anyway...');
        }

        const marketData = await page.evaluate(() => {
            let price = null;
            let high = null;
            let low = null;
            let volumeTics = null;
            let volumeUsdt = null;

            // Try multiple strategies to find the price
            const priceElements = document.querySelectorAll('.sc-uhnfH.dgUEQp');
            console.log('Found price elements:', priceElements.length);
            
            for (const element of priceElements) {
                const text = element.textContent.trim();
                const parsed = parseFloat(text);
                console.log('Checking price element:', text, 'parsed:', parsed);
                if (!isNaN(parsed) && parsed > 0 && parsed < 100) {
                    price = parsed;
                    console.log('Found valid price:', price);
                    break;
                }
            }

            // If no price found with specific selector, try broader search
            if (!price) {
                const allNumbers = document.body.innerText.match(/\d+\.\d{4,6}/g);
                if (allNumbers) {
                    for (const numStr of allNumbers) {
                        const num = parseFloat(numStr);
                        if (num > 0 && num < 100) {
                            price = num;
                            console.log('Found price via text search:', price);
                            break;
                        }
                    }
                }
            }

            // Look for indicator items
            const indicatorItems = document.querySelectorAll('.sc-cVtpRj.hulTDS.sc-hRflou.hoTIIn.item');
            console.log('Found indicator items:', indicatorItems.length);
            
            for (const item of indicatorItems) {
                const titleElement = item.querySelector('.indicator_title');
                const valueElement = item.querySelector('.indicator_value .sc-uhnfH.dgUEQp');
                
                if (titleElement && valueElement) {
                    const title = titleElement.textContent.trim();
                    const value = valueElement.textContent.trim();
                    const parsed = parseFloat(value.replace(/,/g, ''));
                    
                    console.log('Indicator:', title, 'Value:', value, 'Parsed:', parsed);
                    
                    if (title === '24h High' && !isNaN(parsed)) {
                        high = parsed;
                    } else if (title === '24h Low' && !isNaN(parsed)) {
                        low = parsed;
                    } else if (title.includes('24h Volume') && title.includes('(TICS)') && !isNaN(parsed)) {
                        volumeTics = parsed;
                    } else if (title.includes('24h Volume') && title.includes('(USDT)') && !isNaN(parsed)) {
                        volumeUsdt = parsed;
                    }
                }
            }

            return {
                price,
                high,
                low,
                volumeTics,
                volumeUsdt
            };
        });

        console.log('📊 LBank Puppeteer extracted:', marketData);

        if (marketData.price && marketData.price > 0) {
            console.log(`✅ LBank Puppeteer: Price ${marketData.price.toFixed(4)}, High: ${marketData.high?.toFixed(4) || 'N/A'}, Low: ${marketData.low?.toFixed(4) || 'N/A'}, Vol: ${marketData.volumeTics?.toFixed(0) || 'N/A'} TICS`);
            return {
                price: marketData.price,
                volume: marketData.volumeTics || 0,
                high: marketData.high || marketData.price,
                low: marketData.low || marketData.price,
                timestamp: Date.now()
            };
        } else {
            console.log('❌ LBank Puppeteer: Could not find valid price data');
            
            // Debug: Get page content for analysis
            const pageContent = await page.content();
            const hasIndicators = pageContent.includes('indicator_title');
            const hasPriceClass = pageContent.includes('sc-uhnfH dgUEQp');
            console.log('🔍 LBank Debug: Has indicators:', hasIndicators, 'Has price class:', hasPriceClass);
            
            return null;
        }
    } catch (error) {
        console.error('❌ LBank Puppeteer error:', error.message);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

function connectCoinstoreWebSocket() {
    try {
        coinstoreWs = new WebSocket('wss://ws.coinstore.com/s/v1/ticker');

        coinstoreWs.on('open', () => {
            console.log('✅ CoinStore WebSocket connected');
            exchangeData.coinstore.connected = true;

            const subscribeMsg = {
                "event": "subscribe",
                "channel": ["ticker_TICSUSDT"]
            };
            coinstoreWs.send(JSON.stringify(subscribeMsg));
        });

        coinstoreWs.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.channel === 'ticker_TICSUSDT' && message.data) {
                    const tickerData = message.data;
                    exchangeData.coinstore = {
                        price: parseFloat(tickerData.c),
                        volume: parseFloat(tickerData.v),
                        high: parseFloat(tickerData.h),
                        low: parseFloat(tickerData.l),
                        timestamp: Date.now(),
                        connected: true
                    };
                }
            } catch (error) {
            }
        });

        coinstoreWs.on('close', () => {
            exchangeData.coinstore.connected = false;
            setTimeout(connectCoinstoreWebSocket, 5000);
        });

        coinstoreWs.on('error', (error) => {
            exchangeData.coinstore.connected = false;
        });

    } catch (error) {
        setTimeout(connectCoinstoreWebSocket, 5000);
    }
}

async function fetchCoinstoreREST() {
    console.log('Attempting to fetch Coinstore data with Puppeteer...');
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        );

        await page.goto('https://api.coinstore.com/api/v1/market/tickers', {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        const body = await page.evaluate(() => document.body.innerText);
        const json = JSON.parse(body);

        const tics = json.data.find(item => item.symbol === 'TICSUSDT');

        if (tics) {
            console.log('Successfully fetched TICSUSDT data via Puppeteer.');
            return {
                price: parseFloat(tics.close),
                volume: parseFloat(tics.volume),
                high: parseFloat(tics.high),
                low: parseFloat(tics.low),
                timestamp: Date.now()
            };
        } else {
            console.error('❌ TICSUSDT not found in Puppeteer response.');
            return null;
        }
    } catch (error) {
        console.error('Error during Puppeteer fetch for Coinstore:', error);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function getExchangeData(exchange) {
    const data = exchangeData[exchange];
    const now = Date.now();

    if (data.connected && data.price && data.price > 0 && (now - data.timestamp) < 30000) {
        console.log(`📊 ${exchange}: Using WebSocket data - $${data.price.toFixed(4)}`);
        return data;
    }

    console.log(`🔄 ${exchange}: WebSocket data stale/invalid, trying fallback...`);
    
    if (exchange === 'lbank') {
        const scrapedData = await fetchLBankPuppeteer();
        if (scrapedData && scrapedData.price > 0) {
            console.log(`📈 LBank Scraped: $${scrapedData.price.toFixed(4)}, Vol: ${scrapedData.volume.toFixed(0)}`);
            exchangeData.lbank = { ...scrapedData, connected: false };
            return exchangeData.lbank;
        } else {
            console.log('❌ LBank Scraping: Failed to get valid data');
        }
    } else if (exchange === 'coinstore') {
        const restData = await fetchCoinstoreREST();
        if (restData && restData.price > 0) {
            console.log(`📈 CoinStore REST: $${restData.price.toFixed(4)}, Vol: ${restData.volume.toFixed(0)}`);
            exchangeData.coinstore = { ...restData, connected: false };
            return exchangeData.coinstore;
        } else {
            console.log('❌ CoinStore REST: Failed to get valid data');
        }
    }
    
    return null;
}

async function getCombinedData() {
    const mexcData = (exchangeData.mexc.price && exchangeData.mexc.price > 0) ? exchangeData.mexc : null;
    
    const lbankData = await getExchangeData('lbank');
    const validLbankData = (lbankData && lbankData.price && lbankData.price > 0) ? lbankData : null;
    
    const coinstoreData = await getExchangeData('coinstore');
    const validCoinstoreData = (coinstoreData && coinstoreData.price && coinstoreData.price > 0) ? coinstoreData : null;

    const availableExchanges = [mexcData, validLbankData, validCoinstoreData].filter(d => d && d.price && d.volume >= 0);

    if (availableExchanges.length === 0) {
        throw new Error('No valid data available from any exchange');
    }

    if (availableExchanges.length === 1) {
        let sourceName = '';
        if (mexcData) sourceName = 'MEXC only';
        else if (validLbankData) sourceName = 'LBank only';
        else if (validCoinstoreData) sourceName = 'CoinStore only';
        return { ...availableExchanges[0], source: sourceName };
    }
    
    let totalVolume = 0;
    let weightedPriceSum = 0;
    let highSum = 0;
    let lowSum = 0;
    let latestTimestamp = 0;

    for (const data of availableExchanges) {
        totalVolume += data.volume;
        weightedPriceSum += data.price * data.volume;
        highSum += data.high;
        lowSum += data.low;
        if (data.timestamp > latestTimestamp) {
            latestTimestamp = data.timestamp;
        }
    }

    const weightedPrice = totalVolume > 0 ? weightedPriceSum / totalVolume : availableExchanges[0].price;
    const avgHigh = highSum / availableExchanges.length;
    const avgLow = lowSum / availableExchanges.length;

    return {
        price: weightedPrice.toFixed(4),
        volume: totalVolume,
        high: avgHigh.toFixed(4),
        low: avgLow.toFixed(4),
        mexcPrice: mexcData?.price ? mexcData.price.toFixed(4) : 'N/A',
        lbankPrice: validLbankData?.price ? validLbankData.price.toFixed(4) : 'N/A',
        coinstorePrice: validCoinstoreData?.price ? validCoinstoreData.price.toFixed(4) : 'N/A',
        mexcVolume: mexcData?.volume || 0,
        lbankVolume: validLbankData?.volume || 0,
        coinstoreVolume: validCoinstoreData?.volume || 0,
        timestamp: latestTimestamp,
        source: 'Combined'
    };
}

async function fetchWalletData(walletAddress) {
  try {
    const response = await fetch(`https://presale-api.qubetics.com/v1/projects/qubetics/wallet/${walletAddress}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'TICS-Bot/3.0' }
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
  { command: 'price', description: 'Get TICS price from all exchanges' },
  { command: 'check', description: 'Check TICS portfolio (usage: /check wallet_address)' }
]);

bot.start(async (ctx) => {
  await ctx.reply('🎉 *TICS Price Bot Ready!*\n\n📊 Commands:\n/price - Combined data from MEXC, LBank & CoinStore\n/check - Portfolio tracker (usage: /check wallet_address)', 
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });
});

bot.command(['help', `help@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  const helpMessage = `
🤖 *TICS Price Bot*

📊 /price - Combined price from MEXC, LBank & CoinStore
💼 /check - Portfolio tracker
   Usage: \`/check 0x...\`
  `.trim();
  
  await ctx.reply(helpMessage, { 
    parse_mode: 'Markdown', 
    reply_to_message_id: ctx.message.message_id 
  });
});

bot.command(['price', `price@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  if (!ctx.from || !ctx.from.id) {
    await safeReply(ctx, '❌ Unable to identify user. Please try again.');
    return;
  }
  
  const userId = ctx.from.id;
  
  if (isRateLimited(userId)) {
    await ctx.reply('⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }
  
  ctx.sendChatAction('typing').catch(() => {});
  
  try {
    const data = await getCombinedData();
    
    const message = `
🚀 *TICS / USDT* (${data.source})

💵 **Avg Price:** \`$${data.price}\`
📊 **24h Volume:** \`${formatNumber(data.volume)} TICS\`
🟢 **High:** \`$${data.high}\` | 🔴 **Low:** \`$${data.low}\`

📈 **Exchange Breakdown:**
🔸 MEXC: \`$${data.mexcPrice}\` (${formatNumber(data.mexcVolume)})
🔹 LBank: \`$${data.lbankPrice}\` (${formatNumber(data.lbankVolume)})
💠 CoinStore: \`$${data.coinstorePrice}\` (${formatNumber(data.coinstoreVolume)})
`.trim();
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    
  } catch (error) {
    await ctx.reply('❌ *Price unavailable*\n\n🔧 Exchanges temporarily unavailable', { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
  }
});

bot.command(['check', `check@${BOT_TOKEN.split(':')[0]}`], async (ctx) => {
  ctx.deleteMessage().catch(err => {
    console.error("Could not delete message. Bot might not have permissions.", err);
  });

  if (!ctx.from || !ctx.from.id) {
    await safeReply(ctx, '❌ Unable to identify user. Please try again.');
    return;
  }
  
  const userId = ctx.from.id;
  
  if (isRateLimited(userId)) {
    await ctx.reply('⏱️ *Too many requests*\n\nPlease wait a moment before requesting again.', {
      parse_mode: 'Markdown'
    });
    return;
  }
  
  const input = ctx.message.text.split(' ');
  
  if (input.length < 2) {
    await ctx.reply('❌ *Invalid usage*\n\nPlease provide a wallet address:\n`/check 0x...`', {
      parse_mode: 'Markdown'
    });
    return;
  }
  
  const walletAddress = input[1].trim();
  
  if (!isValidWalletAddress(walletAddress)) {
    await ctx.reply('❌ *Invalid wallet address*\n\nPlease provide a valid Ethereum wallet address (0x...)', {
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
      await ctx.reply('❌ *Price data unavailable*\n\nCannot calculate portfolio value - price feeds are down', {
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
💰 **Portfolio Value:** \`${portfolioValue.toFixed(2)} USDT\`

📊 **Current Price:** \`${currentPrice.toFixed(4)}\`
${priceData.source ? `📈 **Source:** ${priceData.source}` : ''}

🎯 **Receiving Address:** \`${shortReceivingAddress}\`
`.trim();
    
    await ctx.reply(message, {
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    if (error.message === 'WALLET_NOT_FOUND') {
      await ctx.reply('❌ *Wallet not found*\n\nThis wallet address has no TICS holdings or doesn\'t exist in the system.', {
        parse_mode: 'Markdown'
      });
    } else {
      await ctx.reply('❌ *Portfolio check failed*\n\nUnable to fetch wallet data. Please try again later.', {
        parse_mode: 'Markdown'
      });
    }
  }
});

bot.catch(async (err, ctx) => {
  console.error('Bot error caught:', {
    error: err.message,
    userId: ctx?.from?.id,
    username: ctx?.from?.username,
    chatId: ctx?.chat?.id
  });
  
  if (ctx.update.message && !err.message.includes('rate')) {
    try {
      await safeReply(ctx, '⚠️ Temporary issue - please retry');
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
});

startMexcPolling();
connectLBankWebSocket();
connectCoinstoreWebSocket();
startWhaleMonitoring();

bot.launch();
console.log('✅ TICS Multi-Exchange Bot running');
console.log('📡 MEXC: Live polling (2s) | LBank: Puppeteer scraping | CoinStore: WebSocket/Puppeteer');
console.log('💼 Portfolio tracker: /check wallet_address');
console.log('🏦 CEX alerts: 20+ TICS threshold');
console.log('🐋 Whale alerts: 100+ TICS threshold');

setInterval(() => {
  console.log(`📊 MEXC: ${exchangeData.mexc.connected ? '✅' : '❌'} | LBank: Puppeteer | CoinStore: ${exchangeData.coinstore.connected ? '✅' : '❌'} | Alerts: ${whaleWs && whaleWs.readyState === 1 ? '✅' : '❌'}`);
}, 300000);

const shutdown = (signal) => {
  console.log(`🛑 ${signal} received, stopping bot...`);
  
  if (mexcPollingInterval) clearInterval(mexcPollingInterval);
  if (coinstoreWs) coinstoreWs.close();
  if (whaleWs) whaleWs.close();
  
  bot.stop(signal);
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
